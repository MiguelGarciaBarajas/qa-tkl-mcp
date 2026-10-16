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

test("indexes GitHub changed-file evidence for Jira-linked automation design", async () => {
  const service = createKnowledgeService({ createStoreOnRead: true });
  const ingestion = await service.ingest([
    {
      ...baseEvidence,
      source: "jira",
      sourceId: "STT-100",
      contentType: "jira.issue",
      contentHash: "jira-100",
      payload: {
        key: "STT-100",
        summary: "Validate VIN",
        acceptanceCriteria: ["A valid VIN is accepted."],
      },
    },
    {
      ...baseEvidence,
      source: "github",
      sourceId: "org/repo#7",
      contentType: "github.pull_request",
      contentHash: "github-pr-7",
      payload: {
        number: 7,
        title: "Automate VIN validation",
        ticketKey: "STT-100",
      },
    },
    {
      ...baseEvidence,
      source: "github",
      sourceId: "org/repo#7:tests/e2e/vin.spec.ts",
      contentType: "github.changed_file",
      contentHash: "github-file-1",
      payload: { filename: "tests/e2e/vin.spec.ts", status: "modified" },
    },
    {
      ...baseEvidence,
      source: "github",
      sourceId: "org/repo#8:tests/pages/vin.page.ts",
      contentType: "github.changed_file",
      contentHash: "github-file-2",
      payload: { filename: "tests/pages/vin.page.ts", status: "added" },
    },
    {
      ...baseEvidence,
      source: "testrail",
      sourceId: "42",
      contentType: "testrail.case",
      contentHash: "testrail-42",
      payload: {
        id: 42,
        suite_id: 1,
        title: "Submit a valid VIN",
        custom_jira_references: ["STT-100"],
        custom_steps_separated: [{
          content: "Submit a valid VIN.",
          expected: "The application is accepted.",
        }],
      },
    },
  ]);

  assert.equal(ingestion.ingestedRecords, 3);
  assert.equal(ingestion.indexedRecords.length, 2);
  assert.equal(ingestion.ignoredRecords.length, 0);

  const context = await service.getAutomationDesignContext({
    productId: "fl-titling",
    workItemId: "STT-100",
  });

  assert.deepEqual(context.githubAutomation.map((item) => item.id), ["test:github:7"]);
  assert.deepEqual(context.manualCaseContexts.map((item) => item.testCase.id), [
    "manual-test:testrail:42",
  ]);
  assert.deepEqual(context.scopeRepositoryFiles.map((item) => item.path), [
    "tests/e2e/vin.spec.ts",
  ]);
  assert.deepEqual(context.repositoryFiles.map((item) => item.path), [
    "tests/e2e/vin.spec.ts",
    "tests/pages/vin.page.ts",
  ]);
  assert.equal(context.repositoryContentCollected, false);
});
