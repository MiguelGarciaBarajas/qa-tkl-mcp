import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/app.js";
import { createKnowledgeService } from "../src/knowledge-service.js";

const base = {
  tenantId: "solera",
  productId: "fl-titling",
  sourceVersion: "1",
  observedAt: "2026-09-14T00:00:00.000Z",
  classification: "internal",
};

test("builds scoped ReportPortal history by codeRef and explicit Jira defect links", async () => {
  const service = createKnowledgeService({ createStoreOnRead: true });
  const records = [
    jira("STT-100", "Story", "Validate title workflow"),
    jira("BUG-1", "Bug", "Title submission intermittently fails"),
    githubPullRequest(),
    githubFile(),
    ...[
      item("9001", "501", "FAILED", ["BUG-1"]),
      item("9002", "502", "PASSED"),
      item("9003", "503", "FAILED"),
      item("9004", "505", "PASSED"),
      item("9999", "504", "FAILED", [], "other/unrelated.spec.ts#unrelated"),
    ],
  ];
  for (const launchId of ["501", "502", "503", "504", "505"]) {
    records.push(launch(launchId));
  }
  await service.ingest(records);

  const context = await service.getReliabilityIntelligenceContext({
    productId: "fl-titling",
    workItemId: "STT-100",
  });

  assert.deepEqual(
    context.executionContexts.map((itemContext) => itemContext.execution.id),
    [
      "test-execution:reportportal:item:9001",
      "test-execution:reportportal:item:9002",
      "test-execution:reportportal:item:9003",
      "test-execution:reportportal:item:9004",
    ],
  );
  assert.ok(context.executionContexts.every((itemContext) =>
    itemContext.stableIdentity.type === "codeRef"));
  assert.deepEqual(context.jiraDefects.map(({ entity }) => entity.id), ["requirement:BUG-1"]);
  assert.equal(context.matchedIdentityCount, 1);

  const response = await createApplication({ knowledgeService: service }).handle({
    method: "POST",
    pathname: "/v1/agents/reliability-defect-intelligence/runs",
    url: new URL(
      "/v1/agents/reliability-defect-intelligence/runs?productId=fl-titling",
      "http://localhost",
    ),
    body: { workItemId: "STT-100" },
    authContext: {
      subject: "test-user",
      tenantId: "solera",
      roles: ["reader"],
      permissions: ["coverage:read"],
      productIds: ["fl-titling"],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.analyses[0].classification, "likely-flaky");
  assert.equal(response.body.analyses[0].aggregates.independentRuns, 4);
  assert.equal(response.body.analyses[0].linkedJiraDefects[0].id, "requirement:BUG-1");
});

function jira(key, issueType, summary) {
  return {
    ...base,
    source: "jira",
    sourceId: key,
    contentType: "jira.issue",
    contentHash: `jira-${key}`,
    payload: { key, summary, issueType },
  };
}

function githubPullRequest() {
  return {
    ...base,
    source: "github",
    sourceId: "org/repo#7",
    contentType: "github.pull_request",
    contentHash: "github-pr-7",
    payload: { number: 7, title: "Automate title workflow", ticketKey: "STT-100" },
  };
}

function githubFile() {
  return {
    ...base,
    source: "github",
    sourceId: "org/repo#7:tests/title.spec.ts",
    contentType: "github.changed_file",
    contentHash: "github-file-7",
    payload: { filename: "tests/title.spec.ts", status: "modified" },
  };
}

function launch(id) {
  return {
    ...base,
    source: "reportportal",
    sourceId: id,
    sourceVersion: id,
    contentType: "reportportal.launch",
    contentHash: `launch-${id}`,
    payload: {
      id: Number(id),
      name: `Regression ${id}`,
      status: "FAILED",
      startTime: Date.parse(`2026-09-${String(Number(id) - 490).padStart(2, "0")}T00:00:00Z`),
    },
  };
}

function item(id, launchId, status, externalIssueKeys = [], codeRef = "tests/title.spec.ts#submits title") {
  return {
    ...base,
    source: "reportportal",
    sourceId: id,
    sourceVersion: id,
    contentType: "reportportal.test_item",
    contentHash: `item-${id}`,
    payload: {
      id: Number(id),
      name: codeRef.split("#").at(-1),
      launchId: Number(launchId),
      status,
      startTime: Date.parse(`2026-09-${String(Number(launchId) - 490).padStart(2, "0")}T00:01:00Z`),
      codeRef,
      retry: false,
      ...(externalIssueKeys.length > 0
        ? {
            issue: {
              issueType: "PB001",
              externalSystemIssues: externalIssueKeys.map((ticketId) => ({
                ticketId,
                btsProjectId: "FLT",
              })),
            },
          }
        : {}),
    },
  };
}
