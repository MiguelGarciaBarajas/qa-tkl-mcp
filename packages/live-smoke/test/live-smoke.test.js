import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvCredentialResolver,
  credentialEnvVarName,
  runLiveSmoke,
} from "../src/index.js";

const CONFIGURATION = Object.freeze({
  configVersion: "0.1",
  tenantId: "solera",
  productId: "fl-titling",
  enabledPlugins: ["connector.github"],
  plannedPlugins: ["connector.jira", "connector.testrail"],
  credentialRefs: {
    "connector.jira": "secret://jira/fl-titling",
    "connector.github": "secret://github/fl-titling",
    "connector.testrail": "secret://testrail/fl-titling",
  },
  sources: {
    jira: { enabled: false, configurationStatus: "pending-external-input", baseUrl: "https://jira.example.com" },
    github: { enabled: true, configurationStatus: "ready", repository: "solera-engineering/fl-titling" },
    testrail: {
      enabled: false,
      configurationStatus: "pending-external-input",
      baseUrlEnv: "TESTRAIL_BASE_URL",
      projectIdEnv: "TESTRAIL_PROJECT_ID",
      suiteIdsEnv: "TESTRAIL_SUITE_IDS",
    },
  },
});

function fakeGitHubFetch(pullRequestBody) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(pullRequestBody),
  });
}

test("credentialEnvVarName follows a predictable, documented convention", () => {
  assert.equal(credentialEnvVarName("github"), "LIVE_SMOKE_GITHUB_TOKEN");
  assert.equal(credentialEnvVarName("jira"), "LIVE_SMOKE_JIRA_TOKEN");
  assert.equal(credentialEnvVarName("testrail"), "LIVE_SMOKE_TESTRAIL_TOKEN");
  assert.equal(credentialEnvVarName("confluence"), "LIVE_SMOKE_CONFLUENCE_TOKEN");
  assert.equal(credentialEnvVarName("reportportal"), "LIVE_SMOKE_REPORTPORTAL_TOKEN");
});

test("createEnvCredentialResolver fails closed, naming the missing environment variable, rather than fabricating a credential", async () => {
  const resolve = createEnvCredentialResolver({});
  await assert.rejects(
    () => resolve("secret://github/fl-titling"),
    /LIVE_SMOKE_GITHUB_TOKEN.*not set/s,
  );
});

test("createEnvCredentialResolver resolves a real, trimmed value from the environment", async () => {
  const resolve = createEnvCredentialResolver({ LIVE_SMOKE_GITHUB_TOKEN: "  a-real-token  " });
  assert.equal(await resolve("secret://github/fl-titling"), "a-real-token");
});

test("runLiveSmoke skips sources that are not yet enabled/approved, without attempting them", async () => {
  const report = await runLiveSmoke({
    configuration: CONFIGURATION,
    env: { LIVE_SMOKE_GITHUB_TOKEN: "token" },
    fetchImpl: fakeGitHubFetch([]),
  });
  const jira = report.results.find((result) => result.source === "jira");
  const testrail = report.results.find((result) => result.source === "testrail");
  assert.deepEqual(jira, { source: "jira", status: "skipped", reason: "pending-external-input" });
  assert.deepEqual(testrail, { source: "testrail", status: "skipped", reason: "pending-external-input" });
});

test("runLiveSmoke fails closed for an enabled source with no resolvable credential, naming the missing variable", async () => {
  const report = await runLiveSmoke({
    configuration: CONFIGURATION,
    env: {},
    fetchImpl: fakeGitHubFetch([]),
  });
  const github = report.results.find((result) => result.source === "github");
  assert.equal(github.status, "blocked");
  assert.match(github.reason, /LIVE_SMOKE_GITHUB_TOKEN/);
  assert.doesNotMatch(github.reason, /token-for|super-secret/);
});

test("runLiveSmoke performs one bounded, sanitized read against an enabled source and never leaks the credential or payload", async () => {
  const report = await runLiveSmoke({
    configuration: CONFIGURATION,
    env: { LIVE_SMOKE_GITHUB_TOKEN: "super-secret-value" },
    fetchImpl: fakeGitHubFetch([{ number: 42, title: "should never appear in the report", updated_at: "2024-01-01T00:00:00Z" }]),
  });
  const github = report.results.find((result) => result.source === "github");
  assert.equal(github.status, "ok");
  assert.equal(github.recordsSampled, 1);
  assert.equal(github.health.pluginId, "connector.github");
  assert.equal(github.health.status, "healthy");

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.doesNotMatch(serialized, /should never appear in the report/);
});

test("runLiveSmoke reports no records sampled, without error, when a live source legitimately has none yet", async () => {
  const report = await runLiveSmoke({
    configuration: CONFIGURATION,
    env: { LIVE_SMOKE_GITHUB_TOKEN: "token" },
    fetchImpl: fakeGitHubFetch([]),
  });
  const github = report.results.find((result) => result.source === "github");
  assert.equal(github.status, "ok");
  assert.equal(github.recordsSampled, 0);
});
