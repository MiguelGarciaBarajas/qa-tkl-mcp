import test from "node:test";
import assert from "node:assert/strict";
import {
  createReliabilityDefectIntelligenceAgent,
} from "../src/agents/reliability-defect-intelligence-agent.js";

test("classifies bounded multi-run histories without treating one retry as flaky", async () => {
  const contexts = [
    execution("single", 1, "FAILED", { retry: false }),
    execution("single", 1, "PASSED", { retry: true, itemId: "single-retry", minute: 1 }),
    ...sequence("flaky", ["FAILED", "PASSED", "FAILED", "PASSED"], 10),
    ...sequence("product", ["FAILED", "FAILED", "FAILED", "FAILED"], 20, {
      externalIssueKeys: ["BUG-1"],
      issueType: "PB001",
    }),
    ...sequence("environment", ["FAILED", "FAILED", "PASSED"], 30, {
      issueType: "SI001",
    }),
    ...sequence("healthy", ["PASSED", "PASSED", "PASSED"], 40),
    ...sequence("unknown", ["PASSED", "PASSED", "PASSED", "SKIPPED"], 50),
  ];
  const agent = createReliabilityDefectIntelligenceAgent({
    knowledgeService: {
      async getReliabilityIntelligenceContext() {
        return {
          trace: {
            requirements: [entity("requirement:STT-100", "Reliability scope", "jira")],
            tests: [],
            relationships: [],
          },
          executionContexts: contexts,
          jiraDefects: [{
            entity: {
              ...entity("requirement:BUG-1", "Persistent fee defect", "jira"),
              metadata: { issueType: "Bug", status: "Open" },
            },
            claims: [],
          }],
        };
      },
    },
    createRunId: () => "reliability-run-1",
    now: () => "2026-09-14T12:00:00.000Z",
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });
  const byIdentity = Object.fromEntries(
    result.analyses.map((analysis) => [analysis.identity.value, analysis]),
  );

  assert.equal(result.status, "ready-for-review");
  assert.equal(result.agent.mode, "proposal-only");
  assert.equal(byIdentity["tests/single.spec.ts#single"].classification, "insufficient-history");
  assert.equal(byIdentity["tests/single.spec.ts#single"].aggregates.independentRuns, 1);
  assert.equal(byIdentity["tests/single.spec.ts#single"].aggregates.observedAttempts, 2);
  assert.equal(byIdentity["tests/flaky.spec.ts#flaky"].classification, "likely-flaky");
  assert.equal(
    byIdentity["tests/product.spec.ts#product"].classification,
    "consistently-failing-product-risk",
  );
  assert.equal(byIdentity["tests/product.spec.ts#product"].linkedJiraDefects[0].id, "requirement:BUG-1");
  assert.equal(
    byIdentity["tests/environment.spec.ts#environment"].classification,
    "environment-infrastructure-signal",
  );
  assert.equal(byIdentity["tests/healthy.spec.ts#healthy"].classification, "healthy");
  assert.equal(byIdentity["tests/unknown.spec.ts#unknown"].classification, "insufficient-history");
  assert.deepEqual(byIdentity["tests/unknown.spec.ts#unknown"].aggregates.unknownStatusCounts, {
    SKIPPED: 1,
  });
  assert.ok(result.limitations.some((item) => item.includes("never emits or writes")));
  assert.ok(result.recommendations.some((item) => item.kind === "regression-prevention"));
});

test("returns insufficient context when no ReportPortal identity is linked to the Jira scope", async () => {
  const agent = createReliabilityDefectIntelligenceAgent({
    knowledgeService: {
      async getReliabilityIntelligenceContext() {
        return {
          trace: {
            requirements: [entity("requirement:STT-100", "Reliability scope", "jira")],
            tests: [],
            relationships: [],
          },
          executionContexts: [],
          jiraDefects: [],
        };
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-100" });

  assert.equal(result.status, "insufficient-context");
  assert.deepEqual(result.analyses, []);
  assert.ok(result.limitations.some((item) => item.includes("explicitly connected")));
});

test("returns not-found when the Jira scope is absent", async () => {
  const agent = createReliabilityDefectIntelligenceAgent({
    knowledgeService: {
      async getReliabilityIntelligenceContext() {
        return { trace: undefined };
      },
    },
  });

  const result = await agent.execute({ productId: "fl-titling", workItemId: "STT-404" });

  assert.equal(result.status, "not-found");
  assert.deepEqual(result.analyses, []);
});

function sequence(name, statuses, firstLaunch, options = {}) {
  return statuses.map((status, index) =>
    execution(name, firstLaunch + index, status, { ...options, minute: index }));
}

function execution(name, launchId, status, options = {}) {
  const itemId = options.itemId ?? `${name}-${launchId}`;
  const source = provenance("reportportal", itemId);
  return {
    execution: {
      id: `test-execution:reportportal:item:${itemId}`,
      type: "test-execution",
      title: name,
      provenance: source,
    },
    claims: [],
    launchId: String(launchId),
    status,
    startedAt: `2026-09-14T10:${String(options.minute ?? launchId).padStart(2, "0")}:00.000Z`,
    endedAt: null,
    duration: 1000 + launchId,
    codeRef: `tests/${name}.spec.ts#${name}`,
    retry: options.retry ?? false,
    issueType: options.issueType,
    attributes: [{ key: "browser", value: "chromium" }],
    externalIssueKeys: options.externalIssueKeys ?? [],
    linkedDefects: [],
    stableIdentity: {
      type: "codeRef",
      value: `tests/${name}.spec.ts#${name}`,
      key: `codeRef:tests/${name}.spec.ts#${name}`,
    },
  };
}

function entity(id, title, source) {
  return { id, type: "requirement", title, provenance: provenance(source, id) };
}

function provenance(source, sourceId) {
  return {
    source,
    sourceId,
    sourceVersion: "1",
    contentHash: `${source}-${sourceId}`,
    observedAt: "2026-09-14T00:00:00.000Z",
    normalizerId: `${source}-normalizer`,
    normalizerVersion: "1",
  };
}
