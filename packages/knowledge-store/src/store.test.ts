import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryKnowledgeStore } from "./store.ts";
import type { CanonicalEntity, Claim, TraceLink } from "@tkl/contracts";

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

test("stores and retrieves an entity by id and by product", () => {
  const store = new InMemoryKnowledgeStore();
  const entity: CanonicalEntity = {
    id: "req-1",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "As a user I can submit a title application",
    provenance: provenance(),
  };

  store.addEntity(entity);

  assert.equal(store.getEntity("req-1"), entity);
  assert.deepEqual(store.listEntities("fl-titling"), [entity]);
  assert.deepEqual(store.listEntities("other-product"), []);
});

test("only approved claims are surfaced via getApprovedClaims", () => {
  const store = new InMemoryKnowledgeStore();
  const pending: Claim = {
    id: "claim-1",
    entityId: "req-1",
    attribute: "acceptanceCriteria",
    value: "must validate VIN",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  };
  const approved: Claim = { ...pending, id: "claim-2", status: "approved" };

  store.addClaim(pending);
  store.addClaim(approved);

  assert.deepEqual(store.getClaims("req-1"), [pending, approved]);
  assert.deepEqual(store.getApprovedClaims("req-1"), [approved]);
});

test("deduplicates replayed claims and trace links with the same stable ID", () => {
  const store = new InMemoryKnowledgeStore();
  const claim: Claim = {
    id: "claim-1",
    entityId: "req-1",
    attribute: "status",
    value: "draft",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  };
  store.addClaim(claim);
  store.addClaim({ ...claim });

  store.addEntity({
    id: "req-1",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "Requirement",
    provenance: provenance(),
  });
  store.addEntity({
    id: "test-1",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "Test",
    provenance: provenance(),
  });
  const link: TraceLink = {
    id: "link-1",
    fromEntityId: "test-1",
    toEntityId: "req-1",
    type: "verifies",
    origin: "explicit",
    confidence: 0.5,
    provenance: provenance(),
  };
  store.addTraceLink(link);
  store.addTraceLink({ ...link });

  assert.deepEqual(store.getClaims("req-1").map((item) => item.value), ["draft"]);
  assert.deepEqual(store.getTraceLinks("req-1").map((item) => item.confidence), [0.5]);
});

test("retains conflicting claim revisions with distinct storage IDs", () => {
  const store = new InMemoryKnowledgeStore();
  const original: Claim = {
    id: "claim-1",
    entityId: "req-1",
    attribute: "status",
    value: "draft",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: provenance(),
  };
  store.addClaim(original);
  store.addClaim({
    ...original,
    value: "final",
    provenance: {
      ...provenance(),
      sourceVersion: "4",
      contentHash: "hash-def",
    },
  });

  const claims = store.getClaims("req-1");
  assert.equal(claims.length, 2);
  assert.notEqual(claims[0].id, claims[1].id);
  assert.deepEqual(claims.map((item) => item.value), ["draft", "final"]);
});

test("trace links are retrievable from either endpoint", () => {
  const store = new InMemoryKnowledgeStore();
  store.addEntity({
    id: "req-1",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "A requirement",
    provenance: provenance(),
  });
  store.addEntity({
    id: "test-1",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "An automated test",
    provenance: provenance(),
  });
  const link: TraceLink = {
    id: "link-1",
    fromEntityId: "test-1",
    toEntityId: "req-1",
    type: "verifies",
    origin: "explicit",
    confidence: 0.95,
    provenance: provenance(),
  };

  store.addTraceLink(link);

  assert.deepEqual(store.getTraceLinks("req-1"), [link]);
  assert.deepEqual(store.getTraceLinks("test-1"), [link]);
  assert.deepEqual(store.getTraceLinks("unrelated"), []);
});

test("conflicts remain visible until reviewed", () => {
  const store = new InMemoryKnowledgeStore();
  store.addConflict({
    id: "conflict-1",
    entityId: "req-1",
    claimIds: ["claim-1", "claim-2"],
    reason: "Two claims disagree on the required field length",
    detectedAt: "2026-09-10T00:00:00.000Z",
    status: "open",
  });

  assert.equal(store.listOpenConflicts("req-1").length, 1);
  assert.equal(store.listOpenConflicts("other").length, 0);
});

test("replaces a conflict with the same stable ID", () => {
  const store = new InMemoryKnowledgeStore();
  store.addConflict({
    id: "conflict-1",
    entityId: "req-1",
    claimIds: ["claim-1", "claim-2"],
    reason: "Original conflict",
    detectedAt: "2026-09-10T00:00:00.000Z",
    status: "open",
  });
  store.addConflict({
    id: "conflict-1",
    entityId: "req-1",
    claimIds: ["claim-1", "claim-2", "claim-3"],
    reason: "Updated conflict",
    detectedAt: "2026-09-10T01:00:00.000Z",
    status: "open",
  });

  assert.deepEqual(store.listOpenConflicts("req-1"), [{
    id: "conflict-1",
    entityId: "req-1",
    claimIds: ["claim-1", "claim-2", "claim-3"],
    reason: "Updated conflict",
    detectedAt: "2026-09-10T01:00:00.000Z",
    status: "open",
  }]);
});

test("does not reopen a reviewed conflict when its claims are unchanged", () => {
  const store = new InMemoryKnowledgeStore();
  const reviewed = {
    id: "conflict-1",
    entityId: "req-1",
    claimIds: ["claim-1", "claim-2"],
    reason: "Reviewed conflict",
    detectedAt: "2026-09-10T00:00:00.000Z",
    status: "reviewed" as const,
  };
  store.addConflict(reviewed);
  store.addConflict({
    ...reviewed,
    reason: "Analyzer rediscovered conflict",
    detectedAt: "2026-09-10T01:00:00.000Z",
    status: "open",
  });

  assert.deepEqual(store.conflicts(), []);
  assert.deepEqual(store.listOpenConflicts("req-1"), []);
});

test("records an auditable claim review and exposes only approved knowledge", () => {
  const store = new InMemoryKnowledgeStore();
  const claim: Claim = {
    id: "claim:testrail:case:1201:title",
    entityId: "manual-test:testrail:1201",
    attribute: "title",
    value: "Verify title workflow",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: { ...provenance(), source: "testrail", sourceId: "1201" },
  };
  store.addClaim(claim);

  const review = store.reviewClaim({
    claimId: claim.id,
    decision: "approved",
    reviewerId: "qa-lead",
    reviewedAt: "2026-09-11T18:00:00.000Z",
    note: " Approved for the regression library. ",
  });

  assert.equal(store.getApprovedClaims(claim.entityId)[0].id, claim.id);
  assert.deepEqual(store.listReviews(claim.entityId), [{
    id: review.id,
    entityId: claim.entityId,
    targetType: "claim",
    targetId: claim.id,
    decision: "approved",
    reviewerId: "qa-lead",
    reviewedAt: "2026-09-11T18:00:00.000Z",
    note: "Approved for the regression library.",
  }]);

  store.addClaim({ ...claim });
  assert.deepEqual(
    store.getClaims(claim.entityId).map((item) => [item.id, item.status]),
    [[claim.id, "approved"]],
  );
});

test("resolves a TestRail conflict by approving selected claims and rejecting the rest", () => {
  const store = new InMemoryKnowledgeStore();
  const entityId = "test-execution:testrail:result:7701";
  const first: Claim = {
    id: "claim:testrail:result:7701:status@v1",
    entityId,
    attribute: "status",
    value: "unknown",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: { ...provenance(), source: "testrail", sourceId: "7701" },
  };
  const second: Claim = {
    ...first,
    id: "claim:testrail:result:7701:status@v2",
    value: "passed",
    provenance: {
      ...first.provenance,
      sourceVersion: "4",
      contentHash: "hash-v2",
    },
  };
  store.addClaim(first);
  store.addClaim(second);
  store.addConflict({
    id: `conflict:${entityId}:status`,
    entityId,
    claimIds: [first.id, second.id],
    reason: "TestRail status mapping changed",
    detectedAt: "2026-09-11T17:00:00.000Z",
    status: "open",
  });

  const review = store.reviewConflict({
    conflictId: `conflict:${entityId}:status`,
    approvedClaimIds: [second.id],
    reviewerId: "qa-lead",
    reviewedAt: "2026-09-11T18:00:00.000Z",
  });

  assert.deepEqual(
    store.getClaims(entityId).map((claim) => [claim.id, claim.status]),
    [[first.id, "rejected"], [second.id, "approved"]],
  );
  assert.deepEqual(store.listOpenConflicts(entityId), []);
  assert.deepEqual(store.listReviews(entityId), [{
    id: review.id,
    entityId,
    targetType: "conflict",
    targetId: `conflict:${entityId}:status`,
    decision: "resolved",
    approvedClaimIds: [second.id],
    reviewerId: "qa-lead",
    reviewedAt: "2026-09-11T18:00:00.000Z",
    note: undefined,
  }]);
});

test("requires open conflicts to be reviewed atomically", () => {
  const store = new InMemoryKnowledgeStore();
  const claim: Claim = {
    id: "claim:testrail:case:1201:title",
    entityId: "manual-test:testrail:1201",
    attribute: "title",
    value: "Pending title",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  };
  store.addClaim(claim);
  store.addConflict({
    id: "conflict:manual-test:testrail:1201:title",
    entityId: claim.entityId,
    claimIds: [claim.id],
    reason: "Review as a conflict",
    detectedAt: "2026-09-11T17:00:00.000Z",
    status: "open",
  });

  assert.throws(
    () => store.reviewClaim({
      claimId: claim.id,
      decision: "approved",
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-11T18:00:00.000Z",
    }),
    /review the conflict instead/,
  );
  assert.throws(
    () => store.reviewConflict({
      conflictId: "conflict:manual-test:testrail:1201:title",
      approvedClaimIds: ["claim:not-in-conflict"],
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-11T18:00:00.000Z",
    }),
    /does not belong to conflict/,
  );
});

test("rejects trace links between entities from different products", () => {
  const store = new InMemoryKnowledgeStore();
  store.addEntity({
    id: "test-suite:testrail:12",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test-suite",
    title: "Regression",
    provenance: provenance(),
  });
  store.addEntity({
    id: "manual-test:testrail:1201",
    tenantId: "solera",
    productId: "other-product",
    type: "manual-test",
    title: "A test from another product",
    provenance: provenance(),
  });

  assert.throws(
    () => store.addTraceLink({
      id: "link:cross-product",
      fromEntityId: "test-suite:testrail:12",
      toEntityId: "manual-test:testrail:1201",
      type: "contains",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    }),
    /cannot cross tenant or product boundaries/,
  );
});

test("rejects a trace link whose endpoint is not stored", () => {
  const store = new InMemoryKnowledgeStore();

  assert.throws(
    () => store.addTraceLink({
      id: "link:missing-endpoint",
      fromEntityId: "test-suite:testrail:12",
      toEntityId: "manual-test:testrail:1201",
      type: "contains",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    }),
    /requires both endpoint entities/,
  );
});

test("rejects an entity ID reused by a different tenant or product", () => {
  const store = new InMemoryKnowledgeStore();
  store.addEntity({
    id: "manual-test:testrail:1201",
    tenantId: "solera",
    productId: "fl-titling",
    type: "manual-test",
    title: "First scoped entity",
    provenance: provenance(),
  });

  assert.throws(
    () => store.addEntity({
      id: "manual-test:testrail:1201",
      tenantId: "another-tenant",
      productId: "another-product",
      type: "manual-test",
      title: "Conflicting scoped entity",
      provenance: provenance(),
    }),
    /cannot be reused across tenant or product boundaries/,
  );
});
