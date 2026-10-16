import {
  GatewayError,
  invalidArguments,
  methodNotFound,
  resourceNotFound,
  toolNotFound
} from "./errors.js";
import { createHash } from "node:crypto";
import {
  TOOL_INPUT_SCHEMAS,
  validateToolArguments
} from "../../../packages/contracts/src/index.js";
import {
  createAuditLogger,
  createCorrelationId,
  createHealthRegistry
} from "../../../packages/observability/src/index.js";
import { createRateLimiter } from "../../../packages/security/src/index.js";

const TOOL_DEFINITIONS = [
  {
    name: "search_quality_knowledge",
    description: "Search approved quality knowledge for a product.",
    inputSchema: TOOL_INPUT_SCHEMAS.search_quality_knowledge
  },
  {
    name: "get_story_test_context",
    description: "Build traceable test context for a story.",
    inputSchema: TOOL_INPUT_SCHEMAS.get_story_test_context
  },
  {
    name: "analyze_requirement_coverage",
    description: "Analyze test coverage and stale evidence for a requirement.",
    inputSchema: TOOL_INPUT_SCHEMAS.analyze_requirement_coverage
  },
  {
    name: "explain_traceability",
    description: "Explain traceability relationships for a requirement.",
    inputSchema: TOOL_INPUT_SCHEMAS.explain_traceability
  },
  {
    name: "list_knowledge_conflicts",
    description: "List unresolved or unapproved knowledge conflicts for a product.",
    inputSchema: TOOL_INPUT_SCHEMAS.list_knowledge_conflicts
  }
];

const RESOURCE_TEMPLATES = [
  { uriTemplate: "tkl://products/{productId}/features/{featureId}", name: "feature" },
  { uriTemplate: "tkl://products/{productId}/requirements/{requirementId}", name: "requirement" },
  { uriTemplate: "tkl://products/{productId}/traceability/{requirementId}", name: "traceability" },
  {
    uriTemplate: "tkl://products/{productId}/sources/{source}/{sourceId}/provenance",
    name: "provenance"
  }
];

const TOOL_METHODS = {
  search_quality_knowledge: "searchQualityKnowledge",
  get_story_test_context: "getStoryTestContext",
  analyze_requirement_coverage: "analyzeRequirementCoverage",
  explain_traceability: "explainTraceability",
  list_knowledge_conflicts: "listKnowledgeConflicts"
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const RESOURCE_TEMPLATE_PATTERNS = RESOURCE_TEMPLATES.map((template) => ({
  ...template,
  pattern: new RegExp(
    `^${template.uriTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`
  )
}));

function matchesAllowlistedResourceTemplate(uri) {
  return RESOURCE_TEMPLATE_PATTERNS.some((template) => template.pattern.test(uri));
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}

function requestSubject(requestContext) {
  if (typeof requestContext?.subject === "string" && requestContext.subject.length > 0) {
    return requestContext.subject;
  }
  if (
    typeof requestContext?.authorization === "string"
    && requestContext.authorization.length > 0
  ) {
    return `token:${createHash("sha256").update(requestContext.authorization).digest("hex")}`;
  }
  return undefined;
}

export function createGateway({
  applicationClient,
  auditLogger = createAuditLogger(),
  rateLimiter = createRateLimiter(),
  healthRegistry = createHealthRegistry()
}) {
  if (!applicationClient || typeof applicationClient !== "object") {
    throw new Error("applicationClient is required.");
  }

  const toolsByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

  function checkRateLimit(requestContext) {
    const subject = requestSubject(requestContext);
    if (subject) {
      rateLimiter.assertWithinLimit(subject);
    }
  }

  return {
    listTools() {
      return TOOL_DEFINITIONS;
    },

    listResourceTemplates() {
      return RESOURCE_TEMPLATES;
    },

    /**
     * Correlates the gateway's own status with any upstream application-side health
     * already surfaced by the application client (e.g. via a `health()` method), so
     * connector/application/API/MCP health can be reported through one shared report.
     * This never calls a source system directly; it only aggregates values already
     * computed elsewhere.
     */
    async health(requestContext = {}) {
      healthRegistry.record("mcp-gateway", { status: "healthy" });
      if (typeof applicationClient.health === "function") {
        try {
          const applicationHealth = await applicationClient.health(requestContext);
          healthRegistry.record("application-api", applicationHealth);
        } catch {
          healthRegistry.record("application-api", { status: "degraded" });
        }
      }
      return healthRegistry.report();
    },

    async callTool(name, argumentsValue = {}, requestContext = {}) {
      const correlationId = requestContext.correlationId ?? createCorrelationId();
      const subject = requestSubject(requestContext);
      const startedAt = Date.now();
      let outcome = "success";
      let status = 200;
      const tool = toolsByName.get(name);
      try {
        if (!tool) {
          throw toolNotFound(name);
        }
        const validation = validateToolArguments(name, argumentsValue);
        if (!validation.valid) {
          throw invalidArguments(validation.message, validation.parameter
            ? { parameter: validation.parameter }
            : undefined);
        }
        checkRateLimit(requestContext);
        const method = applicationClient[TOOL_METHODS[name]];
        if (typeof method !== "function") {
          throw new GatewayError(
            "application_capability_unavailable",
            "Application API capability is unavailable.",
            undefined,
            500
          );
        }
        return toolResult(await method.call(applicationClient, argumentsValue, requestContext));
      } catch (error) {
        outcome = "failure";
        status = error.status ?? 500;
        throw error;
      } finally {
        await auditLogger.record({
          eventType: "mcp.tool",
          correlationId,
          operation: name,
          subject,
          productId: argumentsValue?.productId,
          outcome,
          status,
          durationMs: Date.now() - startedAt
        });
      }
    },

    async readResource(uri, requestContext = {}) {
      const correlationId = requestContext.correlationId ?? createCorrelationId();
      const subject = requestSubject(requestContext);
      const startedAt = Date.now();
      let outcome = "success";
      let status = 200;
      let productId;
      try {
        if (typeof uri !== "string" || !uri.startsWith("tkl://")) {
          throw new GatewayError("invalid_resource_uri", "Resource URI must use the tkl:// scheme.");
        }
        const productMatch = /^tkl:\/\/products\/([^/]+)\/.+$/.exec(uri);
        if (!productMatch) {
          throw new GatewayError(
            "invalid_resource_uri",
            "Resource URI must include a product scope under tkl://products/{productId}/."
          );
        }
        productId = productMatch[1];
        if (!matchesAllowlistedResourceTemplate(uri)) {
          throw resourceNotFound(uri);
        }
        checkRateLimit(requestContext);
        const method = applicationClient.readResource;
        if (typeof method !== "function") {
          throw new GatewayError(
            "application_capability_unavailable",
            "Application API resource capability is unavailable.",
            undefined,
            500
          );
        }
        return toolResult(
          await method.call(
            applicationClient,
            { productId, uri },
            requestContext
          )
        );
      } catch (error) {
        outcome = "failure";
        status = error.status ?? 500;
        throw error;
      } finally {
        await auditLogger.record({
          eventType: "mcp.resource",
          correlationId,
          operation: "resources/read",
          subject,
          productId,
          outcome,
          status,
          durationMs: Date.now() - startedAt
        });
      }
    },

    async handle(request, requestContext = {}) {
      if (!isRecord(request) || typeof request.method !== "string") {
        throw new GatewayError("invalid_request", "MCP request must include a method.");
      }

      if (request.method === "tools/list") {
        return { tools: this.listTools() };
      }
      if (request.method === "tools/call") {
        if (!isRecord(request.params) || typeof request.params.name !== "string") {
          throw invalidArguments("tools/call requires params.name.");
        }
        return this.callTool(
          request.params.name,
          request.params.arguments ?? {},
          requestContext
        );
      }
      if (request.method === "resources/templates/list") {
        return { resourceTemplates: this.listResourceTemplates() };
      }
      if (request.method === "resources/read") {
        if (!isRecord(request.params) || typeof request.params.uri !== "string") {
          throw invalidArguments("resources/read requires params.uri.");
        }
        return this.readResource(request.params.uri, requestContext);
      }

      throw methodNotFound(request.method);
    }
  };
}
