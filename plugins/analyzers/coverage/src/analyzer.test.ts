import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { Claim, TraceLink } from "@tkl/contracts";
import { CoverageAnalyzer } from "./analyzer.ts";

function provenance() {
  return {
    source: "jira",
    sourceId: "STT-1234",
    sourceVersion: "3",
    contentHash: "hash-abc",
    observedAt: "2026-09-10T00:00:00.000Z",
    normalizerId: "jira-normalizer",
    normalizerVersion: "0.1.0",
  };
}

function versionedProvenance(sourceVersion: string, observedAt: string) {
  return {
    ...provenance(),
    sourceVersion,
    observedAt,
    contentHash: `hash-${sourceVersion}`,
  };
}

test("coverage exposes numerator, denominator, and link confidence, not a bare percentage", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-1234";
  store.addEntity({
    id: requirementId,
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "VIN validation",
    provenance: provenance(),
  });
  store.addEntity({
    id: "test:github:4321",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "VIN validation test",
    provenance: provenance(),
  });

  const claims: Claim[] = [
    {
      id: "c1",
      entityId: requirementId,
      attribute: "acceptanceCriteria",
      value: "VIN accepted",
      origin: "explicit",
      confidence: 1,
      status: "approved",
      provenance: provenance(),
    },
    {
      id: "c2",
      entityId: requirementId,
      attribute: "acceptanceCriteria",
      value: "VIN rejected",
      origin: "explicit",
      confidence: 1,
      status: "approved",
      provenance: provenance(),
    },
  ];
  claims.forEach((c) => store.addClaim(c));

  const link: TraceLink = {
    id: "link-1",
    fromEntityId: "test:github:4321",
    toEntityId: requirementId,
    type: "verifies",
    origin: "explicit",
    confidence: 0.9,
    provenance: provenance(),
  };
  store.addTraceLink(link);

  const analyzer = new CoverageAnalyzer();
  const result = await analyzer.analyze({ store, requirementId });

  assert.equal(result.numerator, 1);
  assert.equal(result.denominator, 2);
  assert.equal(result.linkConfidence, 0.9);
  assert.deepEqual(result.uncovered, ["VIN rejected"]);
});

test("requirement with no acceptance-criteria claims reports zero coverage without dividing by zero", async () => {
  const store = new InMemoryKnowledgeStore();
  const analyzer = new CoverageAnalyzer();

  const result = await analyzer.analyze({ store, requirementId: "requirement:UNKNOWN" });

  assert.equal(result.numerator, 0);
  assert.equal(result.denominator, 1);
  assert.equal(result.linkConfidence, 0);
  assert.equal(result.combinedCoverage.status, "not-evaluated");
});

test("coverage counts only approved acceptance criteria", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-2345";
  store.addEntity({
    id: requirementId,
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "Reviewed requirement",
    provenance: provenance(),
  });
  for (const [id, value, status] of [
    ["approved-criterion", "Approved behavior", "approved"],
    ["pending-criterion", "Unreviewed behavior", "pending"],
    ["rejected-criterion", "Rejected behavior", "rejected"],
  ] as const) {
    store.addClaim({
      id,
      entityId: requirementId,
      attribute: "acceptanceCriteria",
      value,
      origin: "explicit",
      confidence: 1,
      status,
      provenance: provenance(),
    });
  }

  const result = await new CoverageAnalyzer().analyze({ store, requirementId });

  assert.equal(result.denominator, 1);
  assert.deepEqual(result.uncovered, ["Approved behavior"]);
});

test("calculates manual, automated, freshness, and combined coverage independently", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-5678";
  const entities = [
    { id: requirementId, type: "requirement", title: "Transfer title" },
    { id: "manual-test:testrail:1", type: "manual-test", title: "Happy path" },
    { id: "manual-test:testrail:2", type: "manual-test", title: "Invalid owner" },
    { id: "test:github:10", type: "test", title: "Automated happy path" },
    { id: "test-execution:testrail:result:1", type: "test-execution", title: "Recent result" },
    { id: "test-execution:testrail:result:2", type: "test-execution", title: "Stale result" },
  ] as const;
  for (const entity of entities) {
    store.addEntity({
      ...entity,
      tenantId: "solera",
      productId: "fl-titling",
      provenance: provenance(),
    });
  }
  for (const [index, value] of ["Valid transfer", "Invalid owner rejected"].entries()) {
    store.addClaim({
      id: `criterion-${index}`,
      entityId: requirementId,
      attribute: "acceptanceCriteria",
      value,
      origin: "explicit",
      confidence: 1,
      status: "approved",
      provenance: provenance(),
    });
  }
  const links: TraceLink[] = [
    {
      id: "manual-1-requirement",
      fromEntityId: "manual-test:testrail:1",
      toEntityId: requirementId,
      type: "verifies",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    },
    {
      id: "manual-2-requirement",
      fromEntityId: "manual-test:testrail:2",
      toEntityId: requirementId,
      type: "verifies",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    },
    {
      id: "manual-1-automation",
      fromEntityId: "manual-test:testrail:1",
      toEntityId: "test:github:10",
      type: "relates_to",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    },
    {
      id: "manual-1-result",
      fromEntityId: "manual-test:testrail:1",
      toEntityId: "test-execution:testrail:result:1",
      type: "executed_by",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    },
    {
      id: "manual-2-result",
      fromEntityId: "manual-test:testrail:2",
      toEntityId: "test-execution:testrail:result:2",
      type: "executed_by",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    },
  ];
  links.forEach((link) => store.addTraceLink(link));
  for (const [resultId, executedAt] of [
    ["test-execution:testrail:result:1", "2026-09-09T00:00:00.000Z"],
    ["test-execution:testrail:result:2", "2026-07-01T00:00:00.000Z"],
  ]) {
    store.addClaim({
      id: `${resultId}:status`,
      entityId: resultId,
      attribute: "status_id",
      value: "1",
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: provenance(),
    });
    store.addClaim({
      id: `${resultId}:executedAt`,
      entityId: resultId,
      attribute: "executedAt",
      value: executedAt,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: provenance(),
    });
  }

  const analyzer = new CoverageAnalyzer({
    policy: {
      version: "fixture-v1",
      provisional: true,
      freshnessWindowDays: 30,
      executionStatusById: { "1": "passed" },
      qualifyingExecutionOutcomes: ["passed"],
      combinedWeights: {
        manual: 0.4,
        automated: 0.4,
        executionFreshness: 0.2,
      },
    },
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  });
  const result = await analyzer.analyze({ store, requirementId });

  assert.deepEqual(result.manualCoverage, {
    status: "evaluated",
    basis: "requirement-link",
    numerator: 1,
    denominator: 1,
    ratio: 1,
    evidenceEntityIds: ["manual-test:testrail:1", "manual-test:testrail:2"],
  });
  assert.deepEqual(result.automatedCoverage, {
    status: "evaluated",
    basis: "requirement-link",
    numerator: 1,
    denominator: 1,
    ratio: 1,
    evidenceEntityIds: ["test:github:10"],
  });
  assert.deepEqual(result.executionFreshness, {
    status: "evaluated",
    numerator: 1,
    denominator: 3,
    ratio: 1 / 3,
    coveredEntityIds: ["manual-test:testrail:1"],
    uncoveredEntityIds: ["manual-test:testrail:2", "test:github:10"],
    staleEntityIds: ["manual-test:testrail:2"],
    nonQualifyingEntityIds: [],
    missingExecutionEntityIds: ["test:github:10"],
  });
  assert.deepEqual(result.combinedCoverage, {
    status: "evaluated",
    score: 0.866667,
    weights: {
      manual: 0.4,
      automated: 0.4,
      executionFreshness: 0.2,
    },
  });
});

test("distinguishes non-qualifying executions from missing execution evidence", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-9012";
  for (const entity of [
    { id: requirementId, type: "requirement", title: "Requirement" },
    { id: "manual-test:testrail:3", type: "manual-test", title: "Failed case" },
    { id: "test-execution:testrail:result:3", type: "test-execution", title: "Failed result" },
  ] as const) {
    store.addEntity({
      ...entity,
      tenantId: "solera",
      productId: "fl-titling",
      provenance: provenance(),
    });
  }
  store.addClaim({
    id: "criterion-failed",
    entityId: requirementId,
    attribute: "acceptanceCriteria",
    value: "Operation succeeds",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: provenance(),
  });
  for (const link of [
    {
      id: "failed-case-requirement",
      fromEntityId: "manual-test:testrail:3",
      toEntityId: requirementId,
      type: "verifies",
    },
    {
      id: "failed-case-result",
      fromEntityId: "manual-test:testrail:3",
      toEntityId: "test-execution:testrail:result:3",
      type: "executed_by",
    },
  ] as const) {
    store.addTraceLink({
      ...link,
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    });
  }
  for (const [attribute, value] of [
    ["status_id", "5"],
    ["executedAt", "2026-09-09T00:00:00.000Z"],
  ]) {
    store.addClaim({
      id: `failed-result-${attribute}`,
      entityId: "test-execution:testrail:result:3",
      attribute,
      value,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: provenance(),
    });
  }

  const result = await new CoverageAnalyzer({
    policy: {
      version: "fixture-v1",
      provisional: true,
      freshnessWindowDays: 30,
      executionStatusById: { "1": "passed", "5": "failed" },
      qualifyingExecutionOutcomes: ["passed"],
      combinedWeights: { manual: 0.4, automated: 0.4, executionFreshness: 0.2 },
    },
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  }).analyze({ store, requirementId });

  assert.deepEqual(result.executionFreshness.nonQualifyingEntityIds, [
    "manual-test:testrail:3",
  ]);
  assert.deepEqual(result.executionFreshness.missingExecutionEntityIds, []);
});

test("rejects invalid product coverage policies", () => {
  assert.throws(
    () => new CoverageAnalyzer({
      policy: {
        version: "invalid",
        provisional: true,
        freshnessWindowDays: 0,
        executionStatusById: {},
        qualifyingExecutionOutcomes: [],
        combinedWeights: null,
      },
    }),
    /freshnessWindowDays/,
  );
  assert.throws(
    () => new CoverageAnalyzer({
      policy: {
        version: "invalid",
        provisional: true,
        freshnessWindowDays: 30,
        executionStatusById: { "1": "passed" },
        qualifyingExecutionOutcomes: ["passed"],
        combinedWeights: { manual: 0.5, automated: 0.5, executionFreshness: 0.5 },
      },
    }),
    /sum to 1/,
  );
});

test("does not promote inferred trace links to explicit coverage", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-3456";
  for (const entity of [
    { id: requirementId, type: "requirement", title: "Requirement" },
    { id: "manual-test:testrail:4", type: "manual-test", title: "Inferred case" },
  ] as const) {
    store.addEntity({
      ...entity,
      tenantId: "solera",
      productId: "fl-titling",
      provenance: provenance(),
    });
  }
  store.addTraceLink({
    id: "inferred-case-requirement",
    fromEntityId: "manual-test:testrail:4",
    toEntityId: requirementId,
    type: "verifies",
    origin: "inferred",
    confidence: 0.2,
    provenance: provenance(),
  });

  const result = await new CoverageAnalyzer().analyze({ store, requirementId });

  assert.equal(result.manualCoverage.ratio, 0);
  assert.deepEqual(result.manualCoverage.evidenceEntityIds, []);
});

test("uses the latest complete execution revision for freshness", async () => {
  const store = new InMemoryKnowledgeStore();
  const requirementId = "requirement:STT-7890";
  const manualTestId = "manual-test:testrail:5";
  const resultId = "test-execution:testrail:result:5";
  for (const entity of [
    { id: requirementId, type: "requirement", title: "Requirement" },
    { id: manualTestId, type: "manual-test", title: "Versioned case" },
    { id: resultId, type: "test-execution", title: "Versioned result" },
  ] as const) {
    store.addEntity({
      ...entity,
      tenantId: "solera",
      productId: "fl-titling",
      provenance: provenance(),
    });
  }
  for (const link of [
    {
      id: "versioned-case-requirement",
      fromEntityId: manualTestId,
      toEntityId: requirementId,
      type: "verifies",
    },
    {
      id: "versioned-case-result",
      fromEntityId: manualTestId,
      toEntityId: resultId,
      type: "executed_by",
    },
  ] as const) {
    store.addTraceLink({
      ...link,
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    });
  }
  for (const revision of [
    {
      sourceVersion: "1",
      observedAt: "2026-09-08T00:00:00.000Z",
      statusId: "5",
      executedAt: "2026-09-08T00:00:00.000Z",
    },
    {
      sourceVersion: "2",
      observedAt: "2026-09-09T00:00:00.000Z",
      statusId: "1",
      executedAt: "2026-09-09T00:00:00.000Z",
    },
  ]) {
    const claimProvenance = versionedProvenance(
      revision.sourceVersion,
      revision.observedAt,
    );
    for (const [attribute, value] of [
      ["status_id", revision.statusId],
      ["executedAt", revision.executedAt],
    ]) {
      store.addClaim({
        id: `versioned-result-${attribute}`,
        entityId: resultId,
        attribute,
        value,
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: claimProvenance,
      });
    }
  }

  const result = await new CoverageAnalyzer({
    policy: {
      version: "fixture-v1",
      provisional: true,
      freshnessWindowDays: 30,
      executionStatusById: { "1": "passed", "5": "failed" },
      qualifyingExecutionOutcomes: ["passed"],
      combinedWeights: { manual: 0.4, automated: 0.4, executionFreshness: 0.2 },
    },
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  }).analyze({ store, requirementId });

  assert.deepEqual(result.executionFreshness.coveredEntityIds, [manualTestId]);
  assert.deepEqual(result.executionFreshness.nonQualifyingEntityIds, []);
});
