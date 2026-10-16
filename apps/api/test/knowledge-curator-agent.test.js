import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeCuratorAgent } from "../src/agents/knowledge-curator-agent.js";

test("proposes bounded curation reviews and abstains from ambiguous conflict resolution", async () => {
  const oldJira = provenance("jira", "STT-100", "1", "2025-01-01T00:00:00.000Z");
  const currentJira = provenance("jira", "STT-100", "2", "2025-02-01T00:00:00.000Z");
  const testrail = provenance("testrail", "42", "1", "2026-09-01T00:00:00.000Z");
  const context = {
    rootRequirementId: "requirement:STT-100",
    scopeRequirementIds: ["requirement:STT-100"],
    trace: {
      requirements: [entity("requirement:STT-100", "Submit title application", "requirement", currentJira)],
      tests: [],
      relationships: [],
    },
    scopedEntities: [
      entity("requirement:STT-100", "Submit title application", "requirement", currentJira),
      entity("manual-test:testrail:42", "Submit valid title application", "manual-test", testrail),
    ],
    scopedClaims: [
      claim("claim:status:old", "requirement:STT-100", "status", "Draft", oldJira),
      claim("claim:status:new", "requirement:STT-100", "status", "Ready", currentJira),
      claim(
        "claim:criterion:1",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Submit a valid title application and display confirmation",
        currentJira,
      ),
      claim(
        "claim:criterion:2",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Display confirmation and submit a valid title application",
        currentJira,
      ),
    ],
    currentScopedClaims: [
      claim("claim:status:new", "requirement:STT-100", "status", "Ready", currentJira),
      claim(
        "claim:criterion:1",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Submit a valid title application and display confirmation",
        currentJira,
      ),
      claim(
        "claim:criterion:2",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Display confirmation and submit a valid title application",
        currentJira,
      ),
    ],
    candidateEntities: [
      entity("requirement:STT-100", "Submit title application", "requirement", currentJira),
      entity("requirement:STT-101", "Submit title application", "requirement", {
        ...currentJira,
        sourceId: "STT-101",
      }),
      entity("manual-test:testrail:42", "Submit valid title application", "manual-test", testrail),
      entity("manual-test:testrail:43", "Submit valid title application", "manual-test", {
        ...testrail,
        sourceId: "43",
      }),
      entity("manual-test:testrail:44", "Confirm successful title submission", "manual-test", {
        ...testrail,
        sourceId: "44",
      }),
    ],
    candidateClaims: [
      claim(
        "claim:criterion:2",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Display confirmation and submit a valid title application",
        currentJira,
      ),
      claim(
        "claim:case:44",
        "manual-test:testrail:44",
        "custom_steps",
        "Submit a valid title application and display confirmation",
        { ...testrail, sourceId: "44" },
      ),
    ],
    currentCandidateClaims: [
      claim(
        "claim:criterion:2",
        "requirement:STT-100",
        "acceptanceCriteria",
        "Display confirmation and submit a valid title application",
        currentJira,
      ),
      claim(
        "claim:case:44",
        "manual-test:testrail:44",
        "custom_steps",
        "Submit a valid title application and display confirmation",
        { ...testrail, sourceId: "44" },
      ),
    ],
    scopedTraceLinks: [],
    productTraceLinks: [],
    openConflicts: [{
      id: "conflict:requirement:STT-100:status",
      entityId: "requirement:STT-100",
      claimIds: ["claim:status:old", "claim:status:new"],
      reason: "2 claims disagree on status",
      detectedAt: "2026-09-01T00:00:00.000Z",
      status: "open",
    }, {
      id: "conflict:requirement:STT-100:acceptanceCriteria",
      entityId: "requirement:STT-100",
      claimIds: ["claim:criterion:1", "claim:criterion:2"],
      reason: "2 claims disagree on acceptanceCriteria",
      detectedAt: "2026-09-01T00:00:00.000Z",
      status: "open",
    }],
    unresolvedTraceLinks: [{
      id: "link:missing",
      fromEntityId: "manual-test:testrail:99",
      toEntityId: "requirement:STT-100",
      type: "verifies",
      origin: "explicit",
      confidence: 1,
      provenance: { ...testrail, sourceId: "99" },
    }],
    conflictedClaimIds: [
      "claim:status:old",
      "claim:status:new",
      "claim:criterion:1",
      "claim:criterion:2",
    ],
  };
  const snapshot = structuredClone(context);
  const agent = createKnowledgeCuratorAgent({
    knowledgeService: {
      async getKnowledgeCurationContext() {
        return context;
      },
    },
    createRunId: () => "curator-run-1",
    now: () => "2026-09-14T00:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "ready-for-review");
  assert.equal(result.agent.mode, "proposal-only");
  assert.deepEqual(result.scope.requirementIds, ["requirement:STT-100"]);
  assert.ok(result.findings.some((finding) => finding.category === "duplicate-entity"));
  assert.ok(result.findings.some((finding) => finding.category === "duplicate-intent"));
  assert.ok(result.findings.some((finding) => finding.category === "missing-trace-link"));
  assert.ok(result.findings.some((finding) => finding.category === "stale-business-rule"));
  const scalarConflict = result.findings.find((finding) =>
    finding.id.endsWith(":status"));
  assert.deepEqual(scalarConflict.preview.after.proposedApprovedClaimIds, ["claim:status:new"]);
  const multiValueConflict = result.findings.find((finding) =>
    finding.id.endsWith(":acceptanceCriteria"));
  assert.equal(multiValueConflict.disposition, "abstain");
  assert.deepEqual(multiValueConflict.preview.after.proposedApprovedClaimIds, []);
  assert.ok(result.proposals.every((proposal) => proposal.approval.required));
  assert.ok(result.limitations.some((item) => item.includes("cannot mutate canonical")));
  assert.deepEqual(context, snapshot);
});

test("returns not-found without fabricating curation proposals", async () => {
  const agent = createKnowledgeCuratorAgent({
    knowledgeService: {
      async getKnowledgeCurationContext() {
        return { trace: undefined, scopeRequirementIds: [] };
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-404" });

  assert.equal(result.status, "not-found");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.proposals, []);
  assert.equal(result.approval.required, true);
});

test("bounds similarity comparisons and discloses incomplete analysis", async () => {
  const source = provenance("jira", "STT-100", "1", "2026-09-01T00:00:00.000Z");
  const root = entity("requirement:STT-100", "Submit title application", "requirement", source);
  const context = {
    rootRequirementId: root.id,
    scopeRequirementIds: [root.id],
    trace: { requirements: [root], tests: [], relationships: [] },
    scopedEntities: [root],
    scopedClaims: [
      claim("claim:root", root.id, "description", "Submit title application", source),
    ],
    currentScopedClaims: [
      claim("claim:root", root.id, "description", "Submit title application", source),
    ],
    candidateEntities: [
      root,
      entity("requirement:STT-101", "Submit title application", "requirement", {
        ...source,
        sourceId: "STT-101",
      }),
      entity("requirement:STT-102", "Confirm title application", "requirement", {
        ...source,
        sourceId: "STT-102",
      }),
    ],
  };
  const agent = createKnowledgeCuratorAgent({
    knowledgeService: {
      async getKnowledgeCurationContext() {
        return context;
      },
    },
    maxSimilarityComparisons: 1,
    now: () => "2026-09-14T00:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.confidence.level, "low");
  assert.ok(result.limitations.some((item) =>
    item.includes("truncated after 1 comparisons")
    && item.includes("1-comparison safety bound")));
});

test("does not treat a subset title as a duplicate or ready review", async () => {
  const source = provenance("jira", "STT-100", "1", "2026-09-01T00:00:00.000Z");
  const root = entity("requirement:STT-100", "Submit title application", "requirement", source);
  const context = {
    rootRequirementId: root.id,
    scopeRequirementIds: [root.id],
    trace: { requirements: [root], tests: [], relationships: [] },
    scopedEntities: [root],
    scopedClaims: [
      claim("claim:root", root.id, "description", "Submit title application", source),
    ],
    currentScopedClaims: [
      claim("claim:root", root.id, "description", "Submit title application", source),
    ],
    candidateEntities: [
      root,
      entity("requirement:STT-101", "Submit valid title application", "requirement", {
        ...source,
        sourceId: "STT-101",
      }),
    ],
  };
  const agent = createKnowledgeCuratorAgent({
    knowledgeService: {
      async getKnowledgeCurationContext() {
        return context;
      },
    },
    now: () => "2026-09-14T00:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "insufficient-context");
  assert.equal(result.confidence.level, "medium");
  assert.equal(result.findings.some((finding) => finding.category === "duplicate-entity"), false);
  assert.deepEqual(result.proposals, []);
});

test("uses only exact hierarchy requirements as finding anchors", async () => {
  const source = provenance("jira", "STT-100", "1", "2026-09-01T00:00:00.000Z");
  const testRail = provenance("testrail", "42", "1", "2026-09-01T00:00:00.000Z");
  const root = entity("requirement:STT-100", "Create vehicle record", "requirement", source);
  const neighbor = entity("requirement:STT-200", "Submit title application", "requirement", {
    ...source,
    sourceId: "STT-200",
  });
  const context = {
    rootRequirementId: root.id,
    scopeRequirementIds: [root.id],
    trace: { requirements: [root, neighbor], tests: [], relationships: [] },
    scopedEntities: [root, neighbor],
    scopedClaims: [
      claim("claim:root", root.id, "description", "Create vehicle record", source),
    ],
    currentScopedClaims: [
      claim("claim:root", root.id, "description", "Create vehicle record", source),
    ],
    candidateEntities: [
      root,
      neighbor,
      entity("requirement:STT-201", "Submit title application", "requirement", {
        ...source,
        sourceId: "STT-201",
      }),
      entity("manual-test:testrail:42", "Create vehicle record", "manual-test", testRail),
      entity("manual-test:testrail:43", "Submit title application", "manual-test", {
        ...testRail,
        sourceId: "43",
      }),
    ],
  };
  const agent = createKnowledgeCuratorAgent({
    knowledgeService: {
      async getKnowledgeCurationContext() {
        return context;
      },
    },
    now: () => "2026-09-14T00:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.ok(result.findings.some((finding) =>
    finding.category === "missing-trace-link"
    && finding.entityIds.includes(root.id)));
  assert.equal(result.findings.some((finding) => finding.entityIds.includes(neighbor.id)), false);
  assert.equal(result.findings.some((finding) =>
    finding.entityIds.includes("requirement:STT-201")), false);
});

function entity(id, title, type, sourceProvenance) {
  return {
    id,
    tenantId: "solera",
    productId: "fl-titling",
    type,
    title,
    provenance: sourceProvenance,
  };
}

function claim(id, entityId, attribute, value, sourceProvenance) {
  return {
    id,
    entityId,
    attribute,
    value,
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: sourceProvenance,
  };
}

function provenance(source, sourceId, sourceVersion, observedAt) {
  return {
    source,
    sourceId,
    sourceVersion,
    contentHash: `${source}-${sourceId}-${sourceVersion}`,
    observedAt,
    normalizerId: `${source}-normalizer`,
    normalizerVersion: "0.1.0",
  };
}
