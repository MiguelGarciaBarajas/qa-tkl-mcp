import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeService } from "../src/knowledge-service.js";

const baseEvidence = {
  tenantId: "solera",
  productId: "fl-titling",
  sourceVersion: "1",
  observedAt: "2026-09-14T00:00:00.000Z",
  classification: "internal",
};

test("TestRail improvement context returns linked case fields and the comparison library", async () => {
  const service = createKnowledgeService({ createStoreOnRead: true });
  await service.ingest([
    {
      ...baseEvidence,
      source: "jira",
      sourceId: "STT-100",
      contentType: "jira.issue",
      contentHash: "jira-STT-100",
      payload: { key: "STT-100", summary: "Validate a title application" },
    },
    testRailCase(42, "Validate a title application", ["STT-100"]),
    testRailCase(43, "Duplicate title application intent", []),
  ]);

  const context = await service.getTestRailImprovementContext({
    productId: "fl-titling",
    workItemId: "STT-100",
  });

  assert.equal(context.caseContexts.length, 1);
  assert.equal(context.caseContexts[0].testCase.id, "manual-test:testrail:42");
  assert.deepEqual(context.caseContexts[0].requirementIds, ["requirement:STT-100"]);
  assert.deepEqual(
    context.caseContexts[0].claims
      .filter((claim) => claim.attribute.startsWith("custom_"))
      .map((claim) => claim.attribute),
    ["custom_preconds", "custom_steps_separated", "custom_jira_references"],
  );
  assert.deepEqual(
    context.allManualTestContexts.map(({ testCase }) => testCase.id).sort(),
    ["manual-test:testrail:42", "manual-test:testrail:43"],
  );
});

function testRailCase(id, title, jiraReferences) {
  return {
    ...baseEvidence,
    source: "testrail",
    sourceId: String(id),
    contentType: "testrail.case",
    contentHash: `testrail-${id}`,
    payload: {
      id,
      title,
      custom_jira_references: jiraReferences,
      custom_preconds: "A synchronized application exists.",
      custom_steps_separated: [{
        content: "Open the application.",
        expected: "The application is displayed.",
      }],
    },
  };
}
