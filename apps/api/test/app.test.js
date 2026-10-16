import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../src/app.js";
import { createKnowledgeService } from "../src/knowledge-service.js";
import { SecurityError } from "../../../packages/security/src/index.js";
import { createHealthRegistry } from "../../../packages/observability/src/index.js";

function request(application, method, path, options = {}) {
  return application.handle({
    method,
    pathname: new URL(path, "http://localhost").pathname,
    url: new URL(path, "http://localhost"),
    body: options.body,
    authContext:
      options.authContext !== undefined
        ? options.authContext
        : {
            subject: "test-user",
            tenantId: "solera",
            roles: ["reader"],
            permissions: [
              "knowledge:read",
              "ask:read",
              "coverage:read",
              "traceability:read",
              "conflicts:read",
              "conflicts:review"
            ],
            productIds: ["fl-titling"]
          }
  });
}

test("returns health status without requiring product context", async () => {
  const response = await request(createApplication(), "GET", "/health");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "tkl-api");
  assert.ok(response.body.correlationId);
  assert.deepEqual(response.body.dependencies, {
    correlationId: response.body.dependencies.correlationId,
    status: "unknown",
    components: []
  });
});

test("correlates registered dependency health into the API health response", async () => {
  const healthRegistry = createHealthRegistry({ correlationId: "health-correlation-1" });
  healthRegistry.record("jira-connector", { status: "healthy", records: 5 });

  const response = await request(createApplication({ healthRegistry }), "GET", "/health");

  assert.equal(response.status, 200);
  assert.equal(response.body.dependencies.correlationId, "health-correlation-1");
  assert.equal(response.body.dependencies.status, "healthy");
  assert.equal(response.body.dependencies.components[0].component, "jira-connector");
});

test("rejects knowledge searches without product isolation context", async () => {
  const response = await request(createApplication(), "GET", "/v1/knowledge/search");

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "productId");
});

test("serves bounded artifact resolution in the authenticated product", async () => {
  const received = [];
  const application = createApplication({
    artifactResolverService: {
      async resolve(request) {
        received.push(request);
        return {
          productId: request.productId,
          query: request.query,
          detected: {
            kind: "testrail-case-id",
            source: "testrail",
            lookupValue: "1201",
            exact: true,
          },
          status: "not-found",
          selected: null,
          candidates: [],
        };
      },
    },
  });

  test("runs TestRail improvement from an exact case ID without Jira scope", async () => {
    const received = [];
    const application = createApplication({
      testRailImprovementAgent: {
        async execute(request) {
          received.push(request);
          return {
            runId: "case-run",
            agent: { id: "agent.testrail-improvement", version: "0.1.0" },
            productId: request.productId,
            workItemId: `C${request.caseId}`,
            caseId: request.caseId,
            generatedAt: "2026-09-15T12:00:00.000Z",
            status: "ready-for-review",
            confidence: { level: "medium", rationale: "Exact case evidence." },
            summary: "One exact case inspected.",
            proposals: [],
            evidence: {
              sources: ["testrail"],
              requirements: [],
              manualTests: [],
              relationships: [],
              citations: [],
            },
            limitations: [],
          };
        },
      },
    });

    const response = await request(
      application,
      "POST",
      "/v1/agents/testrail-improvement/cases/C001201/runs?productId=fl-titling",
      { body: {} }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.caseId, "1201");
    assert.deepEqual(received, [{ productId: "fl-titling", caseId: "1201" }]);
  });

  const response = await request(
    application,
    "GET",
    "/v1/artifacts/resolve?productId=fl-titling&query=C1201&limit=8"
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.detected.kind, "testrail-case-id");
  assert.deepEqual(received, [{
    productId: "fl-titling",
    query: "C1201",
    limit: 8,
  }]);
});

test("rejects empty artifact resolution queries", async () => {
  const response = await request(
    createApplication(),
    "GET",
    "/v1/artifacts/resolve?productId=fl-titling"
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "query");
});

test("keeps agent behavior available when advisory cross-source enrichment fails", async () => {
  const application = createApplication({
    crossSourceContextCoordinator: {
      async enrich() {
        throw new Error("temporary enrichment failure");
      },
    },
    testRailImprovementAgent: {
      async execute(request) {
        return {
          runId: "case-run",
          agent: { id: "agent.testrail-improvement", version: "0.1.0" },
          productId: request.productId,
          workItemId: `C${request.caseId}`,
          caseId: request.caseId,
          generatedAt: "2026-09-15T12:00:00.000Z",
          status: "ready-for-review",
          confidence: { level: "low", rationale: "Local evidence only." },
          summary: "The local case was still inspected.",
          proposals: [],
          evidence: {
            sources: ["testrail"],
            requirements: [],
            manualTests: [],
            relationships: [],
            citations: [],
          },
          limitations: ["Cross-source evidence is temporarily unavailable."],
        };
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/testrail-improvement/cases/C1201/runs?productId=fl-titling",
    { body: {} },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.summary, "The local case was still inspected.");
});

test("serves bounded Intelligence views through one aggregate request", async () => {
  const received = {};
  const application = createApplication({
    knowledgeService: {
      async listStoryTraceability(request) {
        received.traceability = request;
        return { ...request, items: [] };
      },
      async listCoverageGaps(request) {
        received.coverage = request;
        return { ...request, items: [] };
      }
    }
  });

  const traceability = await request(
    application,
    "GET",
    "/v1/intelligence/traceability?productId=fl-titling&source=jira&query=STT-123&limit=8"
  );
  const coverage = await request(
    application,
    "GET",
    "/v1/intelligence/coverage?productId=fl-titling&source=jira&query=STT-123&limit=8"
  );

  assert.equal(traceability.status, 200);
  assert.equal(coverage.status, 200);
  assert.deepEqual(received.traceability, {
    productId: "fl-titling",
    source: "jira",
    query: "STT-123",
    limit: 8,
    offset: 0
  });
  assert.deepEqual(received.coverage, received.traceability);
});

test("serves repeatable golden-dataset evaluation metrics", async () => {
  const metrics = {
    datasetVersion: "golden-fl-titling-v1",
    ticketCount: 25,
    precision: 0.9,
    recall: 0.8,
    provenanceCompleteness: 1,
    freshnessHours: 2,
    latencyMsP50: 3,
    latencyMsP95: 8,
    qaAcceptanceRate: 0.75,
  };
  const application = createApplication({
    evaluationRunner: async () => ({ metrics, ticketResults: [], conflictDetection: {} }),
  });

  const response = await request(
    application,
    "GET",
    "/v1/evaluation/metrics?productId=fl-titling",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, metrics);
});

test("runs the Coverage and Context Agent through a validated audited endpoint", async () => {
  let received;
  const application = createApplication({
    coverageContextAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "run-1",
          agent: { id: "agent.coverage-context", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T00:00:00.000Z",
          status: "insufficient-context",
          confidence: { level: "low", rationale: "Jira only." },
          summary: "Jira context only.",
          findings: [],
          recommendations: [],
          evidence: { sources: [], requirements: [], tests: [], relationships: [], citations: [] },
          limitations: [],
        };
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/coverage-context/runs?productId=fl-titling",
    { body: { workItemId: "stt-3731" } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    productId: "fl-titling",
    workItemId: "STT-3731",
  });
  assert.equal(response.body.agent.id, "agent.coverage-context");
});

test("rejects invalid Coverage and Context Agent input", async () => {
  const response = await request(
    createApplication(),
    "POST",
    "/v1/agents/coverage-context/runs?productId=fl-titling",
    { body: { workItemId: "not a jira key" } },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "workItemId");
});

test("runs the Test Designer Agent through the proposal-only endpoint", async () => {
  let received;
  const application = createApplication({
    testDesignerAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "designer-run-1",
          agent: { id: "agent.test-designer", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T01:00:00.000Z",
          status: "ready-for-review",
          confidence: { level: "medium", rationale: "Acceptance criteria available." },
          summary: "One draft proposed.",
          proposals: [],
          evidence: { sources: ["jira"], requirements: [], existingManualTests: [], citations: [] },
          limitations: [],
        };
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/test-designer/runs?productId=fl-titling",
    { body: { workItemId: "STT-100" } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", workItemId: "STT-100" });
  assert.equal(response.body.agent.id, "agent.test-designer");
});

test("runs the TestRail Improvement Agent through an authorized audited proposal endpoint", async () => {
  let received;
  const events = [];
  const application = createApplication({
    testRailImprovementAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "improvement-run-1",
          agent: { id: "agent.testrail-improvement", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T02:00:00.000Z",
          status: "ready-for-review",
          confidence: { level: "medium", rationale: "Grounded case evidence available." },
          summary: "One TestRail edit proposed.",
          proposals: [],
          evidence: {
            sources: ["jira", "testrail"],
            requirements: [],
            manualTests: [],
            relationships: [],
            citations: [],
          },
          limitations: ["Proposal only."],
        };
      },
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/testrail-improvement/runs?productId=fl-titling",
    { body: { workItemId: "stt-100" } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", workItemId: "STT-100" });
  assert.equal(response.body.agent.id, "agent.testrail-improvement");
  assert.equal(events[0].operation, "run_testrail_improvement_agent");
  assert.equal(events[0].outcome, "success");
});

test("runs the Automation Designer through an authorized audited proposal endpoint", async () => {
  let received;
  const events = [];
  const application = createApplication({
    automationDesignerAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "automation-run-1",
          agent: { id: "agent.automation-designer", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T03:00:00.000Z",
          status: "ready-for-review",
          confidence: { level: "medium", rationale: "Repository paths are available." },
          summary: "One file-plan item proposed.",
          proposal: {
            delivery: "review-only",
            codeGeneration: { status: "abstained", rationale: "No file contents." },
            filePlan: [],
            codeOutline: [],
            reusableComponents: [],
            requiredTestData: [],
            validationCommands: [],
            conventions: {
              testDirectories: [],
              testFileSuffixes: [],
              fileExtensions: [],
              frameworkSignals: [],
            },
            discoveryTasks: [],
          },
          evidence: {
            sources: ["jira", "testrail", "github"],
            requirements: [],
            manualCases: [],
            automatedTests: [],
            repositoryFiles: [],
            citations: [],
          },
          limitations: ["Proposal only."],
        };
      },
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/automation-designer/runs?productId=fl-titling",
    { body: { workItemId: "stt-100" } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", workItemId: "STT-100" });
  assert.equal(response.body.agent.id, "agent.automation-designer");
  assert.equal(events[0].operation, "run_automation_designer_agent");
  assert.equal(events[0].outcome, "success");
});

test("requires coverage read permission for the Automation Designer", async () => {
  const application = createApplication({
    automationDesignerAgent: {
      async execute() {
        assert.fail("the agent must not run without coverage:read");
      },
    },
  });
  const response = await request(
    application,
    "POST",
    "/v1/agents/automation-designer/runs?productId=fl-titling",
    {
      body: { workItemId: "STT-100" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["knowledge:read"],
        productIds: ["fl-titling"],
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
});

test("runs Reliability and Defect Intelligence through an authorized audited endpoint", async () => {
  let received;
  const events = [];
  const application = createApplication({
    reliabilityDefectIntelligenceAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "reliability-run-1",
          agent: { id: "agent.reliability-defect-intelligence", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T04:00:00.000Z",
          status: "ready-for-review",
          confidence: { level: "medium", rationale: "Multi-run history is available." },
          summary: "One stable test identity was analyzed.",
          analyses: [],
          recommendations: [],
          evidence: {
            sources: ["jira", "reportportal"],
            requirements: [],
            reportPortalExecutions: [],
            jiraDefects: [],
            citations: [],
          },
          limitations: ["Proposal only."],
        };
      },
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/reliability-defect-intelligence/runs?productId=fl-titling",
    { body: { workItemId: "stt-100" } },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", workItemId: "STT-100" });
  assert.equal(response.body.agent.id, "agent.reliability-defect-intelligence");
  assert.equal(events[0].operation, "run_reliability_defect_intelligence_agent");
  assert.equal(events[0].outcome, "success");
});

test("requires coverage read permission for Reliability and Defect Intelligence", async () => {
  const application = createApplication({
    reliabilityDefectIntelligenceAgent: {
      async execute() {
        assert.fail("the agent must not run without coverage:read");
      },
    },
  });
  const response = await request(
    application,
    "POST",
    "/v1/agents/reliability-defect-intelligence/runs?productId=fl-titling",
    {
      body: { workItemId: "STT-100" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["knowledge:read"],
        productIds: ["fl-titling"],
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
});

test("runs Knowledge Curator through an authorized audited endpoint", async () => {
  let received;
  const events = [];
  const application = createApplication({
    knowledgeCuratorAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "curator-run-1",
          agent: { id: "agent.knowledge-curator", version: "0.1.0" },
          productId: request.productId,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T05:00:00.000Z",
          scope: {
            rootRequirementId: `requirement:${request.workItemId}`,
            requirementIds: [`requirement:${request.workItemId}`],
            productId: request.productId,
          },
          status: "ready-for-review",
          confidence: { level: "medium", rationale: "Scoped evidence is available." },
          summary: "One proposal is ready for review.",
          findings: [],
          proposals: [],
          evidence: {
            sources: ["jira"],
            requirements: [],
            entities: [],
            claims: [],
            traceLinks: [],
            openConflicts: [],
            unresolvedTraceLinks: [],
            citations: [],
          },
          limitations: ["Proposal only."],
          approval: { required: true, role: "knowledge-reviewer" },
        };
      },
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/knowledge-curator/runs?productId=fl-titling",
    {
      body: { workItemId: "stt-100" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["conflicts:read"],
        productIds: ["fl-titling"],
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", workItemId: "STT-100" });
  assert.equal(response.body.agent.id, "agent.knowledge-curator");
  assert.equal(events[0].operation, "run_knowledge_curator_agent");
  assert.equal(events[0].outcome, "success");
});

test("requires conflicts read permission for Knowledge Curator", async () => {
  const application = createApplication({
    knowledgeCuratorAgent: {
      async execute() {
        assert.fail("the agent must not run without conflicts:read");
      },
    },
  });
  const response = await request(
    application,
    "POST",
    "/v1/agents/knowledge-curator/runs?productId=fl-titling",
    {
      body: { workItemId: "STT-100" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["coverage:read"],
        productIds: ["fl-titling"],
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
});

test("requires coverage read permission for the TestRail Improvement Agent", async () => {
  const application = createApplication({
    testRailImprovementAgent: {
      async execute() {
        assert.fail("the agent must not run without coverage:read");
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/agents/testrail-improvement/runs?productId=fl-titling",
    {
      body: { workItemId: "STT-100" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["knowledge:read"],
        productIds: ["fl-titling"],
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
});

test("rejects unauthenticated application requests", async () => {
  const application = createApplication();
  const response = await application.handle({
    method: "GET",
    pathname: "/v1/knowledge/conflicts",
    url: new URL("/v1/knowledge/conflicts?productId=fl-titling", "http://localhost")
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "unauthenticated");
});

test("denies access to a product outside the auth context", async () => {
  const application = createApplication();
  const response = await application.handle({
    method: "GET",
    pathname: "/v1/knowledge/conflicts",
    url: new URL("/v1/knowledge/conflicts?productId=other-product", "http://localhost"),
    authContext: {
      subject: "test-user",
      roles: ["reader"],
      permissions: ["conflicts:read"],
      productIds: ["fl-titling"]
    }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "product_access_denied");
});

test("denies access when the authenticated tenant does not match the application tenant", async () => {
  const application = createApplication();
  const response = await application.handle({
    method: "GET",
    pathname: "/v1/knowledge/conflicts",
    url: new URL("/v1/knowledge/conflicts?productId=fl-titling", "http://localhost"),
    authContext: {
      subject: "test-user",
      tenantId: "other-tenant",
      roles: ["reader"],
      permissions: ["conflicts:read"],
      productIds: ["fl-titling"]
    }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "tenant_access_denied");
});

test("denies tenant-scoped API access when the authenticated identity omits its tenant", async () => {
  const application = createApplication();
  const response = await application.handle({
    method: "GET",
    pathname: "/v1/knowledge/conflicts",
    url: new URL("/v1/knowledge/conflicts?productId=fl-titling", "http://localhost"),
    authContext: {
      subject: "test-user",
      roles: ["reader"],
      permissions: ["conflicts:read"],
      productIds: ["fl-titling"]
    }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "tenant_access_denied");
});

test("passes validated search requests to the application service", async () => {
  let received;
  const application = createApplication({
    knowledgeService: {
      async search(request) {
        received = request;
        return {
          productId: request.productId,
          query: request.query,
          items: [],
          limit: request.limit
        };
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/knowledge/search?productId=fl-titling&query=acceptance&limit=5&offset=10"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    productId: "fl-titling",
    source: undefined,
    query: "acceptance",
    limit: 5,
    offset: 10
  });
});

test("lists source connections without exposing credential material", async () => {
    const application = createApplication({
      sourceConnectionService: {
        async list() {
          return [{
            source: "jira",
            status: "connected",
            configured: true,
            config: { baseUrl: "https://jira.example" }
          }];
        }
      }
    });
    const response = await request(
      application,
      "GET",
      "/v1/source-connections?productId=fl-titling",
      {
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:read"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.connections[0].source, "jira");
    assert.equal(JSON.stringify(response.body).includes("credential"), false);
});

test("saves a validated source connection and derives the owner from authentication", async () => {
    let received;
    const application = createApplication({
      sourceConnectionService: {
        async connect(request) {
          received = request;
          return { source: request.source, status: "connected", configured: true };
        }
      }
    });
    const response = await request(
      application,
      "PUT",
      "/v1/source-connections/github?productId=fl-titling",
      {
        body: {
          credential: "synthetic-token",
          config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] }
        },
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.equal(received.ownerSubject, "connection-owner");
    assert.equal(received.credential, "synthetic-token");
    assert.deepEqual(received.config.repositories, ["Solera-Engineering/qa-tkl-mcp-f5"]);
});

test("accepts project-wide TestRail scope without suite IDs", async () => {
    let received;
    const application = createApplication({
      sourceConnectionService: {
        async connect(request) {
          received = request;
          return { source: request.source, status: "connected", configured: true };
        }
      }
    });
    const response = await request(
      application,
      "PUT",
      "/v1/source-connections/testrail?productId=fl-titling",
      {
        body: {
          credential: "synthetic-token",
          config: {
            baseUrl: "https://testrail.example",
            username: "qa@example.com",
            projectId: "128",
            suiteScope: "all"
          }
        },
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.equal(received.config.suiteScope, "all");
    assert.equal("suiteIds" in received.config, false);
});

test("discovers TestRail suites before saving a connection", async () => {
    let received;
    const application = createApplication({
      sourceConnectionService: {
        async discoverTestRailSuites(request) {
          received = request;
          return [{ id: "4", name: "Regression", isCompleted: false }];
        }
      }
    });
    const response = await request(
      application,
      "POST",
      "/v1/source-connections/testrail/discover?productId=fl-titling",
      {
        body: {
          credential: "synthetic-token",
          config: {
            baseUrl: "https://testrail.example",
            username: "qa@example.com",
            projectId: "128"
          }
        },
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.equal(received.config.suiteScope, "all");
    assert.deepEqual(response.body.suites, [
      { id: "4", name: "Regression", isCompleted: false }
    ]);
});

test("discovers canonical Confluence root pages before saving a connection", async () => {
    let received;
    const application = createApplication({
      sourceConnectionService: {
        async discoverConfluencePages(request) {
          received = request;
          return {
            baseUrl: "https://confluence.example/wiki",
            roots: [{
              id: "42",
              title: "Product",
              spaceKey: "QA",
              url: "https://confluence.example/wiki/display/QA/Product"
            }]
          };
        }
      }
    });
    const response = await request(
      application,
      "POST",
      "/v1/source-connections/confluence/discover?productId=fl-titling",
      {
        body: {
          credential: "synthetic-token",
          config: {
            username: "qa@example.com",
            rootPageUrls: ["https://confluence.example/wiki/display/QA/Product"]
          }
        },
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(received.config.rootPageUrls, [
      "https://confluence.example/wiki/display/QA/Product"
    ]);
    assert.equal(received.config.authMode, "bearer");
    assert.equal(response.body.discovery.roots[0].id, "42");
});

test("requires the dedicated source connection permission", async () => {
    const response = await request(
      createApplication({ sourceConnectionService: { async list() { return []; } } }),
      "GET",
      "/v1/source-connections?productId=fl-titling"
    );

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "forbidden");
});

test("cancels a source sync with connections:sync and returns connection metadata", async () => {
    let received;
    let disconnectCalled = false;
    const application = createApplication({
      sourceConnectionService: {
        async cancelSync(request) {
          received = request;
          return {
            source: request.source,
            status: "error",
            configured: true,
            error: {
              code: "sync_cancelled",
              category: "internal",
              message: "The synchronization was cancelled."
            }
          };
        },
        async disconnect() {
          disconnectCalled = true;
        }
      }
    });

    const response = await request(
      application,
      "DELETE",
      "/v1/source-connections/github/sync?productId=fl-titling",
      {
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:sync"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(received, { productId: "fl-titling", source: "github" });
    assert.equal(response.body.connection.error.code, "sync_cancelled");
    assert.equal(disconnectCalled, false);
});

test("requires connections:sync to cancel a source sync", async () => {
    let cancelCalled = false;
    const response = await request(
      createApplication({
        sourceConnectionService: {
          async cancelSync() {
            cancelCalled = true;
          }
        }
      }),
      "DELETE",
      "/v1/source-connections/github/sync?productId=fl-titling",
      {
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "forbidden");
    assert.equal(cancelCalled, false);
});

test("rejects source-level broad synchronization in JIT-only mode", async () => {
  let syncCalled = false;
  const response = await request(
    createApplication({
      sourceConnectionService: {
        async sync() {
          syncCalled = true;
        }
      }
    }),
    "POST",
    "/v1/source-connections/jira/sync?productId=fl-titling",
    {
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:sync"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "broad_sync_disabled");
  assert.equal(syncCalled, false);
});

test("rejects unknown fields in source connection configuration", async () => {
    const response = await request(
      createApplication({ sourceConnectionService: {} }),
      "PUT",
      "/v1/source-connections/github?productId=fl-titling",
      {
        body: {
          credential: "synthetic-token",
          config: {
            repositories: ["Solera-Engineering/qa-tkl-mcp-f5"],
            token: "must-not-be-accepted-inside-config"
          }
        },
        authContext: {
          subject: "connection-owner",
          tenantId: "solera",
          roles: ["connection-owner"],
          permissions: ["connections:write"],
          productIds: ["fl-titling"]
        }
      }
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
    assert.equal(response.body.error.details.parameter, "config.token");
});

test("rejects a Jira project key used as the JQL filter", async () => {
  const response = await request(
    createApplication({ sourceConnectionService: {} }),
    "PUT",
    "/v1/source-connections/jira?productId=fl-titling",
    {
      body: {
        credential: "synthetic-token",
        config: {
          baseUrl: "https://jira.app.solera.com/jira",
          allowedProjects: ["STT"],
          allowedJql: "STT"
        }
      },
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:write"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "config.allowedJql");
});

test("accepts legacy multiple GitHub repositories for source connection migration", async () => {
  let received;
  const response = await request(
    createApplication({
      sourceConnectionService: {
        async connect(request) {
          received = request;
          return {
            source: "github",
            repositories: request.config.repositories
          };
        }
      }
    }),
    "PUT",
    "/v1/source-connections/github?productId=fl-titling",
    {
      body: {
        credential: "synthetic-token",
        config: { repositories: ["owner/one", "owner/two"] }
      },
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:write"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received.config.repositories, ["owner/one", "owner/two"]);
  assert.equal("credential" in response.body.connection, false);
});

test("rejects duplicate normalized GitHub repositories", async () => {
  const response = await request(
    createApplication({ sourceConnectionService: {} }),
    "PUT",
    "/v1/source-connections/github?productId=fl-titling",
    {
      body: {
        credential: "synthetic-token",
        config: { repositories: ["Owner/Repository", "owner/repository.git"] }
      },
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:write"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.details.parameter, "config.repositories");
});

test("normalizes a legacy single GitHub repository string", async () => {
  let repositories;
  const response = await request(
    createApplication({
      sourceConnectionService: {
        async connect(request) {
          repositories = request.config.repositories;
          return { source: "github" };
        }
      }
    }),
    "PUT",
    "/v1/source-connections/github?productId=fl-titling",
    {
      body: {
        credential: "synthetic-token",
        config: { repositories: "owner/repository" }
      },
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:write"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(repositories, ["owner/repository"]);
});

test("routes typed GitHub repository target CRUD with connection permissions", async () => {
  const received = [];
  const application = createApplication({
    sourceConnectionService: {
      async createGitHubRepository(request) {
        received.push(request);
        return { ...request.repository, validationStatus: "pending", syncStatus: "idle" };
      },
      async updateGitHubRepository(request) {
        received.push(request);
        return { id: request.repositoryId, ...request.changes };
      }
    }
  });
  const authContext = {
    subject: "connection-owner",
    tenantId: "solera",
    roles: ["connection-owner"],
    permissions: ["connections:write"],
    productIds: ["fl-titling"]
  };

  const created = await request(
    application,
    "POST",
    "/v1/source-connections/github/repositories?productId=fl-titling",
    {
      authContext,
      body: {
        id: "automation-tests",
        repository: "owner/automation-tests",
        purpose: "test-automation",
        lifecycle: "active",
        enabled: true
      }
    }
  );
  const updated = await request(
    application,
    "PATCH",
    "/v1/source-connections/github/repositories/automation-tests?productId=fl-titling",
    {
      authContext,
      body: { enabled: false }
    }
  );

  assert.equal(created.status, 201);
  assert.equal(updated.status, 200);
  assert.equal(received[0].repository.id, "automation-tests");
  assert.deepEqual(received[1], {
    productId: "fl-titling",
    repositoryId: "automation-tests",
    changes: { enabled: false }
  });
});

test("rejects secret-like and operational metadata in repository target writes", async () => {
  let called = false;
  const response = await request(
    createApplication({
      sourceConnectionService: {
        async createGitHubRepository() {
          called = true;
        }
      }
    }),
    "POST",
    "/v1/source-connections/github/repositories?productId=fl-titling",
    {
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:write"],
        productIds: ["fl-titling"]
      },
      body: {
        repository: "owner/repository",
        token: "must-not-be-accepted",
        recordsCollected: 99
      }
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "token");
  assert.equal(called, false);
});

test("requires connections:sync for repository sync and cancellation", async () => {
  let called = false;
  const application = createApplication({
    sourceConnectionService: {
      async syncGitHubRepository() {
        called = true;
      },
      async cancelGitHubRepositorySync() {
        called = true;
      }
    }
  });
  const authContext = {
    subject: "connection-owner",
    tenantId: "solera",
    roles: ["connection-owner"],
    permissions: ["connections:write"],
    productIds: ["fl-titling"]
  };

  const sync = await request(
    application,
    "POST",
    "/v1/source-connections/github/repositories/automation/sync?productId=fl-titling",
    { authContext }
  );
  const cancel = await request(
    application,
    "DELETE",
    "/v1/source-connections/github/repositories/automation/sync?productId=fl-titling",
    { authContext }
  );

  assert.equal(sync.status, 403);
  assert.equal(cancel.status, 403);
  assert.equal(called, false);
});

test("rejects repository synchronization in JIT-only mode", async () => {
  let syncCalled = false;
  const response = await request(
    createApplication({
      sourceConnectionService: {
        async syncGitHubRepository() {
          syncCalled = true;
        }
      }
    }),
    "POST",
    "/v1/source-connections/github/repositories/automation/sync?productId=fl-titling",
    {
      authContext: {
        subject: "connection-owner",
        tenantId: "solera",
        roles: ["connection-owner"],
        permissions: ["connections:sync"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "broad_sync_disabled");
  assert.equal(syncCalled, false);
});

test("rejects malformed search offsets", async () => {
  const response = await request(
    createApplication(),
    "GET",
    "/v1/knowledge/search?productId=fl-titling&offset=-1",
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "offset");
});

test("returns fixture knowledge through the real store, normalizers, and analyzers", async () => {
  let conflictAnalysisCalls = 0;
  const knowledgeService = createKnowledgeService({
    conflictAnalyzer: {
      async analyze() {
        conflictAnalysisCalls += 1;
        return [];
      },
    },
  });
  const ingestion = await knowledgeService.ingest([
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "github",
      sourceId: "42",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:01:00.000Z",
      contentType: "github.pull-request",
      contentHash: "github-fixture-hash",
      classification: "internal",
      payload: {
        number: 42,
        title: "Automate title application submission",
        ticketKey: "STT-4242",
      },
    },
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "STT-4242",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:00:00.000Z",
      contentType: "jira.issue",
      contentHash: "jira-fixture-hash",
      classification: "internal",
      payload: {
        key: "STT-4242",
        summary: "Submit a title application",
        acceptanceCriteria: ["The submitted application is persisted"],
      },
    },
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "comment-1",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:02:00.000Z",
      contentType: "jira.comment",
      contentHash: "jira-comment-fixture-hash",
      classification: "internal",
      payload: { issueKey: "STT-4242", body: "Sanitized comment" },
    },
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "github",
      sourceId: "42:tests/title.spec.ts",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:03:00.000Z",
      contentType: "github.changed_file",
      contentHash: "github-file-fixture-hash",
      classification: "internal",
      payload: { filename: "tests/title.spec.ts" },
    },
  ]);
  assert.deepEqual(ingestion, {
    ingestedRecords: 2,
    indexedRecords: [{
      source: "github",
      sourceId: "42:tests/title.spec.ts",
      contentType: "github.changed_file",
    }],
    ignoredRecords: [
      { source: "jira", sourceId: "comment-1", contentType: "jira.comment" },
    ],
    unresolvedLinks: [],
  });
  assert.equal(conflictAnalysisCalls, 2);
  const application = createApplication({ knowledgeService });

  const context = await request(
    application,
    "GET",
    "/v1/story/test-context?productId=fl-titling&storyId=STT-4242&source=jira",
  );
  assert.equal(context.status, 200);
  assert.deepEqual(context.body.requirements.map((entity) => entity.id), [
    "requirement:STT-4242",
  ]);
  assert.deepEqual(context.body.tests.map((entity) => entity.id), [
    "test:github:42",
  ]);
  assert.equal(context.body.provenance.length, 2);

  const coverage = await request(
    application,
    "GET",
    "/v1/requirements/coverage?productId=fl-titling&requirementId=STT-4242&source=jira",
  );
  assert.equal(coverage.status, 200);
  assert.deepEqual(coverage.body.findings, [{
    requirementId: "requirement:STT-4242",
    numerator: 1,
    denominator: 1,
    linkConfidence: 1,
    uncovered: [],
    policy: {
      version: "provisional-unconfigured",
      provisional: true,
    },
    manualCoverage: {
      status: "evaluated",
      basis: "requirement-link",
      numerator: 0,
      denominator: 1,
      ratio: 0,
      evidenceEntityIds: [],
    },
    automatedCoverage: {
      status: "evaluated",
      basis: "requirement-link",
      numerator: 1,
      denominator: 1,
      ratio: 1,
      evidenceEntityIds: ["test:github:42"],
    },
    executionFreshness: {
      status: "not-evaluated",
      numerator: 0,
      denominator: 1,
      ratio: null,
      coveredEntityIds: [],
      uncoveredEntityIds: ["test:github:42"],
      staleEntityIds: [],
      nonQualifyingEntityIds: [],
      missingExecutionEntityIds: ["test:github:42"],
      reason: "Execution status mapping and freshness policy are not configured",
    },
    combinedCoverage: {
      status: "not-evaluated",
      score: null,
      weights: null,
      reason: "Combined coverage weights or execution freshness policy are not configured",
    },
  }]);

  const aggregateTraceability = await request(
    application,
    "GET",
    "/v1/intelligence/traceability?productId=fl-titling&source=jira&query=STT-4242&limit=8",
  );
  assert.equal(aggregateTraceability.status, 200);
  assert.deepEqual(
    aggregateTraceability.body.items[0].tests.map((entity) => entity.id),
    ["test:github:42"],
  );

  const aggregateCoverage = await request(
    application,
    "GET",
    "/v1/intelligence/coverage?productId=fl-titling&source=jira&query=STT-4242&limit=8",
  );
  assert.equal(aggregateCoverage.status, 200);
  assert.equal(aggregateCoverage.body.items[0].finding.numerator, 1);

  const search = await request(
    application,
    "GET",
    "/v1/knowledge/search?productId=fl-titling&source=github&query=automate&limit=5",
  );
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.items.map((entity) => entity.id), ["test:github:42"]);

  const resourceUri = "tkl://products/fl-titling/requirements/STT-4242";
  const resource = await request(
    application,
    "GET",
    `/v1/resources/read?productId=fl-titling&uri=${encodeURIComponent(resourceUri)}`,
  );
  assert.equal(resource.status, 200);
  assert.equal(resource.body.contents.length, 1);
  assert.equal(
    JSON.parse(resource.body.contents[0].text).entity.id,
    "requirement:STT-4242",
  );

  const conflicts = await request(
    application,
    "GET",
    "/v1/knowledge/conflicts?productId=fl-titling",
  );
  assert.equal(conflicts.status, 200);
  assert.equal(conflictAnalysisCalls, 2);

  const githubCoverage = await request(
    application,
    "GET",
    "/v1/requirements/coverage?productId=fl-titling&requirementId=STT-4242&source=github",
  );
  assert.equal(githubCoverage.status, 200);
  assert.deepEqual(githubCoverage.body.findings, []);
  assert.deepEqual(githubCoverage.body.provenance, []);
});

test("expands an epic into Jira children and their cross-source test links", async () => {
  const knowledgeService = createKnowledgeService();
  await knowledgeService.ingest([
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "STT-3731",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:00:00.000Z",
      contentType: "jira.issue",
      contentHash: "epic-hash",
      classification: "internal",
      payload: {
        key: "STT-3731",
        summary: "FL Modernization",
        issueType: "Epic",
        status: "In Progress",
      },
    },
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "STT-5291",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:01:00.000Z",
      contentType: "jira.issue",
      contentHash: "child-hash",
      classification: "internal",
      payload: {
        key: "STT-5291",
        summary: "Billing total is empty",
        issueType: "Bug",
        status: "Resolved",
        parentKey: "STT-3731",
      },
    },
    {
      tenantId: "solera",
      productId: "fl-titling",
      source: "github",
      sourceId: "5291",
      sourceVersion: "1",
      observedAt: "2026-09-10T00:02:00.000Z",
      contentType: "github.pull-request",
      contentHash: "automation-hash",
      classification: "internal",
      payload: {
        number: 5291,
        title: "Cover billing total regression",
        ticketKey: "STT-5291",
      },
    },
  ]);

  const result = await knowledgeService.listStoryTraceability({
    productId: "fl-titling",
    source: "jira",
    query: "STT-3731",
    limit: 8,
    offset: 0,
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].context, {
    issueType: "Epic",
    status: "In Progress",
    relatedRequirementCount: 1,
    returnedRequirementCount: 1,
    truncated: false,
  });
  assert.deepEqual(
    result.items[0].requirements.map((entity) => entity.id).sort(),
    ["requirement:STT-3731", "requirement:STT-5291"],
  );
  assert.deepEqual(
    result.items[0].tests.map((entity) => entity.id),
    ["test:github:5291"],
  );

  const agentContext = await knowledgeService.getCoverageContext({
    productId: "fl-titling",
    workItemId: "STT-3731",
  });
  assert.equal(agentContext.coverageItems.length, 2);
  assert.equal(
    agentContext.coverageItems.find(
      (item) => item.requirement.id === "requirement:STT-5291",
    ).finding.numerator,
    1,
  );
});

test("isolates identical source IDs across products and rejects another tenant", async () => {
  const knowledgeService = createKnowledgeService({ tenantId: "solera" });
  const evidence = (productId, summary) => ({
    tenantId: "solera",
    productId,
    source: "jira",
    sourceId: "STT-5000",
    sourceVersion: "1",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: `${productId}-hash`,
    classification: "internal",
    payload: { key: "STT-5000", summary, acceptanceCriteria: [] },
  });

  await knowledgeService.ingest([
    evidence("fl-titling", "FL title workflow"),
    evidence("ga-titling", "GA title workflow"),
  ]);

  const flResult = await knowledgeService.search({
    productId: "fl-titling",
    query: "",
    limit: 20,
  });
  const gaResult = await knowledgeService.search({
    productId: "ga-titling",
    query: "",
    limit: 20,
  });
  assert.equal(flResult.items[0].title, "FL title workflow");
  assert.equal(gaResult.items[0].title, "GA title workflow");

  const emptyPage = await knowledgeService.search({
    productId: "fl-titling",
    query: "",
    limit: 20,
    offset: 1,
  });
  assert.deepEqual(emptyPage.items, []);
  assert.equal(emptyPage.offset, 1);

  await assert.rejects(
    knowledgeService.ingest([{
      ...evidence("fl-titling", "Wrong tenant"),
      tenantId: "another-tenant",
    }]),
    /Evidence tenant must match configured tenant "solera"/,
  );
});

test("resolves cross-source links when referenced evidence arrives in a later batch", async () => {
  const knowledgeService = createKnowledgeService();
  const deferred = await knowledgeService.ingest([{
    tenantId: "solera",
    productId: "fl-titling",
    source: "github",
    sourceId: "77",
    sourceVersion: "1",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "github.pull-request",
    contentHash: "github-later-link-hash",
    classification: "internal",
    payload: {
      number: 77,
      title: "Automate deferred requirement",
      ticketKey: "STT-7777",
    },
  }]);
  assert.deepEqual(deferred.unresolvedLinks, [{
    productId: "fl-titling",
    linkId: "link:77:STT-7777:0",
    fromEntityId: "test:github:77",
    toEntityId: "requirement:STT-7777",
  }]);

  const beforeRequirement = await knowledgeService.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-7777",
  });
  assert.deepEqual(beforeRequirement.relationships, []);

  const resolved = await knowledgeService.ingest([{
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-7777",
    sourceVersion: "1",
    observedAt: "2026-09-10T00:01:00.000Z",
    contentType: "jira.issue",
    contentHash: "jira-later-link-hash",
    classification: "internal",
    payload: {
      key: "STT-7777",
      summary: "Deferred requirement",
      acceptanceCriteria: [],
    },
  }]);
  assert.deepEqual(resolved.unresolvedLinks, []);

  const afterRequirement = await knowledgeService.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-7777",
  });
  assert.deepEqual(afterRequirement.relationships.map((link) => link.id), [
    "link:77:STT-7777:0",
  ]);
});

test("bounds unresolved cross-source links", async () => {
  const knowledgeService = createKnowledgeService({ maxPendingTraceLinks: 1 });
  const record = (number, ticketKey, productId = "fl-titling") => ({
    tenantId: "solera",
    productId,
    source: "github",
    sourceId: String(number),
    sourceVersion: "1",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "github.pull-request",
    contentHash: `github-${number}-hash`,
    classification: "internal",
    payload: { number, title: `PR ${number}`, ticketKey },
  });

  await knowledgeService.ingest([record(1, "STT-9001")]);
  const otherProduct = await knowledgeService.ingest([
    record(2, "STT-9002", "ga-titling"),
  ]);
  assert.deepEqual(otherProduct.unresolvedLinks.map((link) => link.productId), [
    "ga-titling",
  ]);
  await assert.rejects(
    knowledgeService.ingest([record(3, "STT-9003")]),
    /Pending trace link limit of 1 exceeded/,
  );
});

test("rejects malformed and cross-product resource URIs before service execution", async () => {
  const application = createApplication();
  const malformed = await request(
    application,
    "GET",
    `/v1/resources/read?productId=fl-titling&uri=${encodeURIComponent("tkl://products/fl-titling/requirements/%E0%A4%A")}`,
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "invalid_request");

  const crossProduct = await request(
    application,
    "GET",
    `/v1/resources/read?productId=fl-titling&uri=${encodeURIComponent("tkl://products/other-product/requirements/STT-4242")}`,
  );
  assert.equal(crossProduct.status, 400);
  assert.equal(crossProduct.body.error.code, "invalid_request");
});

test("accepts TestRail as a source filter without source-specific API logic", async () => {
  let received;
  const application = createApplication({
    knowledgeService: {
      async search(request) {
        received = request;
        return {
          productId: request.productId,
          query: request.query,
          items: [],
          limit: request.limit
        };
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/knowledge/search?productId=fl-titling&source=testrail"
  );

  assert.equal(response.status, 200);
  assert.equal(received.source, "testrail");
});

test("rejects unsupported source filters", async () => {
  const response = await request(
    createApplication(),
    "GET",
    "/v1/knowledge/search?productId=fl-titling&source=unsupported"
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.details.parameter, "source");
});

test("passes a TestRail filter to conflict queries", async () => {
  let received;
  const application = createApplication({
    knowledgeService: {
      async listKnowledgeConflicts(request) {
        received = request;
        return { productId: request.productId, conflicts: [], provenance: [] };
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/knowledge/conflicts?productId=fl-titling&source=testrail"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", source: "testrail" });
});

test("forwards a registered source filter through story, coverage, and traceability queries", async () => {
  const received = {};
  const application = createApplication({
    knowledgeService: {
      async getStoryTestContext(request) {
        received.story = request;
        return {
          productId: request.productId,
          storyId: request.storyId,
          requirements: [],
          tests: [],
          defects: [],
          provenance: []
        };
      },
      async analyzeRequirementCoverage(request) {
        received.coverage = request;
        return { productId: request.productId, requirementId: request.requirementId, findings: [], provenance: [] };
      },
      async explainTraceability(request) {
        received.traceability = request;
        return { productId: request.productId, requirementId: request.requirementId, relationships: [], provenance: [] };
      }
    }
  });

  const paths = [
    ["/v1/story/test-context?productId=fl-titling&storyId=STT-123&source=github", "story"],
    ["/v1/requirements/coverage?productId=fl-titling&requirementId=REQ-123&source=jira", "coverage"],
    ["/v1/traceability?productId=fl-titling&requirementId=REQ-123&source=testrail", "traceability"]
  ];

  for (const [path, operation] of paths) {
    const response = await request(application, "GET", path);
    assert.equal(response.status, 200);
    assert.equal(received[operation].source, new URL(path, "http://localhost").searchParams.get("source"));
  }
});

test("rejects write methods on API routes", async () => {
  const response = await request(createApplication(), "POST", "/v1/knowledge/search");

  assert.equal(response.status, 405);
  assert.deepEqual(response.body.error.details.allowed, ["GET"]);
});

test("reads a product-scoped MCP resource through the knowledge service", async () => {
  let received;
  const application = createApplication({
    knowledgeService: {
      async readResource(request) {
        received = request;
        return {
          productId: request.productId,
          uri: request.uri,
          contents: [{ type: "text", text: "fixture" }]
        };
      }
    }
  });
  const uri = "tkl://products/fl-titling/features/feature-123";
  const response = await request(
    application,
    "GET",
    `/v1/resources/read?productId=fl-titling&uri=${encodeURIComponent(uri)}`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(received, { productId: "fl-titling", uri });
  assert.equal(response.body.contents[0].text, "fixture");
});

test("returns a not found response for unknown routes", async () => {
  const response = await request(createApplication(), "GET", "/v1/unknown");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "not_found");
});

test("rejects a knowledge service response that violates its output contract", async () => {
  const application = createApplication({
    knowledgeService: {
      async listKnowledgeConflicts() {
        return { productId: "fl-titling", conflicts: [] };
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/knowledge/conflicts?productId=fl-titling"
  );

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "invalid_service_response");
});

test("audits API requests with correlation, subject, product, and outcome", async () => {
  const events = [];
  const application = createApplication({
    auditLogger: {
      async record(event) {
        events.push(event);
      }
    }
  });

  const response = await application.handle({
    method: "GET",
    pathname: "/v1/knowledge/conflicts",
    url: new URL("/v1/knowledge/conflicts?productId=fl-titling", "http://localhost"),
    correlationId: "api-correlation-1",
    authContext: {
      subject: "carlos",
      tenantId: "solera",
      roles: ["reader"],
      permissions: ["conflicts:read"],
      productIds: ["fl-titling"]
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(events[0], {
    eventType: "api.request",
    correlationId: "api-correlation-1",
    operation: "list_knowledge_conflicts",
    method: "GET",
    path: "/v1/knowledge/conflicts",
    subject: "carlos",
    productId: "fl-titling",
    outcome: "success",
    status: 200,
    durationMs: events[0].durationMs
  });
});

test("enforces a per-subject rate limit on authenticated API routes", async () => {
  const application = createApplication({
    rateLimiter: {
      assertWithinLimit(key) {
        assert.equal(key, "test-user");
        throw new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.", {
          retryAfterMs: 5000
        });
      }
    }
  });

  const response = await request(
    application,
    "GET",
    "/v1/knowledge/conflicts?productId=fl-titling"
  );

  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, "rate_limit_exceeded");
  assert.equal(response.body.error.details.retryAfterMs, 5000);
});

test("does not rate limit the unauthenticated health check", async () => {
  let calls = 0;
  const application = createApplication({
    rateLimiter: {
      assertWithinLimit() {
        calls += 1;
      }
    }
  });

  const response = await application.handle({
    method: "GET",
    pathname: "/health",
    url: new URL("/health", "http://localhost")
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test("records a conflict review via the approved review endpoint", async () => {
  let received;
  const application = createApplication({
    knowledgeService: {
      async reviewConflict(reviewRequest) {
        received = reviewRequest;
        return {
          productId: reviewRequest.productId,
          conflict: { id: reviewRequest.conflictId, status: "reviewed" },
          review: {
            id: "review-1",
            targetId: reviewRequest.conflictId,
            decision: "resolved",
            approvedClaimIds: reviewRequest.approvedClaimIds,
            reviewerId: reviewRequest.reviewerId,
            reviewedAt: reviewRequest.reviewedAt
          }
        };
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    {
      body: {
        conflictId: "conflict:requirement:STT-4242",
        approvedClaimIds: ["claim:req-1@abc123"],
        note: "Confirmed with product owner."
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.productId, "fl-titling");
  assert.equal(response.body.conflict.status, "reviewed");
  assert.equal(response.body.review.reviewerId, "test-user");
  assert.ok(response.body.review.reviewedAt);
  assert.equal(received.conflictId, "conflict:requirement:STT-4242");
  assert.deepEqual(received.approvedClaimIds, ["claim:req-1@abc123"]);
  assert.equal(received.note, "Confirmed with product owner.");
  assert.equal(received.productId, "fl-titling");
});

test("reviews a source-scoped conflict through the real knowledge service", async () => {
  const knowledgeService = createKnowledgeService();
  await knowledgeService.ingest([{
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-4242",
    sourceVersion: "1",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: "jira-review-fixture-hash",
    classification: "internal",
    payload: {
      key: "STT-4242",
      summary: "Submit a title application",
      acceptanceCriteria: ["The submitted application is persisted"],
    },
  }]);

  const store = knowledgeService.getStore("fl-titling");
  const entityId = "requirement:STT-4242";
  const firstClaim = store.getClaims(entityId)[0];
  const secondClaim = {
    ...firstClaim,
    id: `${firstClaim.id}:review-alternative`,
    value: "The submitted application is validated before persistence",
  };
  store.addClaim(secondClaim);
  store.addConflict({
    id: `conflict:${entityId}:acceptanceCriteria`,
    entityId,
    claimIds: [firstClaim.id, secondClaim.id],
    reason: "Acceptance criteria require human review",
    detectedAt: "2026-09-11T19:30:00.000Z",
    status: "open",
  });

  const response = await request(
    createApplication({ knowledgeService }),
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling&source=jira",
    {
      body: {
        conflictId: `conflict:${entityId}:acceptanceCriteria`,
        approvedClaimIds: [firstClaim.id],
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.conflict.status, "reviewed");
  assert.equal(response.body.review.approvedClaimIds[0], firstClaim.id);
});

test("rejects a conflict review request without the conflicts:review permission", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        assert.fail("reviewConflict should not be called without permission");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    {
      body: { conflictId: "conflict:requirement:STT-4242", approvedClaimIds: ["claim:req-1@abc123"] },
      authContext: {
        subject: "test-user",
        roles: ["reader"],
        permissions: ["conflicts:read"],
        productIds: ["fl-titling"]
      }
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "forbidden");
});

test("rejects a conflict review request outside the auth context's product scope", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        assert.fail("reviewConflict should not be called for an unauthorized product");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=other-product",
    {
      body: { conflictId: "conflict:requirement:STT-4242", approvedClaimIds: ["claim:req-1@abc123"] }
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "product_access_denied");
});

test("rejects a conflict review request missing approvedClaimIds", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        assert.fail("reviewConflict should not be called for an invalid request");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    { body: { conflictId: "conflict:requirement:STT-4242", approvedClaimIds: [] } }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
  assert.equal(response.body.error.details.parameter, "approvedClaimIds");
});

test("rejects a conflict review request with a non-JSON body", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        assert.fail("reviewConflict should not be called for a malformed request");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    { body: undefined }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_request");
});

test("translates an unknown conflict into a 404 from the review endpoint", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        const { ApiError } = await import("../src/errors.js");
        throw new ApiError(404, "conflict_not_found", "Open conflict conflict:missing does not exist for product fl-titling.");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    { body: { conflictId: "conflict:missing", approvedClaimIds: ["claim:req-1@abc123"] } }
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "conflict_not_found");
});

test("translates an already-reviewed conflict into a 409 from the review endpoint", async () => {
  const application = createApplication({
    knowledgeService: {
      async reviewConflict() {
        const { ApiError } = await import("../src/errors.js");
        throw new ApiError(409, "conflict_already_reviewed", "Conflict conflict:requirement:STT-4242 has already been reviewed.");
      }
    }
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    {
      body: {
        conflictId: "conflict:requirement:STT-4242",
        approvedClaimIds: ["claim:req-1@abc123"]
      }
    }
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "conflict_already_reviewed");
});

test("rejects GET requests to the conflict review endpoint", async () => {
  const response = await request(
    createApplication(),
    "GET",
    "/v1/knowledge/conflicts/review?productId=fl-titling"
  );

  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, "method_not_allowed");
});

test("translates knowledge-service store errors for the review endpoint end-to-end", async () => {
  const application = createApplication({
    knowledgeService: createKnowledgeService({ tenantId: "solera" })
  });

  const response = await request(
    application,
    "POST",
    "/v1/knowledge/conflicts/review?productId=fl-titling",
    { body: { conflictId: "conflict:does-not-exist", approvedClaimIds: ["claim:req-1@abc123"] } }
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "conflict_not_found");
});

test("runs Ask TKL through a product-scoped authenticated audited endpoint", async () => {
  let received;
  const events = [];
  const application = createApplication({
    askTklAgent: {
      async execute(request) {
        received = request;
        return {
          runId: "ask-run-1",
          agent: { id: "agent.ask-tkl", version: "0.1.0", mode: "read-only" },
          productId: request.productId,
          question: request.question,
          workItemId: request.workItemId,
          generatedAt: "2026-09-14T12:00:00.000Z",
          intent: { primary: "coverage-context", matched: ["coverage-context"] },
          scope: {
            productId: request.productId,
            workItemId: request.workItemId,
            interpretation: "coverage context over the exact Jira hierarchy",
          },
          status: "answered",
          answer: "The story has grounded coverage. [S1]",
          citations: [{
            id: "S1",
            source: "jira",
            sourceId: "STT-3731",
            sourceVersion: "1",
            observedAt: "2026-09-14T00:00:00.000Z",
            resourceUri: "tkl://products/fl-titling/sources/jira/STT-3731/provenance",
            href: "/v1/resources/read?productId=fl-titling",
          }],
          freshness: {
            status: "current",
            asOf: "2026-09-14T12:00:00.000Z",
            newestObservedAt: "2026-09-14T00:00:00.000Z",
            oldestObservedAt: "2026-09-14T00:00:00.000Z",
            staleCitationCount: 0,
            thresholdDays: 30,
          },
          confidence: { level: "high", rationale: "Current cited evidence." },
          conflicts: [],
          limitations: [],
          nextActions: [],
          toolCalls: [{
            capability: "agent.coverage-context",
            status: "ready-for-review",
            summary: "Done.",
          }],
        };
      },
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      },
    },
  });

  const response = await request(
    application,
    "POST",
    "/v1/ask?productId=fl-titling",
    {
      body: {
        question: "What covers this story?",
        workItemId: "stt-3731",
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    productId: "fl-titling",
    question: "What covers this story?",
    workItemId: "STT-3731",
  });
  assert.equal(response.body.agent.id, "agent.ask-tkl");
  assert.equal(events[0].operation, "ask_tkl");
  assert.equal(events[0].productId, "fl-titling");
  assert.equal(events[0].outcome, "success");
});

test("validates Ask TKL input and enforces Ask TKL authorization", async () => {
  const invalid = await request(
    createApplication(),
    "POST",
    "/v1/ask?productId=fl-titling",
    { body: { question: " " } },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.details.parameter, "question");

  const forbidden = await request(
    createApplication(),
    "POST",
    "/v1/ask?productId=fl-titling",
    {
      body: { question: "What covers STT-3731?" },
      authContext: {
        subject: "test-user",
        tenantId: "solera",
        roles: ["reader"],
        permissions: ["knowledge:read", "coverage:read"],
        productIds: ["fl-titling"],
      },
    },
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.details.permission, "ask:read");
});

test("enforces routed Ask TKL downstream permissions before executing the agent", async () => {
  const cases = [
    {
      question: "Explain the title application workflow.",
      permission: "knowledge:read",
    },
    {
      question: "What covers STT-3731?",
      permission: "coverage:read",
    },
    {
      question: "Find conflicts for STT-3731.",
      permission: "conflicts:read",
    },
  ];

  for (const testCase of cases) {
    let executed = false;
    const response = await request(
      createApplication({
        askTklAgent: {
          async execute() {
            executed = true;
            assert.fail("the Ask TKL agent must not run without its routed permission");
          },
        },
      }),
      "POST",
      "/v1/ask?productId=fl-titling",
      {
        body: { question: testCase.question },
        authContext: {
          subject: "test-user",
          tenantId: "solera",
          roles: ["reader"],
          permissions: ["ask:read"],
          productIds: ["fl-titling"],
        },
      },
    );

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "forbidden");
    assert.equal(response.body.error.details.permission, testCase.permission);
    assert.equal(executed, false);
  }
});
