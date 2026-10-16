import type {
  CanonicalEntity,
  Normalizer,
  NormalizationResult,
  RawEvidenceRecord,
  TraceLink,
} from "@tkl/contracts";
import { assertRawEvidenceRecord } from "@tkl/contracts";

interface GitHubPullRequestPayload {
  number: number;
  title: string;
  body?: string;
  changedFiles?: string[];
  referencedIssues?: string[];
  ticketKey?: string;
  state?: string;
}

const NORMALIZER_ID = "github-normalizer";
const NORMALIZER_VERSION = "0.1.0";

function isGitHubPullRequestPayload(payload: unknown): payload is GitHubPullRequestPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.number === "number" &&
    typeof candidate.title === "string" &&
    (candidate.referencedIssues === undefined || Array.isArray(candidate.referencedIssues)) &&
    (candidate.ticketKey === undefined || typeof candidate.ticketKey === "string")
  );
}

/**
 * Normalizes GitHub RawEvidenceRecords (pull requests) into a canonical `test` entity
 * and a `verifies` trace link to the Jira requirement(s) it references.
 *
 * Owner: Josue Misael Torres (Knowledge and Traceability). Depends only on
 * `@tkl/contracts` types - never calls the GitHub API directly (that is Jorge
 * Santiago's connector responsibility).
 *
 * Trace links produced here are `origin: "explicit"` only when the PR textually
 * references a Jira key (e.g. via `referencedIssues`); anything else is out of scope
 * for this normalizer and left to a future conflict/coverage analyzer pass.
 */
export class GitHubNormalizer implements Normalizer {
  supports(record: RawEvidenceRecord): boolean {
    return record.source === "github" && isGitHubPullRequestPayload(record.payload);
  }

  async normalize(record: RawEvidenceRecord): Promise<NormalizationResult> {
    const result = normalizeGitHubRecord(record);
    if (!result) {
      throw new Error(
        `GitHubNormalizer cannot normalize record ${record.sourceId}: unsupported payload shape`,
      );
    }
    return result;
  }
}

export function normalizeGitHubRecord(
  record: RawEvidenceRecord,
): NormalizationResult | null {
  if (record.source !== "github") return null;
  assertRawEvidenceRecord(record);
  if (!isGitHubPullRequestPayload(record.payload)) return null;
  const payload = record.payload;

  const provenance = {
    source: record.source,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    contentHash: record.contentHash,
    observedAt: record.observedAt,
    normalizerId: NORMALIZER_ID,
    normalizerVersion: NORMALIZER_VERSION,
  };

  const entityId = `test:github:${payload.number}`;
  const entity: CanonicalEntity = {
    id: entityId,
    tenantId: record.tenantId,
    productId: record.productId,
    type: "test",
    title: payload.title,
    provenance,
  };

  const referencedIssues = [
    ...(payload.referencedIssues ?? []),
    ...(payload.ticketKey ? [payload.ticketKey] : []),
  ].filter((issueKey, index, all) => all.indexOf(issueKey) === index);

  const traceLinks: TraceLink[] = referencedIssues.map((issueKey, index) => ({
    id: `link:${payload.number}:${issueKey}:${index}`,
    fromEntityId: entityId,
    toEntityId: `requirement:${issueKey}`,
    type: "verifies",
    origin: "explicit",
    confidence: 1,
    provenance,
  }));

  return { entities: [entity], claims: [], traceLinks };
}
