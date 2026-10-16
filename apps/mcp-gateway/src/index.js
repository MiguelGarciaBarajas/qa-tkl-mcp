export { createGateway } from "./gateway.js";
export { createApplicationApiClient } from "./client.js";
export { createMcpRequestListener } from "./http.js";
export {
  createMcpProtocol,
  JSON_RPC_ERROR_CODES,
  JsonRpcError,
  LATEST_PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS
} from "./protocol.js";
export { clientFingerprint, createSessionStore } from "./sessions.js";
export {
  bearerChallenge,
  isProtectedResourceMetadataPath,
  loadProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadataUrl
} from "./oauth-metadata.js";

/**
 * Compatibility adapter for in-process consumers. It uses the same scoped request
 * contract as the HTTP gateway and does not expose the former storyKey-only API.
 */
export function createReadOnlyMcpProvider({ applicationClient, tenantId, productId }) {
  if (!applicationClient || typeof applicationClient !== "object") {
    throw new TypeError("applicationClient is required");
  }
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new TypeError("tenantId is required");
  }
  if (typeof productId !== "string" || productId.length === 0) {
    throw new TypeError("productId is required");
  }

  const scope = { tenantId, productId };
  return {
    search_quality_knowledge(input = {}, requestContext = {}) {
      return applicationClient.searchQualityKnowledge({ ...input, ...scope }, requestContext);
    },
    get_story_test_context({ storyId, source } = {}, requestContext = {}) {
      return applicationClient.getStoryTestContext({ ...scope, storyId, source }, requestContext);
    },
    analyze_requirement_coverage({ requirementId, source } = {}, requestContext = {}) {
      return applicationClient.analyzeRequirementCoverage({ ...scope, requirementId, source }, requestContext);
    },
    explain_traceability({ requirementId, source } = {}, requestContext = {}) {
      return applicationClient.explainTraceability({ ...scope, requirementId, source }, requestContext);
    },
    list_knowledge_conflicts({ source } = {}, requestContext = {}) {
      return applicationClient.listKnowledgeConflicts({ ...scope, source }, requestContext);
    },
    read_resource({ uri } = {}, requestContext = {}) {
      return applicationClient.readResource({ ...scope, uri }, requestContext);
    }
  };
}
