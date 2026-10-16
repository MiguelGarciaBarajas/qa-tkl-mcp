import { methodNotAllowed, notFound, ApiError } from "./errors.js";
import {
  parseResourceRequest,
  parseSearchRequest,
  parseProductRequest,
  parseResourceReadRequest,
  parseKnowledgeConflictReviewRequest,
  parseSourceConnectionProductRequest,
  parseSourceConnectionRequest,
  parseGitHubRepositoryProductRequest,
  parseGitHubRepositoryCreateRequest,
  parseGitHubRepositoryUpdateRequest,
  parseTestRailSuiteDiscoveryRequest,
  parseTestRailSectionDiscoveryRequest,
  parseConfluencePageDiscoveryRequest,
  parseCoverageContextAgentRequest,
  parseAskTklRequest,
  parseApprovedActionPreviewRequest,
  parseApprovedActionApprovalRequest,
  parseApprovedActionExecutionRequest,
  parseTicketContextJobRequest,
  parseTicketContextOperationsRequest,
  parseArtifactResolveRequest,
  parseTestRailCaseImprovementRequest,
  parseReportPortalReliabilityRequest,
  parseEvidenceGraphRequest,
} from "./validation.js";
import { validateApiResponse } from "../../../packages/contracts/src/index.js";
import { assertAuthorized, PolicyError } from "../../../packages/policy/src/index.js";
import {
  createAuditLogger,
  createCorrelationId,
  createHealthRegistry
} from "../../../packages/observability/src/index.js";
import { createRateLimiter, SecurityError } from "../../../packages/security/src/index.js";
import { createKnowledgeService } from "./knowledge-service.js";
import { runEvaluation } from "@tkl/evaluation";
import { createCoverageContextAgent } from "./agents/coverage-context-agent.js";
import { createTestDesignerAgent } from "./agents/test-designer-agent.js";
import { createTestRailImprovementAgent } from "./agents/testrail-improvement-agent.js";
import { createAutomationDesignerAgent } from "./agents/automation-designer-agent.js";
import {
  createReliabilityDefectIntelligenceAgent,
} from "./agents/reliability-defect-intelligence-agent.js";
import { createKnowledgeCuratorAgent } from "./agents/knowledge-curator-agent.js";
import {
  createAskTklAgent,
  requiredPermissionForAskTkl,
  resolveAskTklIntent,
} from "./agents/ask-tkl-agent.js";
import {
  createApprovedActionService,
  permissionForApprovedAction,
} from "./approved-action-service.js";
import { createKnowledgeInventoryService } from "./knowledge-inventory-service.js";
import { createArtifactResolverService } from "./artifact-resolver-service.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function jsonResponse(status, body) {
  return {
    status,
    headers: JSON_HEADERS,
    body
  };
}

function ok(body, contractName) {
  const validation = validateApiResponse(contractName, body);
  if (!validation.valid) {
    throw new ApiError(500, "invalid_service_response", validation.message);
  }
  return jsonResponse(200, body);
}

function errorResponse(error) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "An unexpected error occurred.");

  return jsonResponse(apiError.status, {
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {})
    }
  });
}

/**
 * @typedef {Object} KnowledgeService
 * @property {(request: {productId: string, source?: string, query: string, limit: number, offset: number}) => Promise<Object>} search
 * @property {(request: {productId: string, source?: string, storyId: string}) => Promise<Object>} getStoryTestContext
 * @property {(request: {productId: string, source?: string, requirementId: string}) => Promise<Object>} analyzeRequirementCoverage
 * @property {(request: {productId: string, source?: string, requirementId: string}) => Promise<Object>} explainTraceability
 * @property {(request: {productId: string, source?: string}) => Promise<Object>} listKnowledgeConflicts
 * @property {(request: {productId: string, source?: string, conflictId: string, approvedClaimIds: string[], reviewerId: string, reviewedAt: string, note?: string}) => Promise<Object>} reviewConflict
 * @property {(request: {productId: string, workItemId: string}) => Promise<Object>} getKnowledgeCurationContext
 * @property {(request: {productId: string, uri: string}) => Promise<Object>} readResource
 */

export function createApplication({
  knowledgeService = createKnowledgeService(),
  evaluationRunner = runEvaluation,
  coverageContextAgent,
  testDesignerAgent,
  testRailImprovementAgent,
  automationDesignerAgent,
  reliabilityDefectIntelligenceAgent,
  knowledgeCuratorAgent,
  askTklAgent,
  approvedActionService,
  knowledgeInventoryService,
  rawEvidenceStoreProvider,
  auditLogger = createAuditLogger(),
  rateLimiter = createRateLimiter(),
  healthRegistry = createHealthRegistry(),
  sourceConnectionService,
  ticketContextCoordinator,
  crossSourceContextCoordinator,
  jiraWebhookService,
  artifactResolverService
} = {}) {
  const service = knowledgeService;
  const contextAgent = coverageContextAgent
    ?? createCoverageContextAgent({ knowledgeService: service });
  const designerAgent = testDesignerAgent
    ?? createTestDesignerAgent({ knowledgeService: service });
  const improvementAgent = testRailImprovementAgent
    ?? createTestRailImprovementAgent({ knowledgeService: service });
  const automationAgent = automationDesignerAgent
    ?? createAutomationDesignerAgent({
      knowledgeService: service,
      testDesignerAgent: designerAgent,
    });
  const reliabilityAgent = reliabilityDefectIntelligenceAgent
    ?? createReliabilityDefectIntelligenceAgent({ knowledgeService: service });
  const curatorAgent = knowledgeCuratorAgent
    ?? createKnowledgeCuratorAgent({ knowledgeService: service });
  const askAgent = askTklAgent
    ?? createAskTklAgent({
      knowledgeService: service,
      coverageContextAgent: contextAgent,
      testDesignerAgent: designerAgent,
      testRailImprovementAgent: improvementAgent,
      automationDesignerAgent: automationAgent,
      reliabilityDefectIntelligenceAgent: reliabilityAgent,
      knowledgeCuratorAgent: curatorAgent,
    });
  const actionService = approvedActionService
    ?? createApprovedActionService({
      tenantId: service.tenantId ?? "solera",
      auditLogger,
    });
  const inventoryService = knowledgeInventoryService
    ?? createKnowledgeInventoryService({
      knowledgeService: service,
      rawEvidenceStoreProvider,
      sourceConnectionService,
    });
  const artifactResolver = artifactResolverService
    ?? (
      typeof service.search === "function"
        ? createArtifactResolverService({
            knowledgeService: service,
            sourceConnectionService
          })
        : null
    );
  const authorize = (authContext, permission, productId) =>
    assertAuthorized(authContext, {
      permission,
      productId,
      tenantId: service.tenantId,
    });
  const runCrossSourceEnrichment = async (request) => {
    if (!crossSourceContextCoordinator?.enrich) return undefined;
    try {
      return await crossSourceContextCoordinator.enrich(request);
    } catch (error) {
      await auditLogger.record({
        eventType: "knowledge.cross_source_context.failed",
        productId: request.productId,
        source: request.anchor.source,
        resourceId: request.anchor.externalId,
        outcome: "failure",
        code: error?.code ?? "cross_source_context_failed",
      });
      return undefined;
    }
  };
  const enrichJiraRequest = async (request, intent) => {
    if (!request.workItemId) return undefined;
    return runCrossSourceEnrichment({
        productId: request.productId,
        anchor: {
          source: "jira",
          type: "requirement",
          externalId: request.workItemId,
        },
        intent,
        ...(request.suiteId && request.sectionId
          ? {
              testRailScope: {
                suiteId: request.suiteId,
                sectionId: request.sectionId,
              },
            }
          : {}),
      });
  };
  const withCrossSourceContext = (result, context) => context
    ? {
        ...result,
        crossSourceContext: {
          anchor: context.anchor,
          sourceStatus: context.sourceStatus,
          candidateRelationships: context.candidateRelationships,
          limitations: context.limitations,
          confidence: context.confidence,
          citations: context.citations,
        },
      }
    : result;
  const authorizeAction = (authContext, actionType, productId) => {
    const permission = permissionForApprovedAction(actionType);
    authorize(authContext, permission, productId);
    if (!authContext.permissions.includes(permission)) {
      throw new PolicyError(
        403,
        "forbidden",
        "Approved actions require an explicit action-specific permission.",
        { permission },
      );
    }
  };

  return {
    async handle({
      method,
      pathname,
      url,
      authContext,
      correlationId,
      body,
      rawBody,
      headers
    }) {
      const requestCorrelationId = correlationId ?? createCorrelationId();
      const startedAt = Date.now();
      let outcome = "success";
      let status = 200;
      let operation = `${method} ${pathname}`;
      let productId;

      function checkRateLimit() {
        if (authContext?.subject) {
          rateLimiter.assertWithinLimit(authContext.subject);
        }
      }

      try {
        if (method === "GET" && pathname === "/health") {
          if (typeof ticketContextCoordinator?.health === "function") {
            try {
              const ticketContextHealth = await ticketContextCoordinator.health();
              healthRegistry.record(
                "ticket-context",
                {
                  status: ticketContextHealth.status === "healthy"
                    ? "healthy"
                    : "degraded",
                  reasons: Array.isArray(ticketContextHealth.reasons)
                    ? ticketContextHealth.reasons.filter((reason) =>
                        typeof reason === "string" && /^[a-z0-9_]{1,64}$/.test(reason)
                      )
                    : []
                }
              );
            } catch {
              healthRegistry.record("ticket-context", {
                status: "degraded",
                reasons: ["health_check_failed"]
              });
            }
          }
          const correlatedHealth = healthRegistry.report();
          return ok(
            {
              status: correlatedHealth.status === "degraded" ? "degraded" : "ok",
              service: "tkl-api",
              correlationId: requestCorrelationId,
              dependencies: correlatedHealth
            },
            "health"
          );
        }

        if (method === "POST" && pathname === "/v1/webhooks/jira") {
          operation = "receive_jira_webhook";
          if (url.search.length > 0) {
            throw new ApiError(
              400,
              "invalid_request",
              "The Jira webhook route does not accept query parameters."
            );
          }
          if (!jiraWebhookService) {
            throw new ApiError(
              404,
              "webhook_not_configured",
              "The Jira webhook is not configured."
            );
          }
          productId = jiraWebhookService.productId;
          const result = await jiraWebhookService.handle({ rawBody, headers });
          status = 202;
          return jsonResponse(202, { disposition: result.disposition });
        }

        if (method === "GET" && pathname === "/v1/context-operations") {
          const request = parseTicketContextOperationsRequest(url);
          productId = request.productId;
          operation = "get_ticket_context_operations";
          authorize(authContext, "connections:read", productId);
          checkRateLimit();
          requireTicketContextCoordinator(ticketContextCoordinator);
          if (typeof ticketContextCoordinator.operations !== "function") {
            throw new ApiError(
              503,
              "context_operations_unavailable",
              "Ticket context operations are unavailable."
            );
          }
          return jsonResponse(200, {
            operations: await ticketContextCoordinator.operations(request)
          });
        }

        if (method === "GET" && pathname === "/v1/knowledge/search") {
          const request = parseSearchRequest(url);
          productId = request.productId;
          operation = "search_quality_knowledge";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          return ok(await service.search(request), "search_quality_knowledge");
        }

        if (method === "GET" && pathname === "/v1/artifacts/resolve") {
          const request = parseArtifactResolveRequest(url);
          productId = request.productId;
          operation = "resolve_artifact";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          if (!artifactResolver) {
            throw new ApiError(
              503,
              "artifact_resolution_unavailable",
              "Artifact resolution is unavailable."
            );
          }
          return jsonResponse(200, await artifactResolver.resolve(request));
        }

        if (method === "GET" && pathname === "/v1/evidence-graph") {
          const request = parseEvidenceGraphRequest(url);
          productId = request.productId;
          operation = "read_evidence_graph";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          return jsonResponse(200, await service.getEvidenceGraph(request));
        }

        if (method === "GET" && pathname === "/v1/intelligence/traceability") {
          const request = parseSearchRequest(url);
          productId = request.productId;
          operation = "list_story_traceability";
          authorize(authContext, "traceability:read", request.productId);
          checkRateLimit();
          return ok(
            await service.listStoryTraceability(request),
            "search_quality_knowledge"
          );
        }

        if (method === "GET" && pathname === "/v1/intelligence/coverage") {
          const request = parseSearchRequest(url);
          productId = request.productId;
          operation = "list_coverage_gaps";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          return ok(
            await service.listCoverageGaps(request),
            "search_quality_knowledge"
          );
        }

        if (method === "GET" && pathname === "/v1/intelligence/knowledge-inventory") {
          const request = parseProductRequest(url);
          productId = request.productId;
          operation = "get_knowledge_inventory";
          authorize(authContext, "knowledge:read", request.productId);
          authorize(authContext, "coverage:read", request.productId);
          authorize(authContext, "conflicts:read", request.productId);
          authorize(authContext, "connections:read", request.productId);
          checkRateLimit();
          return ok(
            await inventoryService.getInventory(request),
            "knowledge_inventory"
          );
        }

        if (method === "GET" && pathname === "/v1/evaluation/metrics") {
          const request = parseProductRequest(url);
          productId = request.productId;
          operation = "get_evaluation_metrics";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          const report = await evaluationRunner();
          return jsonResponse(200, report.metrics);
        }

        if (method === "POST" && pathname === "/v1/agents/coverage-context/runs") {
          const request = parseCoverageContextAgentRequest(url, body);
          productId = request.productId;
          operation = "run_coverage_context_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = await enrichJiraRequest(request, "coverage-analysis");
          return ok(
            withCrossSourceContext(
              await contextAgent.execute(request),
              unifiedContext,
            ),
            "coverage_context_agent_run"
          );
        }

        if (method === "POST" && pathname === "/v1/agents/test-designer/runs") {
          const request = parseCoverageContextAgentRequest(
            url,
            body,
            { allowTestRailScope: true },
          );
          productId = request.productId;
          operation = "run_test_designer_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = await enrichJiraRequest(request, "test-design");
          return ok(
            withCrossSourceContext(
              await designerAgent.execute({
                ...request,
                ...(unifiedContext ? { unifiedContext } : {}),
              }),
              unifiedContext,
            ),
            "test_designer_agent_run"
          );
        }

        if (method === "POST" && pathname === "/v1/agents/testrail-improvement/runs") {
          const request = parseCoverageContextAgentRequest(url, body);
          productId = request.productId;
          operation = "run_testrail_improvement_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = await enrichJiraRequest(request, "test-case-improvement");
          return ok(
            withCrossSourceContext(
              await improvementAgent.execute(request),
              unifiedContext,
            ),
            "testrail_improvement_agent_run"
          );
        }

        if (
          method === "POST"
          && /^\/v1\/agents\/testrail-improvement\/cases\/C?\d+\/runs$/i.test(pathname)
        ) {
          const request = parseTestRailCaseImprovementRequest(url, pathname);
          productId = request.productId;
          operation = "run_testrail_case_improvement_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = crossSourceContextCoordinator?.enrich
            ? await runCrossSourceEnrichment({
                productId: request.productId,
                anchor: {
                  source: "testrail",
                  type: "manual-test",
                  externalId: request.caseId,
                },
                intent: "test-case-improvement",
              })
            : undefined;
          return ok(
            withCrossSourceContext(await improvementAgent.execute({
              ...request,
              ...(unifiedContext ? { unifiedContext } : {}),
            }), unifiedContext),
            "testrail_improvement_agent_run"
          );
        }

        if (method === "POST" && pathname === "/v1/agents/automation-designer/runs") {
          const request = parseCoverageContextAgentRequest(url, body);
          productId = request.productId;
          operation = "run_automation_designer_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = await enrichJiraRequest(request, "automation-design");
          return ok(
            withCrossSourceContext(
              await automationAgent.execute(request),
              unifiedContext,
            ),
            "automation_designer_agent_run"
          );
        }

        if (
          method === "POST"
          && pathname === "/v1/agents/reliability-defect-intelligence/runs"
        ) {
          const request = parseCoverageContextAgentRequest(url, body);
          productId = request.productId;
          operation = "run_reliability_defect_intelligence_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          const unifiedContext = await enrichJiraRequest(request, "reliability-analysis");
          return ok(
            withCrossSourceContext(
              await reliabilityAgent.execute(request),
              unifiedContext,
            ),
            "reliability_defect_intelligence_agent_run"
          );
        }

        if (
          method === "POST"
          && pathname === "/v1/agents/reliability-defect-intelligence/reportportal/runs"
        ) {
          const request = parseReportPortalReliabilityRequest(url, body);
          productId = request.productId;
          operation = "run_reportportal_reliability_intelligence_agent";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          await sourceConnectionService?.hydrateReportPortalTestHistory?.({
            ...request,
            identity: request.retrievalIdentity ?? request.identity,
          });
          return ok(
            await reliabilityAgent.execute({
              productId: request.productId,
              identity: request.identity,
            }),
            "reliability_defect_intelligence_agent_run"
          );
        }

        if (method === "POST" && pathname === "/v1/agents/knowledge-curator/runs") {
          const request = parseCoverageContextAgentRequest(url, body);
          productId = request.productId;
          operation = "run_knowledge_curator_agent";
          authorize(authContext, "conflicts:read", request.productId);
          checkRateLimit();
          return ok(
            await curatorAgent.execute(request),
            "knowledge_curator_agent_run"
          );
        }

        if (method === "POST" && pathname === "/v1/ask") {
          const request = parseAskTklRequest(url, body);
          productId = request.productId;
          operation = "ask_tkl";
          authorize(authContext, "ask:read", request.productId);
          const downstreamPermission = requiredPermissionForAskTkl(request);
          if (downstreamPermission) {
            authorize(authContext, downstreamPermission, request.productId);
          }
          checkRateLimit();
          const resolvedIntent = resolveAskTklIntent(request);
          const caseId = resolvedIntent.classification.primary === "testrail-improvement"
            ? resolvedIntent.resolvedCaseId
            : undefined;
          const issueKey = resolvedIntent.classification.primary !== "testrail-improvement"
            ? resolvedIntent.resolvedWorkItemId
            : undefined;
          let unifiedContext;
          if (crossSourceContextCoordinator?.enrich && caseId) {
            unifiedContext = await runCrossSourceEnrichment({
                productId: request.productId,
                anchor: {
                  source: "testrail",
                  type: "manual-test",
                  externalId: caseId,
                },
                intent: "cross-source-intelligence",
              });
          } else if (crossSourceContextCoordinator?.enrich && issueKey) {
            unifiedContext = await runCrossSourceEnrichment({
                  productId: request.productId,
                  anchor: {
                    source: "jira",
                    type: "requirement",
                    externalId: issueKey,
                  },
                  intent: "cross-source-intelligence",
                });
          }
          return ok(
            await askAgent.execute({
              ...request,
              ...(unifiedContext ? { unifiedContext } : {}),
            }),
            "ask_tkl"
          );
        }

        if (method === "POST" && pathname === "/v1/actions/previews") {
          const request = parseApprovedActionPreviewRequest(url, body);
          productId = request.productId;
          operation = "preview_approved_action";
          authorizeAction(authContext, request.actionType, request.productId);
          checkRateLimit();
          return ok(
            await actionService.createPreview({
              ...request,
              subject: authContext.subject,
            }),
            "approved_action_preview",
          );
        }

        if (method === "POST" && pathname === "/v1/actions/approvals") {
          const request = parseApprovedActionApprovalRequest(url, body);
          productId = request.productId;
          operation = "approve_action_preview";
          authorizeAction(authContext, request.actionType, request.productId);
          checkRateLimit();
          return ok(
            await actionService.approve({
              ...request,
              subject: authContext.subject,
            }),
            "approved_action_approval",
          );
        }

        if (method === "POST" && pathname === "/v1/actions/executions") {
          const request = parseApprovedActionExecutionRequest(url, body);
          productId = request.productId;
          operation = "execute_approved_action";
          authorizeAction(authContext, request.actionType, request.productId);
          checkRateLimit();
          return ok(
            await actionService.execute({
              ...request,
              subject: authContext.subject,
            }),
            "approved_action_execution",
          );
        }

        if (method === "GET" && pathname === "/v1/story/test-context") {
          const request = parseResourceRequest(url, "storyId");
          productId = request.productId;
          operation = "get_story_test_context";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          return ok(
            await service.getStoryTestContext(request),
            "get_story_test_context"
          );
        }

        if (method === "GET" && pathname === "/v1/requirements/coverage") {
          const request = parseResourceRequest(url, "requirementId");
          productId = request.productId;
          operation = "analyze_requirement_coverage";
          authorize(authContext, "coverage:read", request.productId);
          checkRateLimit();
          return ok(
            await service.analyzeRequirementCoverage(request),
            "analyze_requirement_coverage"
          );
        }

        if (method === "GET" && pathname === "/v1/traceability") {
          const request = parseResourceRequest(url, "requirementId");
          productId = request.productId;
          operation = "explain_traceability";
          authorize(authContext, "traceability:read", request.productId);
          checkRateLimit();
          return ok(
            await service.explainTraceability(request),
            "explain_traceability"
          );
        }

        if (method === "GET" && pathname === "/v1/knowledge/conflicts") {
          const request = parseProductRequest(url);
          productId = request.productId;
          operation = "list_knowledge_conflicts";
          authorize(authContext, "conflicts:read", productId);
          checkRateLimit();
          return ok(
            await service.listKnowledgeConflicts(request),
            "list_knowledge_conflicts"
          );
        }

        if (method === "POST" && pathname === "/v1/knowledge/conflicts/review") {
          const request = parseKnowledgeConflictReviewRequest(url, body);
          productId = request.productId;
          operation = "review_knowledge_conflict";
          authorize(authContext, "conflicts:review", request.productId);
          checkRateLimit();
          return ok(
            await service.reviewConflict({
              ...request,
              reviewerId: authContext.subject,
              reviewedAt: new Date().toISOString()
            }),
            "review_knowledge_conflict"
          );
        }

        if (method === "GET" && pathname === "/v1/resources/read") {
          const request = parseResourceReadRequest(url);
          productId = request.productId;
          operation = "read_resource";
          authorize(authContext, "knowledge:read", request.productId);
          checkRateLimit();
          return ok(await service.readResource(request), "read_resource");
        }

        if (method === "GET" && /^\/v1\/context-jobs\/[^/]+$/.test(pathname)) {
          const request = parseTicketContextJobRequest(url, pathname);
          productId = request.productId;
          operation = "get_ticket_context_job";
          authorize(authContext, "knowledge:read", productId);
          checkRateLimit();
          requireTicketContextCoordinator(ticketContextCoordinator);
          return jsonResponse(200, {
            job: await ticketContextCoordinator.get(request)
          });
        }

        if (
          method === "POST"
          && /^\/v1\/context-jobs\/[^/]+\/refresh$/.test(pathname)
        ) {
          const request = parseTicketContextJobRequest(url, pathname, "refresh");
          productId = request.productId;
          operation = "refresh_ticket_context_job";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireTicketContextCoordinator(ticketContextCoordinator);
          return jsonResponse(202, {
            job: await ticketContextCoordinator.enqueue({ ...request, force: true })
          });
        }

        if (method === "DELETE" && /^\/v1\/context-jobs\/[^/]+$/.test(pathname)) {
          const request = parseTicketContextJobRequest(url, pathname);
          productId = request.productId;
          operation = "cancel_ticket_context_job";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireTicketContextCoordinator(ticketContextCoordinator);
          return jsonResponse(200, {
            job: await ticketContextCoordinator.cancel(request)
          });
        }

        if (method === "GET" && pathname === "/v1/source-connections") {
          const request = parseProductRequest(url);
          productId = request.productId;
          operation = "list_source_connections";
          authorize(authContext, "connections:read", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            connections: await sourceConnectionService.list({ productId })
          });
        }

        if (
          method === "GET"
          && pathname === "/v1/source-connections/github/repositories"
        ) {
          const request = parseProductRequest(url);
          productId = request.productId;
          operation = "list_github_repository_targets";
          authorize(authContext, "connections:read", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repositories: await sourceConnectionService.listGitHubRepositories(request)
          });
        }

        if (
          method === "POST"
          && pathname === "/v1/source-connections/github/repositories"
        ) {
          const request = parseGitHubRepositoryCreateRequest(url, body);
          productId = request.productId;
          operation = "create_github_repository_target";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(201, {
            repository: await sourceConnectionService.createGitHubRepository(request)
          });
        }

        if (
          method === "GET"
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryProductRequest(url, pathname);
          productId = request.productId;
          operation = "get_github_repository_target";
          authorize(authContext, "connections:read", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repository: await sourceConnectionService.getGitHubRepository(request)
          });
        }

        if (
          ["PUT", "PATCH"].includes(method)
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryUpdateRequest(url, pathname, body);
          productId = request.productId;
          operation = "update_github_repository_target";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repository: await sourceConnectionService.updateGitHubRepository(request)
          });
        }

        if (
          method === "DELETE"
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryProductRequest(url, pathname);
          productId = request.productId;
          operation = "delete_github_repository_target";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repository: await sourceConnectionService.deleteGitHubRepository(request)
          });
        }

        if (
          method === "POST"
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+\/test$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryProductRequest(url, pathname);
          productId = request.productId;
          operation = "test_github_repository_target";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repository: await sourceConnectionService.testGitHubRepository(request)
          });
        }

        if (
          method === "POST"
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+\/sync$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryProductRequest(url, pathname);
          productId = request.productId;
          operation = "reject_github_repository_target_sync";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          throw new ApiError(
            409,
            "broad_sync_disabled",
            "Repository synchronization is disabled. Repository scopes are queried on demand."
          );
        }

        if (
          method === "DELETE"
          && /^\/v1\/source-connections\/github\/repositories\/[^/]+\/sync$/.test(pathname)
        ) {
          const request = parseGitHubRepositoryProductRequest(url, pathname);
          productId = request.productId;
          operation = "cancel_github_repository_target_sync";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            repository: await sourceConnectionService.cancelGitHubRepositorySync(request)
          });
        }

        if (method === "PUT" && /^\/v1\/source-connections\/[^/]+$/.test(pathname)) {
          const request = parseSourceConnectionRequest(url, pathname, body);
          productId = request.productId;
          operation = "save_source_connection";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            connection: await sourceConnectionService.connect({
              ...request,
              ownerSubject: authContext.subject
            })
          });
        }

        if (method === "POST" && pathname === "/v1/source-connections/testrail/discover") {
          const request = parseTestRailSuiteDiscoveryRequest(url, body);
          productId = request.productId;
          operation = "discover_testrail_suites";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            suites: await sourceConnectionService.discoverTestRailSuites(request)
          });
        }

        if (method === "POST" && pathname === "/v1/source-connections/testrail/sections") {
          const request = parseTestRailSectionDiscoveryRequest(url, body);
          productId = request.productId;
          operation = "discover_testrail_sections";
          authorize(authContext, "connections:read", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            sections: await sourceConnectionService.discoverTestRailSections(request)
          });
        }

        if (method === "POST" && pathname === "/v1/source-connections/confluence/discover") {
          const request = parseConfluencePageDiscoveryRequest(url, body);
          productId = request.productId;
          operation = "discover_confluence_pages";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            discovery: await sourceConnectionService.discoverConfluencePages(request)
          });
        }

        if (method === "POST" && /^\/v1\/source-connections\/[^/]+\/test$/.test(pathname)) {
          const request = parseSourceConnectionProductRequest(url, pathname);
          productId = request.productId;
          operation = "test_source_connection";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            connection: await sourceConnectionService.test(request)
          });
        }

        if (method === "POST" && /^\/v1\/source-connections\/[^/]+\/sync$/.test(pathname)) {
          const request = parseSourceConnectionProductRequest(url, pathname);
          productId = request.productId;
          operation = "reject_source_connection_sync";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          throw new ApiError(
            409,
            "broad_sync_disabled",
            "Broad source synchronization is disabled. Search for an exact artifact to retrieve it on demand."
          );
        }

        if (method === "DELETE" && /^\/v1\/source-connections\/[^/]+\/sync$/.test(pathname)) {
          const request = parseSourceConnectionProductRequest(url, pathname);
          productId = request.productId;
          operation = "cancel_source_connection_sync";
          authorize(authContext, "connections:sync", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            connection: await sourceConnectionService.cancelSync(request)
          });
        }

        if (method === "DELETE" && /^\/v1\/source-connections\/[^/]+$/.test(pathname)) {
          const request = parseSourceConnectionProductRequest(url, pathname);
          productId = request.productId;
          operation = "disconnect_source_connection";
          authorize(authContext, "connections:write", productId);
          checkRateLimit();
          requireSourceConnectionService(sourceConnectionService);
          return jsonResponse(200, {
            connection: await sourceConnectionService.disconnect(request)
          });
        }

        if (pathname === "/v1/webhooks/jira") {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (
          pathname === "/v1/ask"
          || pathname === "/v1/actions/previews"
          || pathname === "/v1/actions/approvals"
          || pathname === "/v1/actions/executions"
        ) {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (/^\/v1\/context-jobs\/[^/]+\/refresh$/.test(pathname)) {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (/^\/v1\/context-jobs\/[^/]+$/.test(pathname)) {
          if (!["GET", "DELETE"].includes(method)) {
            throw methodNotAllowed(["GET", "DELETE"]);
          }
        } else if (pathname === "/v1/knowledge/conflicts/review") {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (pathname === "/v1/source-connections") {
          if (method !== "GET") {
            throw methodNotAllowed(["GET"]);
          }
        } else if (pathname === "/v1/source-connections/github/repositories") {
          if (!["GET", "POST"].includes(method)) {
          throw methodNotAllowed(["GET", "POST"]);
          }
        } else if (
          /^\/v1\/source-connections\/github\/repositories\/[^/]+\/test$/.test(pathname)
        ) {
          if (method !== "POST") {
          throw methodNotAllowed(["POST"]);
          }
        } else if (
          /^\/v1\/source-connections\/github\/repositories\/[^/]+\/sync$/.test(pathname)
        ) {
          if (!["POST", "DELETE"].includes(method)) {
          throw methodNotAllowed(["POST", "DELETE"]);
          }
        } else if (
          /^\/v1\/source-connections\/github\/repositories\/[^/]+$/.test(pathname)
        ) {
          if (!["GET", "PUT", "PATCH", "DELETE"].includes(method)) {
          throw methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
          }
        } else if (
          pathname === "/v1/source-connections/testrail/discover"
          || pathname === "/v1/source-connections/testrail/sections"
          || pathname === "/v1/source-connections/confluence/discover"
        ) {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (/^\/v1\/source-connections\/[^/]+\/test$/.test(pathname)) {
          if (method !== "POST") {
            throw methodNotAllowed(["POST"]);
          }
        } else if (/^\/v1\/source-connections\/[^/]+\/sync$/.test(pathname)) {
          if (!["POST", "DELETE"].includes(method)) {
            throw methodNotAllowed(["POST", "DELETE"]);
          }
        } else if (/^\/v1\/source-connections\/[^/]+$/.test(pathname)) {
          if (!["PUT", "DELETE"].includes(method)) {
            throw methodNotAllowed(["PUT", "DELETE"]);
          }
        } else if (pathname === "/health" || pathname.startsWith("/v1/")) {
          if (method !== "GET") {
            throw methodNotAllowed(["GET"]);
          }
        }

        throw notFound("API route not found");
      } catch (error) {
        outcome = "failure";
        status = error.status ?? 500;
        if (error instanceof PolicyError || error instanceof SecurityError) {
          return jsonResponse(status, {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {})
            }
          });
        }
        const response = errorResponse(error);
        status = response.status;
        return response;
      } finally {
        await auditLogger.record({
          eventType: "api.request",
          correlationId: requestCorrelationId,
          operation,
          method,
          path: pathname,
          subject: authContext?.subject,
          productId,
          outcome,
          status,
          durationMs: Date.now() - startedAt
        });
      }
    }
  };
}

function requireSourceConnectionService(service) {
  if (!service) {
    throw new ApiError(
      503,
      "source_connections_unavailable",
      "Source connection management is not configured for this deployment."
    );
  }
}

function requireTicketContextCoordinator(coordinator) {
  if (!coordinator) {
    throw new ApiError(
      503,
      "context_jobs_unavailable",
      "Ticket context job coordination is unavailable."
    );
  }
}
