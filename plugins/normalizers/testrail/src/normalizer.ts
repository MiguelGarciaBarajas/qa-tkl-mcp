import { assertRawEvidenceRecord } from "@tkl/contracts";
import type {
  CanonicalEntity,
  Claim,
  Normalizer,
  NormalizationResult,
  RawEvidenceRecord,
  TraceLink,
} from "@tkl/contracts";

interface TestRailSuitePayload {
  id: number | string;
  name: string;
}

interface TestRailCasePayload {
  id: number | string;
  suite_id?: number | string;
  section_id?: number | string;
  title: string;
  type_id?: number | string;
  priority_id?: number | string;
  custom_automation_status?: number | string;
  custom_preconds?: unknown;
  custom_steps_separated?: unknown;
  custom_expected?: unknown;
  [key: string]: unknown;
}

interface TestRailRunPayload {
  id: number | string;
  name: string;
  suite_id?: number | string;
}

interface TestRailResultPayload {
  id: number | string;
  status_id: number | string;
  run_id?: number | string;
  case_id?: number | string;
  created_on?: number | string;
}

const NORMALIZER_ID = "testrail-normalizer";
const NORMALIZER_VERSION = "0.2.0";
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_AUTOMATION_ID_PATTERN = /^test:github:\d+$/;

export interface TestRailReferenceMapping {
  jiraReferenceField?: string;
  githubAutomationReferenceField?: string;
}

function positiveIntegerId(value: unknown): string | undefined {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : undefined;
}

function readSuite(payload: unknown): TestRailSuitePayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return positiveIntegerId(candidate.id) && typeof candidate.name === "string" && candidate.name.trim()
    ? candidate as TestRailSuitePayload
    : undefined;
}

function readCase(payload: unknown): TestRailCasePayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return (
    positiveIntegerId(candidate.id) &&
    typeof candidate.title === "string" &&
    candidate.title.trim()
  )
    ? candidate as TestRailCasePayload
    : undefined;
}

function readRun(payload: unknown): TestRailRunPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return positiveIntegerId(candidate.id) && typeof candidate.name === "string" && candidate.name.trim()
    ? candidate as TestRailRunPayload
    : undefined;
}

function readResult(payload: unknown): TestRailResultPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return positiveIntegerId(candidate.id) && positiveIntegerId(candidate.status_id)
    ? candidate as TestRailResultPayload
    : undefined;
}

/**
 * TestRail status meanings are awaiting FL Titling QA/product approval. Preserve the
 * raw ID but never claim it means passed, failed, or any other business outcome here.
 */
function normalizedStatus(statusId: string): "unknown" {
  void statusId;
  return "unknown";
}

function unixTimestamp(value: unknown): string | undefined {
  const seconds = positiveIntegerId(value);
  if (!seconds) return undefined;
  const milliseconds = Number(seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function provenance(record: RawEvidenceRecord) {
  return {
    source: record.source,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    contentHash: record.contentHash,
    observedAt: record.observedAt,
    normalizerId: NORMALIZER_ID,
    normalizerVersion: NORMALIZER_VERSION,
  };
}

function sourceMatchesPayloadId(record: RawEvidenceRecord, payloadId: unknown): boolean {
  const sourceId = positiveIntegerId(record.sourceId);
  const normalizedPayloadId = positiveIntegerId(payloadId);
  return sourceId !== undefined && sourceId === normalizedPayloadId;
}

function explicitReferences(
  payload: TestRailCasePayload,
  fieldName: string | undefined,
  pattern: RegExp,
  label: string,
): string[] {
  if (!fieldName || payload[fieldName] === undefined) return [];
  const rawValue = payload[fieldName];
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  const references: string[] = [];

  for (const value of values) {
    if (typeof value !== "string" || !pattern.test(value.trim())) {
      throw new TypeError(`${label} field "${fieldName}" contains an invalid reference`);
    }
    const reference = value.trim();
    if (!references.includes(reference)) references.push(reference);
  }
  return references;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function separatedSteps(value: unknown): Array<{ content: string; expected: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const step = item as Record<string, unknown>;
    if (
      (step.content != null && typeof step.content !== "string")
      || (step.expected != null && typeof step.expected !== "string")
    ) {
      return undefined;
    }
    steps.push({
      content: optionalText(step.content) ?? "",
      expected: optionalText(step.expected) ?? "",
    });
  }
  return steps;
}

/**
 * Maps explicit TestRail evidence to canonical entities. Suite/case support belongs to
 * KNW-101; run/result execution support belongs to KNW-102.
 */
export function normalizeTestRailRecord(
  record: RawEvidenceRecord,
  referenceMapping: TestRailReferenceMapping = {},
): NormalizationResult | null {
  if (record.source !== "testrail") return null;
  assertRawEvidenceRecord(record);
  const sourceProvenance = provenance(record);

  if (record.contentType === "testrail.suite") {
    const suite = readSuite(record.payload);
    if (!suite || !sourceMatchesPayloadId(record, suite.id)) return null;
    const suiteId = positiveIntegerId(suite.id)!;
    const entity: CanonicalEntity = {
      id: `test-suite:testrail:${suiteId}`,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "test-suite",
      title: suite.name.trim(),
      provenance: sourceProvenance,
    };
    const claims: Claim[] = [{
      id: `claim:testrail:suite:${suiteId}:name`,
      entityId: entity.id,
      attribute: "name",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    }];
    return { entities: [entity], claims, traceLinks: [] };
  }

  if (record.contentType === "testrail.case") {
    const testCase = readCase(record.payload);
    if (!testCase || !sourceMatchesPayloadId(record, testCase.id)) return null;
    const caseId = positiveIntegerId(testCase.id)!;
    const suiteId = positiveIntegerId(testCase.suite_id);
    const jiraReferences = explicitReferences(
      testCase,
      referenceMapping.jiraReferenceField,
      JIRA_KEY_PATTERN,
      "Jira reference",
    );
    const githubAutomationReferences = explicitReferences(
      testCase,
      referenceMapping.githubAutomationReferenceField,
      GITHUB_AUTOMATION_ID_PATTERN,
      "GitHub automation reference",
    );
    const entity: CanonicalEntity = {
      id: `manual-test:testrail:${caseId}`,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "manual-test",
      title: testCase.title.trim(),
      provenance: sourceProvenance,
    };
    const claims: Claim[] = [{
      id: `claim:testrail:case:${caseId}:title`,
      entityId: entity.id,
      attribute: "title",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    }];

    for (
      const attribute of [
        "section_id",
        "type_id",
        "priority_id",
        "custom_automation_status",
      ] as const
    ) {
      const value = positiveIntegerId(testCase[attribute]);
      if (value) {
        claims.push({
          id: `claim:testrail:case:${caseId}:${attribute}`,
          entityId: entity.id,
          attribute,
          value,
          origin: "explicit",
          confidence: 1,
          status: "pending",
          provenance: sourceProvenance,
        });
      }
    }

    const customPreconditions = optionalText(testCase.custom_preconds);
    if (customPreconditions !== undefined) {
      claims.push({
        id: `claim:testrail:case:${caseId}:custom_preconds`,
        entityId: entity.id,
        attribute: "custom_preconds",
        value: customPreconditions,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    const customStepsSeparated = separatedSteps(testCase.custom_steps_separated);
    if (customStepsSeparated !== undefined) {
      claims.push({
        id: `claim:testrail:case:${caseId}:custom_steps_separated`,
        entityId: entity.id,
        attribute: "custom_steps_separated",
        value: customStepsSeparated,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    const customSteps = optionalText(testCase.custom_steps);
    if (customSteps !== undefined) {
      claims.push({
        id: `claim:testrail:case:${caseId}:custom_steps`,
        entityId: entity.id,
        attribute: "custom_steps",
        value: customSteps,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    const customExpected = optionalText(testCase.custom_expected);
    if (customExpected !== undefined) {
      claims.push({
        id: `claim:testrail:case:${caseId}:custom_expected`,
        entityId: entity.id,
        attribute: "custom_expected",
        value: customExpected,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    if (referenceMapping.jiraReferenceField && testCase[referenceMapping.jiraReferenceField] !== undefined) {
      claims.push({
        id: `claim:testrail:case:${caseId}:custom_jira_references`,
        entityId: entity.id,
        attribute: "custom_jira_references",
        value: jiraReferences,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    const traceLinks: TraceLink[] = [];
    if (suiteId) {
      traceLinks.push({
          id: `link:testrail:suite:${suiteId}:case:${caseId}`,
          fromEntityId: `test-suite:testrail:${suiteId}`,
          toEntityId: entity.id,
          type: "contains",
          origin: "explicit",
          confidence: 1,
          provenance: sourceProvenance,
      });
    }
    for (const jiraKey of jiraReferences) {
      traceLinks.push({
        id: `link:testrail:case:${caseId}:requirement:${jiraKey}`,
        fromEntityId: entity.id,
        toEntityId: `requirement:${jiraKey}`,
        type: "verifies",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }
    for (const automationId of githubAutomationReferences) {
      traceLinks.push({
        id: `link:testrail:case:${caseId}:automation:${automationId}`,
        fromEntityId: entity.id,
        toEntityId: automationId,
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }
    return { entities: [entity], claims, traceLinks };
  }

  if (record.contentType === "testrail.run") {
    const run = readRun(record.payload);
    if (!run || !sourceMatchesPayloadId(record, run.id)) return null;
    const runId = positiveIntegerId(run.id)!;
    const suiteId = positiveIntegerId(run.suite_id);
    const entity: CanonicalEntity = {
      id: `test-execution:testrail:run:${runId}`,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "test-execution",
      title: run.name.trim(),
      provenance: sourceProvenance,
    };
    const claims: Claim[] = [{
      id: `claim:testrail:run:${runId}:name`,
      entityId: entity.id,
      attribute: "name",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    }];
    const traceLinks: TraceLink[] = suiteId
      ? [{
          id: `link:testrail:suite:${suiteId}:run:${runId}`,
          fromEntityId: `test-suite:testrail:${suiteId}`,
          toEntityId: entity.id,
          type: "contains",
          origin: "explicit",
          confidence: 1,
          provenance: sourceProvenance,
        }]
      : [];
    return { entities: [entity], claims, traceLinks };
  }

  if (record.contentType === "testrail.result") {
    const result = readResult(record.payload);
    if (!result || !sourceMatchesPayloadId(record, result.id)) return null;
    const resultId = positiveIntegerId(result.id)!;
    const runId = positiveIntegerId(result.run_id);
    const caseId = positiveIntegerId(result.case_id);
    const entity: CanonicalEntity = {
      id: `test-execution:testrail:result:${resultId}`,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "test-execution",
      title: `TestRail result ${resultId}`,
      provenance: sourceProvenance,
    };
    const statusId = positiveIntegerId(result.status_id)!;
    const executedAt = unixTimestamp(result.created_on);
    const claims: Claim[] = [
      {
        id: `claim:testrail:result:${resultId}:status_id`,
        entityId: entity.id,
        attribute: "status_id",
        value: statusId,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      },
      {
        id: `claim:testrail:result:${resultId}:status`,
        entityId: entity.id,
        attribute: "status",
        value: normalizedStatus(statusId),
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      },
    ];
    if (executedAt) {
      claims.push({
        id: `claim:testrail:result:${resultId}:executedAt`,
        entityId: entity.id,
        attribute: "executedAt",
        value: executedAt,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    const traceLinks: TraceLink[] = [];
    if (runId) {
      traceLinks.push({
        id: `link:testrail:run:${runId}:result:${resultId}`,
        fromEntityId: `test-execution:testrail:run:${runId}`,
        toEntityId: entity.id,
        type: "contains",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }
    if (caseId) {
      traceLinks.push({
        id: `link:testrail:result:${resultId}:case:${caseId}`,
        fromEntityId: `manual-test:testrail:${caseId}`,
        toEntityId: entity.id,
        type: "executed_by",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }
    return { entities: [entity], claims, traceLinks };
  }

  return null;
}

export class TestRailNormalizer implements Normalizer {
  private readonly referenceMapping: TestRailReferenceMapping;

  constructor(referenceMapping: TestRailReferenceMapping = {}) {
    this.referenceMapping = referenceMapping;
  }

  supports(record: RawEvidenceRecord): boolean {
    if (record.source !== "testrail") return false;
    if (record.contentType === "testrail.suite") {
      const suite = readSuite(record.payload);
      return suite !== undefined && sourceMatchesPayloadId(record, suite.id);
    }
    if (record.contentType === "testrail.case") {
      const testCase = readCase(record.payload);
      return testCase !== undefined && sourceMatchesPayloadId(record, testCase.id);
    }
    if (record.contentType === "testrail.run") {
      const run = readRun(record.payload);
      return run !== undefined && sourceMatchesPayloadId(record, run.id);
    }
    if (record.contentType === "testrail.result") {
      const result = readResult(record.payload);
      return result !== undefined && sourceMatchesPayloadId(record, result.id);
    }
    return false;
  }

  async normalize(record: RawEvidenceRecord): Promise<NormalizationResult> {
    const result = normalizeTestRailRecord(record, this.referenceMapping);
    if (!result) {
      throw new Error(
        `TestRailNormalizer cannot normalize record ${record.sourceId}: unsupported content type or payload shape`,
      );
    }
    return result;
  }
}
