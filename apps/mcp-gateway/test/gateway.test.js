import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import { createApplicationApiClient } from "../src/client.js";
import { createReadOnlyMcpProvider } from "../src/index.js";
import { createApplication } from "../../api/src/app.js";
import { SecurityError } from "../../../packages/security/src/index.js";

function makeGateway(overrides = {}) {
  const calls = [];
  const applicationClient = {
    async searchQualityKnowledge(input) {
      calls.push(["searchQualityKnowledge", input]);
      return { items: [], provenance: [] };
    },
    async getStoryTestContext(input) {
      calls.push(["getStoryTestContext", input]);
      return { storyId: input.storyId, provenance: [] };
    },
    async analyzeRequirementCoverage(input) {
      calls.push(["analyzeRequirementCoverage", input]);
      return { requirementId: input.requirementId, provenance: [] };
    },
    async explainTraceability(input) {
      calls.push(["explainTraceability", input]);
      return { requirementId: input.requirementId, provenance: [] };
    },
    async listKnowledgeConflicts(input) {
      calls.push(["listKnowledgeConflicts", input]);
      return { conflicts: [], provenance: [] };
    },
    ...overrides
  };
  return { gateway: createGateway({ applicationClient }), calls };
}

test("lists only the five read-only MVP tools", () => {
  const { gateway } = makeGateway();
  assert.deepEqual(
    gateway.listTools().map((tool) => tool.name),
    [
      "search_quality_knowledge",
      "get_story_test_context",
      "analyze_requirement_coverage",
      "explain_traceability",
      "list_knowledge_conflicts"
    ]
  );
});

test("correlates its own status with application health when available", async () => {
  const { gateway } = makeGateway({
    async health() {
      return { status: "ok", service: "tkl-api" };
    }
  });

  const report = await gateway.health();

  assert.equal(report.status, "healthy");
  const components = report.components.map((entry) => entry.component);
  assert.deepEqual(components.sort(), ["application-api", "mcp-gateway"]);
});

test("reports degraded correlated health when the application health check fails", async () => {
  const { gateway } = makeGateway({
    async health() {
      throw new Error("unreachable");
    }
  });

  const report = await gateway.health();

  assert.equal(report.status, "degraded");
  const applicationEntry = report.components.find((entry) => entry.component === "application-api");
  assert.equal(applicationEntry.status, "degraded");
});

test("reports its own healthy status when the application client has no health check", async () => {
  const { gateway } = makeGateway();

  const report = await gateway.health();

  assert.equal(report.status, "healthy");
  assert.deepEqual(report.components.map((entry) => entry.component), ["mcp-gateway"]);
});

test("delegates tool calls to the application API client", async () => {
  const { gateway, calls } = makeGateway();
  const result = await gateway.callTool("get_story_test_context", {
    productId: "fl-titling",
    storyId: "STT-123"
  });

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [
    [
      "getStoryTestContext",
      { productId: "fl-titling", storyId: "STT-123" }
    ]
  ]);
});

test("uses one scoped contract for in-process MCP consumers", async () => {
  const calls = [];
  const provider = createReadOnlyMcpProvider({
    tenantId: "solera",
    productId: "fl-titling",
    applicationClient: {
      async getStoryTestContext(input) {
        calls.push(input);
        return { productId: input.productId, storyId: input.storyId };
      }
    }
  });

  const result = await provider.get_story_test_context({ storyId: "STT-123" });

  assert.deepEqual(calls, [{
    tenantId: "solera",
    productId: "fl-titling",
    storyId: "STT-123",
    source: undefined
  }]);
  assert.equal(result.storyId, "STT-123");
});

test("does not let in-process search callers override configured scope", async () => {
  const calls = [];
  const provider = createReadOnlyMcpProvider({
    tenantId: "solera",
    productId: "fl-titling",
    applicationClient: {
      async searchQualityKnowledge(input) {
        calls.push(input);
        return { productId: input.productId, items: [], provenance: [] };
      }
    }
  });

  await provider.search_quality_knowledge({
    tenantId: "other-tenant",
    productId: "other-product",
    query: "",
    limit: 10
  });

  assert.equal(calls[0].tenantId, "solera");
  assert.equal(calls[0].productId, "fl-titling");
});

test("rejects the former unscoped provider construction", () => {
  assert.throws(
    () => createReadOnlyMcpProvider({ applicationClient: {} }),
    /tenantId is required/
  );
});

test("rejects undeclared arguments", async () => {
  const { gateway } = makeGateway();

  await assert.rejects(
    gateway.callTool("list_knowledge_conflicts", {
      productId: "fl-titling",
      token: "secret"
    }),
    (error) => error.code === "invalid_arguments"
  );
});

test("rejects invalid product identifiers", async () => {
  const { gateway } = makeGateway();

  await assert.rejects(
    gateway.callTool("search_quality_knowledge", { productId: "other/product" }),
    (error) =>
      error.code === "invalid_arguments" &&
      error.details.parameter === "productId"
  );
});

test("supports MCP tools/list and tools/call methods", async () => {
  const { gateway } = makeGateway();
  const tools = await gateway.handle({ method: "tools/list" });
  const result = await gateway.handle({
    method: "tools/call",
    params: {
      name: "list_knowledge_conflicts",
      arguments: { productId: "fl-titling" }
    }
  });

  assert.equal(tools.tools.length, 5);
  assert.equal(result.isError, false);
});

test("reads a product-scoped resource through the application client", async () => {
  const { gateway, calls } = makeGateway({
    async readResource(input) {
      calls.push(["readResource", input]);
      return {
        productId: input.productId,
        uri: input.uri,
        contents: [{ type: "text", text: "fixture" }]
      };
    }
  });
  const uri = "tkl://products/fl-titling/features/feature-123";
  const result = await gateway.handle({ method: "resources/read", params: { uri } });
  assert.equal(result.structuredContent.contents[0].text, "fixture");
  assert.deepEqual(calls.at(-1), ["readResource", { productId: "fl-titling", uri }]);
});

test("executes the resource path from MCP through the API application with fixtures", async () => {
  const uri = "tkl://products/fl-titling/features/feature-123";
  const application = createApplication({
    knowledgeService: {
      async readResource(request) {
        return {
          productId: request.productId,
          uri: request.uri,
          contents: [{ type: "text", text: "fixture feature" }]
        };
      }
    }
  });
  const fetchImplementation = async (url) => {
    const parsed = new URL(url);
    const response = await application.handle({
      method: "GET",
      pathname: parsed.pathname,
      url: parsed,
      authContext: {
        subject: "fixture-agent",
        roles: ["reader"],
        permissions: ["knowledge:read"],
        productIds: ["fl-titling"]
      }
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() {
        return response.body;
      }
    };
  };
  const client = createApplicationApiClient({ fetchImplementation });
  const gateway = createGateway({ applicationClient: client });
  const result = await gateway.handle({ method: "resources/read", params: { uri } });

  assert.deepEqual(result.structuredContent, {
    productId: "fl-titling",
    uri,
    contents: [{ type: "text", text: "fixture feature" }]
  });
});

test("publishes the shared input schema without allowing extra fields", () => {
  const { gateway } = makeGateway();
  const search = gateway.listTools().find((tool) => tool.name === "search_quality_knowledge");

  assert.equal(search.inputSchema.additionalProperties, false);
  assert.deepEqual(search.inputSchema.required, ["productId"]);
  assert.equal(search.inputSchema.properties.limit.maximum, 100);
  assert.match(search.inputSchema.properties.source.pattern, /testrail/);
});

test("forwards registered source filters without source-specific gateway logic", async () => {
  const { gateway, calls } = makeGateway();
  const sourceCases = [
    ["search_quality_knowledge", { productId: "fl-titling", source: "jira" }],
    ["get_story_test_context", { productId: "fl-titling", storyId: "STT-123", source: "github" }],
    ["analyze_requirement_coverage", { productId: "fl-titling", requirementId: "REQ-123", source: "testrail" }],
    ["explain_traceability", { productId: "fl-titling", requirementId: "REQ-123", source: "confluence" }],
    ["list_knowledge_conflicts", { productId: "fl-titling", source: "reportportal" }]
  ];

  for (const [toolName, argumentsValue] of sourceCases) {
    await gateway.callTool(toolName, argumentsValue);
  }

  assert.deepEqual(
    calls.map(([, input]) => input.source),
    ["jira", "github", "testrail", "confluence", "reportportal"]
  );
});

test("audits tool calls without recording authorization material", async () => {
  const events = [];
  const { gateway } = makeGateway();
  const auditedGateway = createGatewayWithAudit(gateway, events);
  const result = await auditedGateway.callTool(
    "list_knowledge_conflicts",
    { productId: "fl-titling" },
    { correlationId: "mcp-correlation-1", authorization: "Bearer secret" }
  );

  assert.equal(result.isError, false);
  assert.equal(events[0].eventType, "mcp.tool");
  assert.equal(events[0].correlationId, "mcp-correlation-1");
  assert.equal(events[0].productId, "fl-titling");
  assert.equal("authorization" in events[0], false);
});

test("audits invalid tool arguments with the same client-error status returned by HTTP", async () => {
  const events = [];
  const { gateway } = makeGateway();
  const auditedGateway = createGatewayWithAudit(gateway, events);

  await assert.rejects(
    auditedGateway.callTool("list_knowledge_conflicts", { productId: "other/product" }),
    (error) => error.code === "invalid_arguments" && error.status === 400
  );

  assert.equal(events[0].outcome, "failure");
  assert.equal(events[0].status, 400);
});

test("denies calling a tool outside the allowlisted MVP set", async () => {
  const { gateway } = makeGateway();

  await assert.rejects(
    gateway.callTool("delete_knowledge_entity", { productId: "fl-titling" }),
    (error) => error.code === "tool_not_found"
  );
});

test("denies unsupported MCP methods, including any implied write operation", async () => {
  const { gateway } = makeGateway();

  await assert.rejects(
    gateway.handle({ method: "tools/write", params: {} }),
    (error) => error.code === "method_not_found"
  );
  await assert.rejects(
    gateway.handle({ method: "resources/write", params: {} }),
    (error) => error.code === "method_not_found"
  );
});

test("denies resource reads outside the allowlisted resource templates", async () => {
  const { gateway } = makeGateway({
    async readResource() {
      throw new Error("readResource must not be called for a disallowed URI");
    }
  });

  await assert.rejects(
    gateway.handle({
      method: "resources/read",
      params: { uri: "tkl://products/fl-titling/admin/settings" }
    }),
    (error) => error.code === "resource_not_found"
  );
});

test("denies resource reads without a tkl:// scheme or product scope", async () => {
  const { gateway } = makeGateway();

  await assert.rejects(
    gateway.readResource("https://example.com/products/fl-titling/features/1"),
    (error) => error.code === "invalid_resource_uri"
  );
  await assert.rejects(
    gateway.readResource("tkl://features/feature-123"),
    (error) => error.code === "invalid_resource_uri"
  );
});

test("audits resource reads without recording authorization material or resource content", async () => {
  const events = [];
  const gateway = createGateway({
    applicationClient: {
      async readResource() {
        return {
          productId: "fl-titling",
          uri: "tkl://products/fl-titling/features/f-1",
          contents: [{ type: "text", text: "sensitive fixture content" }],
        };
      }
    },
    auditLogger: {
      async record(event) {
        events.push(event);
      }
    }
  });

  await gateway.readResource(
    "tkl://products/fl-titling/features/f-1",
    {
      correlationId: "resource-correlation-1",
      authorization: "Bearer private-token",
    },
  );

  assert.equal(events[0].eventType, "mcp.resource");
  assert.equal(events[0].productId, "fl-titling");
  assert.match(events[0].subject, /^token:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(events[0]).includes("private-token"), false);
  assert.equal(JSON.stringify(events[0]).includes("sensitive fixture content"), false);
});

test("publishes only the four allowlisted resource templates", () => {
  const { gateway } = makeGateway();
  assert.deepEqual(
    gateway.listResourceTemplates().map((template) => template.name),
    ["feature", "requirement", "traceability", "provenance"]
  );
});

test("enforces a per-subject rate limit on tool calls", async () => {
  const applicationClient = {
    async listKnowledgeConflicts() {
      return { conflicts: [], provenance: [] };
    }
  };
  const gateway = createGateway({
    applicationClient,
    rateLimiter: {
      assertWithinLimit(key) {
        assert.equal(key, "carlos");
        throw new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.");
      }
    }
  });

  await assert.rejects(
    gateway.callTool(
      "list_knowledge_conflicts",
      { productId: "fl-titling" },
      { subject: "carlos" }
    ),
    (error) => error instanceof SecurityError && error.code === "rate_limit_exceeded"
  );
});

test("enforces a per-subject rate limit on resource reads", async () => {
  const applicationClient = {
    async readResource() {
      return { uri: "tkl://products/fl-titling/features/f-1", provenance: [] };
    }
  };
  const gateway = createGateway({
    applicationClient,
    rateLimiter: {
      assertWithinLimit() {
        throw new SecurityError(429, "rate_limit_exceeded", "Too many requests. Please retry later.");
      }
    }
  });

  await assert.rejects(
    gateway.readResource("tkl://products/fl-titling/features/f-1", { subject: "carlos" }),
    (error) => error instanceof SecurityError && error.code === "rate_limit_exceeded"
  );
});

test("uses an opaque authorization hash for rate limiting when the HTTP layer has no subject", async () => {
  const keys = [];
  const applicationClient = {
    async listKnowledgeConflicts() {
      return { conflicts: [], provenance: [] };
    }
  };
  const gateway = createGateway({
    applicationClient,
    rateLimiter: {
      assertWithinLimit(key) {
        keys.push(key);
      }
    }
  });

  await gateway.callTool(
    "list_knowledge_conflicts",
    { productId: "fl-titling" },
    { authorization: "Bearer private-token" }
  );

  assert.equal(keys.length, 1);
  assert.match(keys[0], /^token:[a-f0-9]{64}$/);
  assert.equal(keys[0].includes("private-token"), false);
});

function createGatewayWithAudit(existingGateway, events) {
  const applicationClient = {
    async listKnowledgeConflicts(input) {
      return existingGateway.callTool("list_knowledge_conflicts", input).then((result) => result.structuredContent);
    }
  };
  return createGateway({
    applicationClient,
    auditLogger: {
      async record(event) {
        events.push(event);
      }
    }
  });
}
