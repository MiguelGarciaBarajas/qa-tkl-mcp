const API_ROUTES = {
  search_quality_knowledge: "/v1/knowledge/search",
  get_story_test_context: "/v1/story/test-context",
  analyze_requirement_coverage: "/v1/requirements/coverage",
  explain_traceability: "/v1/traceability",
  list_knowledge_conflicts: "/v1/knowledge/conflicts",
  read_resource: "/v1/resources/read"
};
import { validateApiResponse } from "../../../packages/contracts/src/index.js";

function buildUrl(baseUrl, route, parameters) {
  const url = new URL(route, baseUrl);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function request(
  baseUrl,
  route,
  contractName,
  parameters,
  fetchImplementation,
  authorization
) {
  const response = await fetchImplementation(buildUrl(baseUrl, route, parameters), {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(authorization ? { authorization } : {})
    }
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? "Application API request failed.");
    error.code = body?.error?.code ?? "application_api_error";
    error.status = response.status;
    throw error;
  }
  const validation = validateApiResponse(contractName, body);
  if (!validation.valid) {
    const error = new Error(validation.message);
    error.code = "invalid_application_response";
    throw error;
  }
  return body;
}

export function createApplicationApiClient({
  baseUrl = "http://localhost:3000",
  fetchImplementation = globalThis.fetch,
  authorization
} = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  return {
    searchQualityKnowledge(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.search_quality_knowledge,
        "search_quality_knowledge",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    getStoryTestContext(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.get_story_test_context,
        "get_story_test_context",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    analyzeRequirementCoverage(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.analyze_requirement_coverage,
        "analyze_requirement_coverage",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    explainTraceability(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.explain_traceability,
        "explain_traceability",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    listKnowledgeConflicts(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.list_knowledge_conflicts,
        "list_knowledge_conflicts",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    readResource(parameters, requestContext = {}) {
      return request(
        baseUrl,
        API_ROUTES.read_resource,
        "read_resource",
        parameters,
        fetchImplementation,
        requestContext.authorization ?? authorization
      );
    },
    async health() {
      const response = await fetchImplementation(new URL("/health", baseUrl), {
        method: "GET",
        headers: { accept: "application/json" }
      });
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(body?.error?.message ?? "Application API health check failed.");
        error.code = body?.error?.code ?? "application_api_error";
        error.status = response.status;
        throw error;
      }
      const validation = validateApiResponse("health", body);
      if (!validation.valid) {
        const error = new Error(validation.message);
        error.code = "invalid_application_response";
        throw error;
      }
      return body;
    }
  };
}
