import test from "node:test";
import assert from "node:assert/strict";
import jiraFixture from "../fixtures/stt-3731-jira.json" with { type: "json" };
import testrailKnowledgeFixture from "../fixtures/testrail/case-traceability.json" with { type: "json" };
import testrailExecutionFixture from "../fixtures/testrail/execution-normalization.json" with { type: "json" };
import { composeConnectors } from "../../packages/ingestion/src/index.js";
import { InMemoryRawEvidenceStore } from "../../packages/raw-evidence-store/src/index.ts";
import { JiraNormalizer } from "../../plugins/normalizers/jira/src/index.js";
import { GitHubNormalizer } from "../../plugins/normalizers/github/src/index.js";
import { TestRailNormalizer } from "../../plugins/normalizers/testrail/src/index.js";
import { createKnowledgeService } from "../../apps/api/src/knowledge-service.js";
import { createApplication } from "../../apps/api/src/app.js";
import {
  createApplicationApiClient,
  createGateway,
} from "../../apps/mcp-gateway/src/index.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const AUTHORIZATION = "Bearer fixture-token";
const AUTH_CONTEXT = {
  subject: "integration-user",
  tenantId: TENANT_ID,
  roles: ["reader"],
  permissions: [
    "knowledge:read",
    "coverage:read",
    "traceability:read",
    "conflicts:read",
  ],
  productIds: [PRODUCT_ID],
};
const silentAuditLogger = { async record() {} };

function productConfiguration() {
  return {
    configVersion: "0.1",
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    enabledPlugins: [
      "connector.jira",
      "connector.github",
      "connector.testrail",
    ],
    plannedPlugins: [],
    credentialRefs: {
      "connector.jira": "secret://fixtures/jira",
      "connector.github": "secret://fixtures/github",
      "connector.testrail": "secret://fixtures/testrail",
    },
    sources: {
      jira: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://jira.example.test",
        allowedProjects: ["STT"],
        allowedJql: ["key = STT-3731"],
        issueKey: "STT-3731",
      },
      github: {
        enabled: true,
        configurationStatus: "ready",
        repository: "example/tkl-tests",
      },
      testrail: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://testrail.example.test",
        projectId: "128",
        suiteIds: ["12"],
      },
    },
  };
}

function connectorDependencies() {
  const testCase = {
    ...testrailKnowledgeFixture.case.payload,
    custom_jira_references: ["STT-3731"],
    custom_github_automation: ["test:github:7"],
  };
  const suite = { id: 12, name: "Sanitized title workflow regression", updated_on: 1789056000 };

  return {
    "connector.jira": {
      client: {
        fetchIssue: async () => jiraFixture.issue,
        fetchComments: async () => jiraFixture.comments,
      },
    },
    "connector.github": {
      client: {
        fetchPullRequests: async () => [{
          number: 7,
          title: "Automate STT-3731 title workflow",
          updatedAt: "2026-09-10T16:00:00.000Z",
          ticketKey: "STT-3731",
        }],
        fetchChangedFiles: async () => [{
          filename: "tests/title-workflow.spec.ts",
        }],
      },
    },
    "connector.testrail": {
      client: {
        fetchSuites: async () => [suite],
        fetchCases: async () => [testCase],
        fetchRuns: async () => [testrailExecutionFixture.run.payload],
        fetchResults: async () => [{
          ...testrailExecutionFixture.result.payload,
          case_id: 1202,
        }],
      },
    },
  };
}

function createApplicationFetch(application) {
  return async (input, options = {}) => {
    assert.equal(options.headers?.authorization, AUTHORIZATION);
    const url = input instanceof URL ? input : new URL(input);
    const response = await application.handle({
      method: options.method ?? "GET",
      pathname: url.pathname,
      url,
      authContext: AUTH_CONTEXT,
      correlationId: "int-101-api",
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

test("INT-101 carries Jira, GitHub, and TestRail fixtures through evidence, knowledge, API, and MCP", async () => {
  const composition = composeConnectors({
    configuration: productConfiguration(),
    dependencies: connectorDependencies(),
  });
  const rawEvidenceStore = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
  });

  for (const { pluginId, instance } of composition.listPlugins()) {
    const records = await Array.fromAsync(instance.collect());
    const health = await instance.health();
    await rawEvidenceStore.commit({
      connectorId: pluginId,
      records,
      checkpoint: health.lastCheckpoint,
    });
  }

  const rawRecords = rawEvidenceStore.listRecords();
  assert.deepEqual(
    [...new Set(rawRecords.map((record) => record.source))].sort(),
    ["github", "jira", "testrail"],
  );
  assert.equal(rawEvidenceStore.history().length, 3);

  const knowledgeService = createKnowledgeService({
    tenantId: TENANT_ID,
    normalizers: [
      new JiraNormalizer(),
      new GitHubNormalizer(),
      new TestRailNormalizer({
        jiraReferenceField: "custom_jira_references",
        githubAutomationReferenceField: "custom_github_automation",
      }),
    ],
  });
  const ingestion = await knowledgeService.ingest(rawRecords);
  assert.equal(ingestion.ingestedRecords, 6);
  assert.equal(ingestion.indexedRecords.length, 1);
  assert.equal(ingestion.ignoredRecords.length, 1);
  assert.deepEqual(ingestion.unresolvedLinks, []);

  const application = createApplication({
    knowledgeService,
    auditLogger: silentAuditLogger,
  });
  const gateway = createGateway({
    applicationClient: createApplicationApiClient({
      baseUrl: "http://tkl-api.example.test",
      authorization: AUTHORIZATION,
      fetchImplementation: createApplicationFetch(application),
    }),
    auditLogger: silentAuditLogger,
  });
  const requestContext = {
    subject: AUTH_CONTEXT.subject,
    authorization: AUTHORIZATION,
    correlationId: "int-101-mcp",
  };

  const contextResult = await gateway.handle({
    method: "tools/call",
    params: {
      name: "get_story_test_context",
      arguments: { productId: PRODUCT_ID, storyId: "STT-3731" },
    },
  }, requestContext);
  const context = contextResult.structuredContent;
  assert.deepEqual(context.requirements.map((entity) => entity.id), ["requirement:STT-3731"]);
  assert.deepEqual(
    context.tests.map((entity) => entity.id).sort(),
    [
      "manual-test:testrail:1202",
      "test:github:7",
    ],
  );
  assert.deepEqual(
    [...new Set(context.provenance.map((entry) => entry.source))].sort(),
    ["github", "jira", "testrail"],
  );

  const traceabilityResult = await gateway.handle({
    method: "tools/call",
    params: {
      name: "explain_traceability",
      arguments: { productId: PRODUCT_ID, requirementId: "STT-3731" },
    },
  }, requestContext);
  assert.deepEqual(
    traceabilityResult.structuredContent.relationships
      .filter((link) => link.type === "verifies")
      .map((link) => link.fromEntityId)
      .sort(),
    ["manual-test:testrail:1202", "test:github:7"],
  );

  const coverageResult = await gateway.handle({
    method: "tools/call",
    params: {
      name: "analyze_requirement_coverage",
      arguments: { productId: PRODUCT_ID, requirementId: "STT-3731" },
    },
  }, requestContext);
  const [coverage] = coverageResult.structuredContent.findings;
  assert.equal(coverage.manualCoverage.ratio, 1);
  assert.equal(coverage.automatedCoverage.ratio, 1);

  const resourceResult = await gateway.handle({
    method: "resources/read",
    params: {
      uri: "tkl://products/fl-titling/requirements/STT-3731",
    },
  }, requestContext);
  assert.equal(resourceResult.structuredContent.contents.length, 1);

  const serializedResults = JSON.stringify({
    contextResult,
    traceabilityResult,
    coverageResult,
    resourceResult,
  });
  assert.equal(serializedResults.includes("secret://"), false);
  assert.equal(serializedResults.includes("fixture-token"), false);
});
