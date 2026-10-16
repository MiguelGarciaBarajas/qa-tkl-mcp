import type {
  CanonicalEntity,
  Claim,
  Normalizer,
  NormalizationResult,
  RawEvidenceRecord,
  TraceLink,
} from "@tkl/contracts";
import { assertRawEvidenceRecord } from "@tkl/contracts";

interface NestedJiraIssuePayload {
  key: string;
  parentKey?: string;
  epicKey?: string;
  fields: {
    issuetype?: { name?: string };
    summary: string;
    description?: string;
    acceptanceCriteria?: string[];
    status?: { name?: string };
    parent?: { key?: string };
    customfield_10006?: unknown;
    customfield_10008?: unknown;
  };
}

interface ConnectorJiraIssuePayload {
  key?: string;
  summary: string;
  description?: string | null;
  acceptanceCriteria?: string[];
  issueType?: string;
  status?: string;
  parentKey?: string;
  epicKey?: string;
}

interface JiraIssueData {
  key: string;
  summary: string;
  description?: string;
  acceptanceCriteria: string[];
  issueType?: string;
  status?: string;
  parentKey?: string;
  epicKey?: string;
}

const NORMALIZER_ID = "jira-normalizer";
const NORMALIZER_VERSION = "0.2.0";

function jiraKey(value: unknown): string | undefined {
  if (typeof value === "string" && /^[A-Z][A-Z0-9_]*-\d+$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const key = (value as { key?: unknown }).key;
    return typeof key === "string" && /^[A-Z][A-Z0-9_]*-\d+$/.test(key.trim())
      ? key.trim()
      : undefined;
  }
  return undefined;
}

function readJiraIssue(record: RawEvidenceRecord): JiraIssueData | undefined {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.fields === "object" && candidate.fields !== null) {
    const nested = payload as NestedJiraIssuePayload;
    if (typeof nested.key !== "string" || typeof nested.fields.summary !== "string") {
      return undefined;
    }
    return {
      key: nested.key,
      summary: nested.fields.summary,
      description: nested.fields.description,
      acceptanceCriteria: nested.fields.acceptanceCriteria ?? [],
      issueType: nested.fields.issuetype?.name,
      status: nested.fields.status?.name,
      parentKey: jiraKey(nested.parentKey) ?? jiraKey(nested.fields.parent),
      epicKey:
        jiraKey(nested.epicKey)
        ?? jiraKey(nested.fields.customfield_10008)
        ?? jiraKey(nested.fields.customfield_10006),
    };
  }
  if (record.contentType === "jira.issue" && typeof candidate.summary === "string") {
    const connectorPayload = payload as ConnectorJiraIssuePayload;
    return {
      key: connectorPayload.key ?? record.sourceId,
      summary: connectorPayload.summary,
      description: connectorPayload.description ?? undefined,
      acceptanceCriteria: connectorPayload.acceptanceCriteria ?? [],
      issueType: connectorPayload.issueType,
      status: connectorPayload.status,
      parentKey: jiraKey(connectorPayload.parentKey),
      epicKey: jiraKey(connectorPayload.epicKey),
    };
  }
  return undefined;
}

/**
 * Normalizes Jira RawEvidenceRecords (stories) into a canonical `requirement` entity,
 * one claim per acceptance criterion, and a description claim.
 *
 * Owner: Josue Misael Torres (Knowledge and Traceability). Depends only on
 * `@tkl/contracts` types - never calls the Jira API directly (that is Jorge
 * Santiago's connector responsibility).
 */
export class JiraNormalizer implements Normalizer {
  supports(record: RawEvidenceRecord): boolean {
    return record.source === "jira" && readJiraIssue(record) !== undefined;
  }

  async normalize(record: RawEvidenceRecord): Promise<NormalizationResult> {
    const result = normalizeJiraRecord(record);
    if (!result) {
      throw new Error(
        `JiraNormalizer cannot normalize record ${record.sourceId}: unsupported payload shape`,
      );
    }
    return result;
  }
}

export function normalizeJiraRecord(
  record: RawEvidenceRecord,
): NormalizationResult | null {
  if (record.source !== "jira") return null;
  assertRawEvidenceRecord(record);
  const issue = readJiraIssue(record);
  if (!issue) return null;

  const provenance = {
    source: record.source,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    contentHash: record.contentHash,
    observedAt: record.observedAt,
    normalizerId: NORMALIZER_ID,
    normalizerVersion: NORMALIZER_VERSION,
  };

  const entityId = `requirement:${issue.key}`;
  const entity: CanonicalEntity = {
    id: entityId,
    tenantId: record.tenantId,
    productId: record.productId,
    type: "requirement",
    title: issue.summary,
    provenance,
    metadata: {
      ...(issue.issueType ? { issueType: issue.issueType } : {}),
      ...(issue.status ? { status: issue.status } : {}),
      ...(issue.parentKey ? { parentKey: issue.parentKey } : {}),
      ...(issue.epicKey ? { epicKey: issue.epicKey } : {}),
    },
  };

  const claims: Claim[] = [];

  if (issue.description) {
    claims.push({
      id: `claim:${issue.key}:description`,
      entityId,
      attribute: "description",
      value: issue.description,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance,
    });
  }

  for (const [attribute, value] of [
    ["issueType", issue.issueType],
    ["status", issue.status],
  ] as const) {
    if (!value) continue;
    claims.push({
      id: `claim:${issue.key}:${attribute}`,
      entityId,
      attribute,
      value,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance,
    });
  }

  for (const [index, criterion] of issue.acceptanceCriteria.entries()) {
    claims.push({
      id: `claim:${issue.key}:acceptanceCriteria:${index}`,
      entityId,
      attribute: "acceptanceCriteria",
      value: criterion,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance,
    });
  }

  const hierarchyKey = issue.parentKey ?? issue.epicKey;
  const traceLinks: TraceLink[] = hierarchyKey && hierarchyKey !== issue.key
    ? [{
        id: `link:jira:${hierarchyKey}:contains:${issue.key}`,
        fromEntityId: `requirement:${hierarchyKey}`,
        toEntityId: entityId,
        type: "contains",
        origin: "explicit",
        confidence: 1,
        provenance,
      }]
    : [];

  return { entities: [entity], claims, traceLinks };
}
