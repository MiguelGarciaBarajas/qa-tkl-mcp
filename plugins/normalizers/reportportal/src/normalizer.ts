import { assertRawEvidenceRecord } from "@tkl/contracts";
import type {
  CanonicalEntity,
  Claim,
  Normalizer,
  NormalizationResult,
  RawEvidenceRecord,
  TraceLink,
} from "@tkl/contracts";

interface ReportPortalExternalIssue {
  ticketId?: unknown;
  url?: unknown;
  btsUrl?: unknown;
  btsProjectId?: unknown;
}

interface ReportPortalIssue {
  issueType?: unknown;
  externalSystemIssues?: unknown;
}

interface ReportPortalLaunchPayload {
  id: string | number;
  name: string;
  status?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  lastModified?: unknown;
}

interface ReportPortalTestItemPayload {
  id: string | number;
  name: string;
  launchId: string | number;
  status?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  duration?: unknown;
  codeRef?: unknown;
  uniqueId?: unknown;
  retry?: unknown;
  retriesCount?: unknown;
  attributes?: unknown;
  logs?: unknown;
  issue?: ReportPortalIssue;
}

const NORMALIZER_ID = "reportportal-normalizer";
const NORMALIZER_VERSION = "0.2.0";

/** ReportPortal launch/item IDs are provider-stable non-negative integers. */
function positiveIntegerId(value: unknown): string | undefined {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : undefined;
}

/** External issue identities (e.g. Jira keys) are free-form, non-numeric strings. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLaunch(payload: unknown): ReportPortalLaunchPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return positiveIntegerId(candidate.id) && typeof candidate.name === "string" && candidate.name.trim().length > 0
    ? (candidate as unknown as ReportPortalLaunchPayload)
    : undefined;
}

function readTestItem(payload: unknown): ReportPortalTestItemPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  return (
    positiveIntegerId(candidate.id) !== undefined
    && typeof candidate.name === "string"
    && candidate.name.trim().length > 0
    && positiveIntegerId(candidate.launchId) !== undefined
  )
    ? (candidate as unknown as ReportPortalTestItemPayload)
    : undefined;
}

function sourceMatchesPayloadId(record: RawEvidenceRecord, payloadId: unknown): boolean {
  const sourceId = positiveIntegerId(record.sourceId);
  return sourceId !== undefined && sourceId === positiveIntegerId(payloadId);
}

function epochMillisToIso(value: unknown): string | undefined {
  const numeric = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : undefined);
  if (numeric === undefined || !Number.isFinite(numeric)) return undefined;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationMillis(payload: { startTime?: unknown; endTime?: unknown; duration?: unknown }): number | undefined {
  if (typeof payload.duration === "number" && Number.isFinite(payload.duration)) return payload.duration;
  const start = typeof payload.startTime === "number" ? payload.startTime : undefined;
  const end = typeof payload.endTime === "number" ? payload.endTime : undefined;
  if (start === undefined || end === undefined) return undefined;
  const value = end - start;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Reads the explicit external issue/defect classification a test item
 * payload carries, if any. Nothing here is ever inferred from a `FAILED`
 * (or any other) status: an entry is only produced when the payload itself
 * supplies an external system issue with a non-empty `ticketId`.
 */
function externalIssues(issue: ReportPortalIssue | undefined): Array<{ ticketId: string; url?: string; btsProjectId?: string }> {
  const raw = issue?.externalSystemIssues;
  if (!Array.isArray(raw)) return [];
  const results: Array<{ ticketId: string; url?: string; btsProjectId?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as ReportPortalExternalIssue;
    const ticketId = nonEmptyString(candidate.ticketId);
    if (!ticketId) continue;
    results.push({
      ticketId,
      url: typeof candidate.url === "string" ? candidate.url : (typeof candidate.btsUrl === "string" ? candidate.btsUrl : undefined),
      btsProjectId: typeof candidate.btsProjectId === "string" ? candidate.btsProjectId : undefined,
    });
  }

  return results;
}

function itemAttributes(value: unknown): Array<{ key?: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as { key?: unknown; value?: unknown };
    const attributeValue = nonEmptyString(candidate.value);
    if (!attributeValue) return [];
    const key = nonEmptyString(candidate.key);
    return [{ ...(key ? { key } : {}), value: attributeValue }];
  });
}

function testRailCaseIds(attributes: Array<{ key?: string; value: string }>): string[] {
  return [...new Set(attributes.flatMap((attribute) => {
    if (attribute.key?.toLowerCase() !== "testrailcaseid") return [];
    const value = attribute.value.trim().replace(/^C/i, "");
    return positiveIntegerId(value) ? [positiveIntegerId(value)!] : [];
  }))];
}

function itemLogs(value: unknown): Array<{ message: string; level?: string; logTime?: string | number }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    const message = nonEmptyString(candidate.message);
    if (!message) return [];
    return [{
      message,
      ...(typeof candidate.level === "string" ? { level: candidate.level } : {}),
      ...(typeof candidate.logTime === "string" || typeof candidate.logTime === "number"
        ? { logTime: candidate.logTime }
        : {}),
    }];
  });
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

function statusClaim(entityId: string, id: string, status: unknown, sourceProvenance: ReturnType<typeof provenance>): Claim | undefined {
  if (typeof status !== "string" || status.trim().length === 0) return undefined;
  return {
    id: `claim:reportportal:${id}:status`,
    entityId,
    attribute: "status",
    value: status,
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: sourceProvenance,
  };
}

function timestampClaims(
  entityId: string,
  id: string,
  payload: { startTime?: unknown; endTime?: unknown; duration?: unknown },
  sourceProvenance: ReturnType<typeof provenance>,
): Claim[] {
  const claims: Claim[] = [];
  const startedAt = epochMillisToIso(payload.startTime);
  const endedAt = epochMillisToIso(payload.endTime);
  if (startedAt) {
    claims.push({
      id: `claim:reportportal:${id}:startedAt`,
      entityId,
      attribute: "startedAt",
      value: startedAt,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
  }
  if (endedAt) {
    claims.push({
      id: `claim:reportportal:${id}:endedAt`,
      entityId,
      attribute: "endedAt",
      value: endedAt,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
  }
  const duration = durationMillis(payload);
  if (duration !== undefined) {
    claims.push({
      id: `claim:reportportal:${id}:duration`,
      entityId,
      attribute: "duration",
      value: duration,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
  }
  return claims;
}

/**
 * Maps explicit ReportPortal evidence to canonical `test-execution`
 * entities. Launches and test items are normalized independently; a
 * `contains` trace link from the launch's entity to a test item's entity
 * is created only when the test item payload provides an explicit
 * `launchId` (always required for a valid test item record here).
 *
 * A canonical `defect` entity and a `relates_to` trace link from the test
 * item to it are created only when the payload includes an explicit
 * external issue identity (a non-empty `ticketId` under
 * `issue.externalSystemIssues`). A `FAILED` status, or any other explicit
 * defect classification (`issue.issueType`) alone, never creates a defect
 * entity by itself -- that would be an inference this normalizer must not
 * make.
 */
export function normalizeReportPortalRecord(
  record: RawEvidenceRecord,
): NormalizationResult | null {
  if (record.source !== "reportportal") return null;
  assertRawEvidenceRecord(record);
  const sourceProvenance = provenance(record);

  if (record.contentType === "reportportal.launch") {
    const launch = readLaunch(record.payload);
    if (!launch || !sourceMatchesPayloadId(record, launch.id)) return null;
    const id = positiveIntegerId(launch.id)!;
    const entityId = `test-execution:reportportal:launch:${id}`;
    const entity: CanonicalEntity = {
      id: entityId,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "test-execution",
      title: launch.name.trim(),
      provenance: sourceProvenance,
    };
    const claims: Claim[] = [{
      id: `claim:reportportal:${id}:name`,
      entityId,
      attribute: "name",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    }];
    const status = statusClaim(entityId, id, launch.status, sourceProvenance);
    if (status) claims.push(status);
    claims.push(...timestampClaims(entityId, id, launch, sourceProvenance));
    return { entities: [entity], claims, traceLinks: [] };
  }

  if (record.contentType === "reportportal.test_item") {
    const item = readTestItem(record.payload);
    if (!item || !sourceMatchesPayloadId(record, item.id)) return null;
    const id = positiveIntegerId(item.id)!;
    const launchIdValue = positiveIntegerId(item.launchId)!;
    const entityId = `test-execution:reportportal:item:${id}`;
    const entity: CanonicalEntity = {
      id: entityId,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "test-execution",
      title: item.name.trim(),
      provenance: sourceProvenance,
    };

    const claims: Claim[] = [{
      id: `claim:reportportal:${id}:name`,
      entityId,
      attribute: "name",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    }];
    const status = statusClaim(entityId, id, item.status, sourceProvenance);
    if (status) claims.push(status);
    claims.push(...timestampClaims(entityId, id, item, sourceProvenance));
    claims.push({
      id: `claim:reportportal:${id}:launchId`,
      entityId,
      attribute: "launchId",
      value: launchIdValue,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
    if (typeof item.codeRef === "string" && item.codeRef.trim().length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:codeRef`,
        entityId,
        attribute: "codeRef",
        value: item.codeRef.trim(),
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    if (typeof item.uniqueId === "string" && item.uniqueId.trim().length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:uniqueId`,
        entityId,
        attribute: "uniqueId",
        value: item.uniqueId.trim(),
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    if (typeof item.retry === "boolean") {
      claims.push({
        id: `claim:reportportal:${id}:retry`,
        entityId,
        attribute: "retry",
        value: item.retry,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    } else if (typeof item.retriesCount === "number" && Number.isFinite(item.retriesCount)) {
      claims.push({
        id: `claim:reportportal:${id}:retry`,
        entityId,
        attribute: "retry",
        value: item.retriesCount,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    const attributes = itemAttributes(item.attributes);
    const linkedTestRailCaseIds = testRailCaseIds(attributes);
    if (attributes.length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:attributes`,
        entityId,
        attribute: "attributes",
        value: attributes,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    if (linkedTestRailCaseIds.length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:testrailCaseIds`,
        entityId,
        attribute: "testrailCaseIds",
        value: linkedTestRailCaseIds,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    const logs = itemLogs(item.logs);
    if (logs.length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:logs`,
        entityId,
        attribute: "logs",
        value: logs,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    const issueType = item.issue?.issueType;
    if (typeof issueType === "string" && issueType.trim().length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:issueType`,
        entityId,
        attribute: "issueType",
        value: issueType,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }
    const issues = externalIssues(item.issue);
    if (issues.length > 0) {
      claims.push({
        id: `claim:reportportal:${id}:externalIssues`,
        entityId,
        attribute: "externalIssues",
        value: issues.map((issue) => issue.ticketId),
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
    }

    const traceLinks: TraceLink[] = [{
      id: `link:reportportal:launch:${launchIdValue}:item:${id}`,
      fromEntityId: `test-execution:reportportal:launch:${launchIdValue}`,
      toEntityId: entityId,
      type: "contains",
      origin: "explicit",
      confidence: 1,
      provenance: sourceProvenance,
    }];

    const entities: CanonicalEntity[] = [entity];
    for (const caseId of linkedTestRailCaseIds) {
      traceLinks.push({
        id: `link:reportportal:item:${id}:testrail-case:${caseId}`,
        fromEntityId: entityId,
        toEntityId: `manual-test:testrail:${caseId}`,
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }
    // A canonical defect entity/link is created only when the payload
    // itself carries an explicit external issue identity -- never merely
    // from a FAILED status or an issueType classification alone.
    for (const issue of issues) {
      const defectId = `defect:reportportal:${issue.btsProjectId ?? "external"}:${issue.ticketId}`;
      entities.push({
        id: defectId,
        tenantId: record.tenantId,
        productId: record.productId,
        type: "defect",
        title: issue.ticketId,
        provenance: sourceProvenance,
      });
      claims.push({
        id: `claim:reportportal:defect:${issue.ticketId}:ticketId`,
        entityId: defectId,
        attribute: "ticketId",
        value: issue.ticketId,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: sourceProvenance,
      });
      if (issue.url) {
        claims.push({
          id: `claim:reportportal:defect:${issue.ticketId}:url`,
          entityId: defectId,
          attribute: "url",
          value: issue.url,
          origin: "explicit",
          confidence: 1,
          status: "pending",
          provenance: sourceProvenance,
        });
      }
      traceLinks.push({
        id: `link:reportportal:item:${id}:defect:${issue.ticketId}`,
        fromEntityId: entityId,
        toEntityId: defectId,
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      });
    }

    return { entities, claims, traceLinks };
  }

  return null;
}

export class ReportPortalNormalizer implements Normalizer {
  supports(record: RawEvidenceRecord): boolean {
    if (record.source !== "reportportal") return false;
    if (record.contentType === "reportportal.launch") {
      const launch = readLaunch(record.payload);
      return launch !== undefined && sourceMatchesPayloadId(record, launch.id);
    }
    if (record.contentType === "reportportal.test_item") {
      const item = readTestItem(record.payload);
      return item !== undefined && sourceMatchesPayloadId(record, item.id);
    }
    return false;
  }

  async normalize(record: RawEvidenceRecord): Promise<NormalizationResult> {
    const result = normalizeReportPortalRecord(record);
    if (!result) {
      throw new Error(
        `ReportPortalNormalizer cannot normalize record ${record.sourceId}: unsupported content type or payload shape`,
      );
    }
    return result;
  }
}
