import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/app.js";
import { createKnowledgeService } from "../src/knowledge-service.js";

const base = {
  tenantId: "solera",
  productId: "fl-titling",
  observedAt: "2026-01-01T00:00:00.000Z",
  classification: "internal",
};

test("curates only the requested Jira hierarchy and never mutates canonical knowledge", async () => {
  const service = createKnowledgeService({ createStoreOnRead: true });
  await service.ingest([
    jira("STT-100", "Epic", "Title submission", { version: "1" }),
    jira("STT-101", "Story", "Submit a valid title application", {
      parentKey: "STT-100",
      acceptanceCriteria: ["Display confirmation after a valid title submission"],
      version: "1",
    }),
    jira("STT-102", "Sub-task", "Persist the valid title submission", {
      parentKey: "STT-101",
      version: "1",
    }),
    jira("STT-999", "Story", "Unrelated vehicle lookup", { version: "1" }),
    suite(1),
    testCase(42, "Confirm successful valid title submission", ["STT-101"]),
    testCase(43, "Display confirmation after valid title submission", []),
  ]);
  await service.ingest([{
    ...jira("STT-555", "Story", "Other product title submission", { version: "1" }),
    productId: "other-product",
  }]);

  const context = await service.getKnowledgeCurationContext({
    productId: "fl-titling",
    workItemId: "STT-100",
  });

  assert.deepEqual(context.scopeRequirementIds, [
    "requirement:STT-100",
    "requirement:STT-101",
    "requirement:STT-102",
  ]);
  assert.ok(context.scopedEntities.some((entity) => entity.id === "manual-test:testrail:42"));
  assert.ok(!context.scopedEntities.some((entity) => entity.id === "requirement:STT-999"));
  assert.ok(!context.candidateEntities.some((entity) => entity.id === "requirement:STT-555"));
  assert.ok(context.candidateEntities.some((entity) => entity.id === "manual-test:testrail:43"));

  const store = service.getStore("fl-titling");
  const before = {
    entities: store.listEntities("fl-titling"),
    claims: store.listClaims(),
    links: store.listTraceLinks(),
    conflicts: store.listOpenConflicts(),
    reviews: store.listReviews(),
  };
  const response = await createApplication({ knowledgeService: service }).handle({
    method: "POST",
    pathname: "/v1/agents/knowledge-curator/runs",
    url: new URL(
      "/v1/agents/knowledge-curator/runs?productId=fl-titling",
      "http://localhost",
    ),
    body: { workItemId: "STT-100" },
    authContext: {
      subject: "knowledge-reader",
      tenantId: "solera",
      roles: ["reader"],
      permissions: ["conflicts:read"],
      productIds: ["fl-titling"],
    },
  });
  const after = {
    entities: store.listEntities("fl-titling"),
    claims: store.listClaims(),
    links: store.listTraceLinks(),
    conflicts: store.listOpenConflicts(),
    reviews: store.listReviews(),
  };

  assert.equal(response.status, 200);
  assert.equal(response.body.agent.id, "agent.knowledge-curator");
  assert.ok(response.body.findings.some((finding) =>
    finding.category === "missing-trace-link"
    && finding.entityIds.includes("manual-test:testrail:43")));
  assert.ok(response.body.findings.every((finding) =>
    !finding.entityIds.includes("requirement:STT-999")));
  assert.deepEqual(after, before);
});

function jira(key, issueType, summary, options) {
  return {
    ...base,
    source: "jira",
    sourceId: key,
    sourceVersion: options.version,
    contentType: "jira.issue",
    contentHash: `jira-${key}-${options.version}`,
    payload: {
      key,
      summary,
      issueType,
      parentKey: options.parentKey,
      acceptanceCriteria: options.acceptanceCriteria,
    },
  };
}

function suite(id) {
  return {
    ...base,
    source: "testrail",
    sourceId: String(id),
    sourceVersion: "1",
    contentType: "testrail.suite",
    contentHash: `suite-${id}`,
    payload: { id, name: "Regression" },
  };
}

function testCase(id, title, jiraReferences) {
  return {
    ...base,
    source: "testrail",
    sourceId: String(id),
    sourceVersion: "1",
    contentType: "testrail.case",
    contentHash: `case-${id}`,
    payload: {
      id,
      suite_id: 1,
      title,
      custom_steps: "Submit a valid title application and display confirmation",
      custom_jira_references: jiraReferences,
    },
  };
}
