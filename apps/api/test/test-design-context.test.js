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

test("test design context uses the requested hierarchy and product-wide TestRail cases", async () => {
  const service = createKnowledgeService({ createStoreOnRead: true });
  await service.ingest([
    jiraIssue("STT-100", {
      summary: "Modernization epic",
      issueType: "Epic",
      acceptanceCriteria: ["Parent criterion"],
    }),
    jiraIssue("STT-101", {
      summary: "Validate VIN",
      parentKey: "STT-100",
      acceptanceCriteria: ["A valid VIN is accepted"],
    }),
    jiraIssue("STT-999", {
      summary: "Unrelated feature",
      acceptanceCriteria: ["Unrelated criterion"],
    }),
    {
      ...baseEvidence,
      source: "testrail",
      sourceId: "42",
      contentType: "testrail.case",
      contentHash: "testrail-case-42",
      payload: {
        id: 42,
        suite_id: 12,
        title: "Submit application with valid VIN",
      },
    },
  ]);

  const context = await service.getTestDesignContext({
    productId: "fl-titling",
    workItemId: "STT-100",
  });

  assert.deepEqual(
    context.requirementClaims
      .filter(({ claim }) => claim.attribute === "acceptanceCriteria")
      .map(({ requirement }) => requirement.id)
      .sort(),
    ["requirement:STT-100", "requirement:STT-101"],
  );
  assert.deepEqual(
    context.existingManualTests.map((item) => item.id),
    ["manual-test:testrail:42"],
  );
});

function jiraIssue(key, payload) {
  return {
    ...baseEvidence,
    source: "jira",
    sourceId: key,
    contentType: "jira.issue",
    contentHash: `jira-${key}`,
    payload: { key, ...payload },
  };
}
