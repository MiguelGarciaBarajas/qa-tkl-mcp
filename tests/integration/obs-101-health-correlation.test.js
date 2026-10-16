import test from "node:test";
import assert from "node:assert/strict";
import { JiraConnector } from "../../plugins/connectors/jira/src/index.js";
import { GitHubConnector } from "../../plugins/connectors/github/src/index.js";
import { TestRailConnector } from "../../plugins/connectors/testrail/src/index.js";
import { createHealthRegistry } from "../../packages/observability/src/index.js";
import { createApplication } from "../../apps/api/src/app.js";

/**
 * OBS-101: correlates the *real* per-connector `health()` shape (ING-106) --
 * not a synthetic stand-in -- through `createHealthRegistry` into the API's
 * `GET /health`, and proves the registry's generic redaction actually
 * strips each connector's `credentialRef` before it ever reaches an
 * operator-facing response.
 */
test("correlates real Jira/GitHub/TestRail connector health into the API health response with credentials redacted", async () => {
  const jira = new JiraConnector({
    client: { fetchIssue: async () => ({ key: "STT-1", fields: { updated: "2026-01-01T00:00:00.000Z" } }), fetchComments: async () => [] },
    tenantId: "t1",
    productId: "fl-titling",
    credentialRef: "secret://jira-prod-token",
    issueKey: "STT-1",
  });
  const github = new GitHubConnector({
    client: { fetchPullRequests: async () => [], fetchChangedFiles: async () => [] },
    tenantId: "t1",
    productId: "fl-titling",
    credentialRef: "secret://github-prod-token",
    repository: "example/repo",
  });
  const testrail = new TestRailConnector({
    client: { fetchSuites: async () => [{ id: 1, name: "Suite" }], fetchCases: async () => [], fetchRuns: async () => [], fetchResults: async () => [] },
    tenantId: "t1",
    productId: "fl-titling",
    credentialRef: "secret://testrail-prod-token",
    projectId: 1,
    suiteIds: [1],
    baseUrl: "https://testrail.example.com",
  });

  // Exercise each connector so `records`/`lastSyncAt` are populated, mirroring
  // what a real scheduled sync (OPS-101) would have already done before health
  // is reported.
  await Array.fromAsync(jira.collect());
  await Array.fromAsync(github.collect());
  await Array.fromAsync(testrail.collect());

  const healthRegistry = createHealthRegistry({ correlationId: "obs-101-correlation" });
  healthRegistry.record("jira-connector", await jira.health());
  healthRegistry.record("github-connector", await github.health());
  healthRegistry.record("testrail-connector", await testrail.health());

  const application = createApplication({ healthRegistry });
  const response = await application.handle({
    method: "GET",
    pathname: "/health",
    url: new URL("http://localhost/health"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.dependencies.correlationId, "obs-101-correlation");
  assert.equal(response.body.dependencies.status, "healthy");
  assert.equal(response.body.dependencies.components.length, 3);

  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes("secret://"), false);

  for (const component of response.body.dependencies.components) {
    assert.equal(component.credentialRef, "[REDACTED]");
    assert.ok(component.checkedAt);
  }

  const jiraComponent = response.body.dependencies.components.find(
    (entry) => entry.component === "jira-connector",
  );
  assert.equal(jiraComponent.status, "healthy");
  assert.equal(jiraComponent.records, 1);

  const testrailComponent = response.body.dependencies.components.find(
    (entry) => entry.component === "testrail-connector",
  );
  assert.equal(testrailComponent.status, "healthy");
  assert.equal(testrailComponent.records, 1);
});

test("surfaces a connector failure as a degraded correlated health status without leaking the raw error", async () => {
  const failingJira = new JiraConnector({
    client: {
      fetchIssue: async () => {
        const error = new Error("permanent failure: invalid Jira API token for tenant t1");
        error.status = 400;
        throw error;
      },
    },
    tenantId: "t1",
    productId: "fl-titling",
    credentialRef: "secret://jira-prod-token",
    issueKey: "STT-1",
    maxRetries: 0,
  });

  await assert.rejects(() => Array.fromAsync(failingJira.collect()));

  const healthRegistry = createHealthRegistry({ correlationId: "obs-101-degraded" });
  healthRegistry.record("jira-connector", await failingJira.health());

  const application = createApplication({ healthRegistry });
  const response = await application.handle({
    method: "GET",
    pathname: "/health",
    url: new URL("http://localhost/health"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.dependencies.status, "degraded");
  const [component] = response.body.dependencies.components;
  assert.equal(component.status, "degraded");
  assert.equal(component.credentialRef, "[REDACTED]");
  assert.equal(JSON.stringify(response.body).includes("invalid Jira API token"), false);
});
