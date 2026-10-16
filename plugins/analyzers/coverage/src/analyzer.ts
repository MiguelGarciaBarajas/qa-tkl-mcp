import type {
  Analyzer,
  CanonicalEntity,
  Claim,
  CoverageAnalysisResult,
  CoverageWeights,
  PluginManifest,
  RequirementCoverageDimension,
} from "@tkl/contracts";
import type { KnowledgeStore } from "@tkl/knowledge-store";

export interface CoverageAnalyzerInput {
  store: KnowledgeStore;
  requirementId: string;
}

export type ExecutionOutcome =
  | "passed"
  | "failed"
  | "blocked"
  | "skipped"
  | "retest"
  | "not-run";

export interface CoveragePolicy {
  version: string;
  provisional: boolean;
  freshnessWindowDays: number | null;
  executionStatusById: Readonly<Record<string, ExecutionOutcome>>;
  qualifyingExecutionOutcomes: readonly ExecutionOutcome[];
  combinedWeights: CoverageWeights | null;
}

const UNCONFIGURED_POLICY: CoveragePolicy = {
  version: "provisional-unconfigured",
  provisional: true,
  freshnessWindowDays: null,
  executionStatusById: {},
  qualifyingExecutionOutcomes: [],
  combinedWeights: null,
};

/**
 * Computes independently reviewable manual, automated, and execution-freshness
 * dimensions. Product-specific status mappings, freshness windows, and combined
 * weights are injected; an unconfigured dimension is reported explicitly instead of
 * silently inventing a product rule.
 *
 * Owner: Josue Misael Torres (Knowledge and Traceability). Reads from `KnowledgeStore`
 * only; must never call source APIs or the TKL Application API directly.
 */
export class CoverageAnalyzer implements Analyzer<CoverageAnalyzerInput, CoverageAnalysisResult> {
  private readonly policy: CoveragePolicy;
  private readonly now: () => Date;

  constructor({
    policy = UNCONFIGURED_POLICY,
    now = () => new Date(),
  }: {
    policy?: CoveragePolicy;
    now?: () => Date;
  } = {}) {
    assertCoveragePolicy(policy);
    this.policy = policy;
    this.now = now;
  }

  manifest: PluginManifest = {
    id: "tkl.analyzer.coverage",
    version: "0.2.0",
    contractVersion: "0.1.0",
    capabilities: [
      "requirement-coverage",
      "manual-coverage",
      "automated-coverage",
      "execution-freshness",
    ],
    requiredPermissions: ["knowledge-store:read"],
  };

  async analyze({ store, requirementId }: CoverageAnalyzerInput): Promise<CoverageAnalysisResult> {
    const acceptanceCriteria = store
      .getApprovedClaims(requirementId)
      .filter((c) => c.attribute === "acceptanceCriteria");

    const verifyingLinks = store
      .getTraceLinks(requirementId)
      .filter((link) =>
        link.toEntityId === requirementId
        && link.type === "verifies"
        && link.origin === "explicit");

    const denominator = acceptanceCriteria.length || 1;
    const linkedEntities = uniqueEntities(
      verifyingLinks
        .map((link) => store.getEntity(link.fromEntityId))
        .filter((entity): entity is CanonicalEntity => entity !== undefined),
    );
    const manualTests = linkedEntities.filter((entity) => entity.type === "manual-test");
    const directAutomatedTests = linkedEntities.filter((entity) => entity.type === "test");
    const automatedTests = uniqueEntities([
      ...directAutomatedTests,
      ...manualTests.flatMap((manualTest) =>
        store
          .getTraceLinks(manualTest.id)
          .filter((link) =>
            link.type === "relates_to"
            && link.fromEntityId === manualTest.id
            && link.origin === "explicit")
          .map((link) => store.getEntity(link.toEntityId))
          .filter((entity): entity is CanonicalEntity => entity?.type === "test")),
    ]);
    const allTests = uniqueEntities([...manualTests, ...automatedTests]);
    const numerator = Math.min(verifyingLinks.length, denominator);
    const linkConfidence = verifyingLinks.length
      ? verifyingLinks.reduce((sum, l) => sum + l.confidence, 0) / verifyingLinks.length
      : 0;

    const uncovered =
      verifyingLinks.length >= acceptanceCriteria.length
        ? []
        : acceptanceCriteria
            .slice(verifyingLinks.length)
            .map((c) => String(c.value));

    const manualCoverage = linkCoverageDimension(manualTests);
    const automatedCoverage = linkCoverageDimension(automatedTests);
    const executionFreshness = freshnessDimension(
      store,
      allTests,
      this.policy,
      this.now(),
    );
    const combinedCoverage = combineCoverage(
      manualCoverage,
      automatedCoverage,
      executionFreshness,
      this.policy.combinedWeights,
    );

    return {
      requirementId,
      numerator,
      denominator,
      linkConfidence,
      uncovered,
      policy: {
        version: this.policy.version,
        provisional: this.policy.provisional,
      },
      manualCoverage,
      automatedCoverage,
      executionFreshness,
      combinedCoverage,
    };
  }
}

function linkCoverageDimension(
  entities: CanonicalEntity[],
): RequirementCoverageDimension {
  const evidenceEntityIds = entities.map((entity) => entity.id);
  const numerator = evidenceEntityIds.length > 0 ? 1 : 0;
  return {
    status: "evaluated",
    basis: "requirement-link",
    numerator,
    denominator: 1,
    ratio: numerator,
    evidenceEntityIds,
  };
}

function freshnessDimension(
  store: KnowledgeStore,
  tests: CanonicalEntity[],
  policy: CoveragePolicy,
  now: Date,
): CoverageAnalysisResult["executionFreshness"] {
  if (
    policy.freshnessWindowDays === null
    || Object.keys(policy.executionStatusById).length === 0
    || policy.qualifyingExecutionOutcomes.length === 0
  ) {
    return {
      status: "not-evaluated",
      numerator: 0,
      denominator: tests.length,
      ratio: null,
      coveredEntityIds: [],
      uncoveredEntityIds: tests.map((entity) => entity.id),
      staleEntityIds: [],
      nonQualifyingEntityIds: [],
      missingExecutionEntityIds: tests.map((entity) => entity.id),
      reason: "Execution status mapping and freshness policy are not configured",
    };
  }

  const threshold = now.getTime() - policy.freshnessWindowDays * 86_400_000;
  const freshIds: string[] = [];
  const staleIds: string[] = [];
  const nonQualifyingIds: string[] = [];
  const missingIds: string[] = [];

  for (const testEntity of tests) {
    const executions = store
      .getTraceLinks(testEntity.id)
      .filter((link) =>
        link.type === "executed_by"
        && link.fromEntityId === testEntity.id
        && link.origin === "explicit")
      .map((link) => {
        const claims = latestClaimSet(store.getClaims(link.toEntityId));
        return {
          entity: store.getEntity(link.toEntityId),
          statusId: claimValue(claims, "status_id"),
          executedAt: claimValue(claims, "executedAt"),
        };
      })
      .filter((entry) => entry.entity?.type === "test-execution");
    const classifiedExecutions = executions
      .map((entry) => ({
        timestamp: entry.executedAt ? Date.parse(entry.executedAt) : Number.NaN,
        outcome: entry.statusId
          ? policy.executionStatusById[entry.statusId]
          : undefined,
      }))
      .filter((entry) => Number.isFinite(entry.timestamp) && entry.outcome !== undefined);
    const qualifying = classifiedExecutions
      .filter((entry) => policy.qualifyingExecutionOutcomes.includes(entry.outcome!))
      .map((entry) => entry.timestamp);

    if (qualifying.some((timestamp) => timestamp >= threshold && timestamp <= now.getTime())) {
      freshIds.push(testEntity.id);
    } else if (qualifying.length > 0) {
      staleIds.push(testEntity.id);
    } else if (classifiedExecutions.length > 0) {
      nonQualifyingIds.push(testEntity.id);
    } else {
      missingIds.push(testEntity.id);
    }
  }

  const denominator = tests.length;
  return {
    status: "evaluated",
    numerator: freshIds.length,
    denominator,
    ratio: denominator === 0 ? 0 : freshIds.length / denominator,
    coveredEntityIds: freshIds,
    uncoveredEntityIds: [...staleIds, ...nonQualifyingIds, ...missingIds],
    staleEntityIds: staleIds,
    nonQualifyingEntityIds: nonQualifyingIds,
    missingExecutionEntityIds: missingIds,
  };
}

function combineCoverage(
  manual: RequirementCoverageDimension,
  automated: RequirementCoverageDimension,
  freshness: CoverageAnalysisResult["executionFreshness"],
  weights: CoverageWeights | null,
): CoverageAnalysisResult["combinedCoverage"] {
  if (
    !weights
    || freshness.status !== "evaluated"
  ) {
    return {
      status: "not-evaluated",
      score: null,
      weights,
      reason: "Combined coverage weights or execution freshness policy are not configured",
    };
  }
  return {
    status: "evaluated",
    score: roundScore(
      manual.ratio! * weights.manual
      + automated.ratio! * weights.automated
      + freshness.ratio! * weights.executionFreshness,
    ),
    weights,
  };
}

function claimValue(claims: Claim[], attribute: string): string | undefined {
  const claim = claims.find((candidate) => candidate.attribute === attribute);
  return typeof claim?.value === "string" ? claim.value : undefined;
}

function latestClaimSet(claims: Claim[]): Claim[] {
  const revisions = new Map<string, { claims: Claim[]; timestamp: number; order: number }>();
  claims.forEach((claim, order) => {
    const entries = Array.isArray(claim.provenance) ? claim.provenance : [claim.provenance];
    const key = JSON.stringify(entries.map((entry) => ({
      source: entry.source,
      sourceId: entry.sourceId,
      sourceVersion: entry.sourceVersion,
      contentHash: entry.contentHash,
      observedAt: entry.observedAt,
    })));
    const timestamp = Math.max(
      ...entries.map((entry) => {
        const value = Date.parse(entry.observedAt);
        return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
      }),
    );
    const revision = revisions.get(key) ?? { claims: [], timestamp, order };
    revision.claims.push(claim);
    revision.order = order;
    revisions.set(key, revision);
  });
  return [...revisions.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
    .at(-1)?.claims ?? [];
}

function uniqueEntities(entities: CanonicalEntity[]): CanonicalEntity[] {
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()];
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertCoveragePolicy(policy: CoveragePolicy): void {
  const outcomes = new Set<ExecutionOutcome>([
    "passed",
    "failed",
    "blocked",
    "skipped",
    "retest",
    "not-run",
  ]);
  if (!policy || typeof policy !== "object") {
    throw new TypeError("Coverage policy must be an object");
  }
  if (!policy.version.trim()) throw new TypeError("Coverage policy version is required");
  if (typeof policy.provisional !== "boolean") {
    throw new TypeError("Coverage policy provisional flag must be boolean");
  }
  if (
    policy.freshnessWindowDays !== null
    && (!Number.isInteger(policy.freshnessWindowDays) || policy.freshnessWindowDays <= 0)
  ) {
    throw new TypeError("freshnessWindowDays must be a positive integer or null");
  }
  if (
    !policy.executionStatusById
    || typeof policy.executionStatusById !== "object"
    || Array.isArray(policy.executionStatusById)
    || Object.entries(policy.executionStatusById).some(
      ([statusId, outcome]) => !/^\d+$/.test(statusId) || !outcomes.has(outcome),
    )
  ) {
    throw new TypeError("executionStatusById must map numeric IDs to supported outcomes");
  }
  if (
    !Array.isArray(policy.qualifyingExecutionOutcomes)
    || policy.qualifyingExecutionOutcomes.some((outcome) => !outcomes.has(outcome))
    || new Set(policy.qualifyingExecutionOutcomes).size
      !== policy.qualifyingExecutionOutcomes.length
  ) {
    throw new TypeError("qualifyingExecutionOutcomes must contain unique supported outcomes");
  }
  if (policy.combinedWeights) {
    const values = [
      policy.combinedWeights.manual,
      policy.combinedWeights.automated,
      policy.combinedWeights.executionFreshness,
    ];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new TypeError("Coverage weights must be finite non-negative numbers");
    }
    if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) {
      throw new TypeError("Coverage weights must sum to 1");
    }
  }
}
