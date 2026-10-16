import { ApiError } from "./errors.js";

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1_000;
const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const TICKET_METHODS = Object.freeze({
  getStoryTestContext: "storyId",
  getRequirementSummaryContext: "workItemId",
  analyzeRequirementCoverage: "requirementId",
  explainTraceability: "requirementId",
  getCoverageContext: "workItemId",
  getTestDesignContext: "workItemId",
  getTestRailImprovementContext: "workItemId",
  getAutomationDesignContext: "workItemId",
  getReliabilityIntelligenceContext: "workItemId",
  getKnowledgeCurationContext: "workItemId",
});

export function createReadThroughKnowledgeService({
  knowledgeService,
  sourceConnectionService,
  ticketContextCoordinator,
  freshnessMs = DEFAULT_FRESHNESS_MS,
  now = () => Date.now(),
  auditLogger
}) {
  if (!knowledgeService || typeof knowledgeService.requirementContextStatus !== "function") {
    throw new TypeError("knowledgeService.requirementContextStatus is required");
  }
  if (!sourceConnectionService || typeof sourceConnectionService.hydrateJiraIssue !== "function") {
    throw new TypeError("sourceConnectionService.hydrateJiraIssue is required");
  }
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) {
    throw new TypeError("freshnessMs must be a non-negative integer");
  }
  const inflight = new Map();
  const successfulRetrievals = new Map();
  const failedRetrievals = new Map();

  function pruneExpiredReceipts(receipts) {
    const cutoff = now() - freshnessMs;
    for (const [key, receipt] of receipts) {
      const timestamp = typeof receipt === "number" ? receipt : receipt.timestamp;
      if (timestamp < cutoff) receipts.delete(key);
    }
  }

  function triggerEnrichment(productId, issueKey) {
    if (!ticketContextCoordinator?.enqueue) return;
    void ticketContextCoordinator.enqueue({
      productId,
      issueKey
    }).catch((error) => {
      emitAudit(auditLogger, {
        eventType: "knowledge.enrichment.enqueue_failed",
        productId,
        resourceId: issueKey,
        code: error?.code ?? "enrichment_enqueue_failed"
      });
    });
  }

  async function ensureTicketContext(request, resourceField) {
    const rawKey = request?.[resourceField];
    const issueKey = canonicalJiraKey(rawKey);
    if (!issueKey || (request.source && request.source !== "jira")) return;
    const status = knowledgeService.requirementContextStatus({
      productId: request.productId,
      workItemId: issueKey
    });
    pruneExpiredReceipts(successfulRetrievals);
    pruneExpiredReceipts(failedRetrievals);
    const lastObservedMillis = status.lastObservedAt
      ? Date.parse(status.lastObservedAt)
      : Number.NaN;
    const retrievalKey = `${request.productId}:${issueKey}`;
    const lastRetrievedMillis = successfulRetrievals.get(retrievalKey) ?? Number.NaN;
    const durableReceipt = await ticketContextCoordinator?.getJiraReceipt?.({
      productId: request.productId,
      issueKey
    });
    const failedReceipt = ["unavailable", "not-connected"].includes(durableReceipt?.state)
      ? {
          timestamp: Date.parse(durableReceipt.completedAt),
          status: durableReceipt.error?.code === "jira_issue_not_found"
            ? 404
            : durableReceipt.state === "not-connected" ? 409 : 502,
          code: durableReceipt.error?.code ?? "context_retrieval_failed",
          message: durableReceipt.error?.message
            ?? "The requested Jira context could not be retrieved."
        }
      : failedRetrievals.get(retrievalKey);
    const durableSuccessMillis = ["local", "refreshed", "complete", "partial"]
      .includes(durableReceipt?.state)
      ? Date.parse(durableReceipt.completedAt)
      : Number.NaN;
    if (
      !status.exists
      && failedReceipt
      && now() - failedReceipt.timestamp <= freshnessMs
    ) {
      throw new ApiError(
        failedReceipt.status,
        failedReceipt.code,
        failedReceipt.message
      );
    }
    const fresh = status.exists
      && (
        (Number.isFinite(lastObservedMillis) && now() - lastObservedMillis <= freshnessMs)
        || (Number.isFinite(lastRetrievedMillis) && now() - lastRetrievedMillis <= freshnessMs)
        || (Number.isFinite(durableSuccessMillis) && now() - durableSuccessMillis <= freshnessMs)
      )
      || (
        !status.exists
        && (
          (Number.isFinite(lastRetrievedMillis) && now() - lastRetrievedMillis <= freshnessMs)
          || (Number.isFinite(durableSuccessMillis) && now() - durableSuccessMillis <= freshnessMs)
        )
      );
    if (fresh) {
        if (!durableReceipt && status.exists) {
          void Promise.resolve(ticketContextCoordinator?.recordJiraOutcome?.({
              productId: request.productId,
              issueKey,
              state: "local",
              recordsCollected: 0,
              truncated: false
            }))
            .catch((error) => {
              emitAudit(auditLogger, {
                eventType: "knowledge.jira_receipt.persist_failed",
                productId: request.productId,
                resourceId: issueKey,
                code: error?.code ?? "context_job_persistence_failed"
              });
            });
        }
        triggerEnrichment(request.productId, issueKey);
        return;
      }

    const key = retrievalKey;
    let retrieval = inflight.get(key);
    if (!retrieval) {
      emitAudit(auditLogger, {
        eventType: "knowledge.retrieval.started",
        productId: request.productId,
        source: "jira",
        resourceId: issueKey,
        reason: status.exists ? "stale" : "missing"
      });
      retrieval = sourceConnectionService.hydrateJiraIssue({
        productId: request.productId,
        issueKey
      }).then(async (result) => {
        successfulRetrievals.set(key, now());
        await ticketContextCoordinator?.recordJiraOutcome?.({
          productId: request.productId,
          issueKey,
          state: result.status === "partial" ? "partial" : "refreshed",
          recordsCollected: result.recordsCollected,
          truncated: result.truncated === true
        });
        triggerEnrichment(request.productId, issueKey);
        emitAudit(auditLogger, {
          eventType: "knowledge.retrieval.completed",
          productId: request.productId,
          source: "jira",
          resourceId: issueKey,
          status: result.status,
          recordsCollected: result.recordsCollected
        });
        return result;
      }).catch(async (error) => {
        emitAudit(auditLogger, {
          eventType: "knowledge.retrieval.failed",
          productId: request.productId,
          source: "jira",
          resourceId: issueKey,
          code: error?.code ?? "retrieval_failed"
        });
        const safeError = error instanceof ApiError
          ? error
          : new ApiError(
              502,
              "context_retrieval_failed",
              "The requested Jira context could not be retrieved."
            );
        failedRetrievals.set(key, {
          timestamp: now(),
          status: safeError.status,
          code: safeError.code,
          message: safeError.message
        });
        await ticketContextCoordinator?.recordJiraOutcome?.({
          productId: request.productId,
          issueKey,
          state: status.exists
            ? "local"
            : safeError.code === "source_not_connected" ? "not-connected" : "unavailable",
          error: safeError
        });
        if (status.exists) {
          triggerEnrichment(request.productId, issueKey);
          return null;
        }
        throw safeError;
      }).finally(() => {
        if (inflight.get(key) === retrieval) inflight.delete(key);
      });
      inflight.set(key, retrieval);
    }
    await retrieval;
  }

  return new Proxy(knowledgeService, {
    get(target, property, receiver) {
      const resourceField = TICKET_METHODS[property];
      const operation = Reflect.get(target, property, receiver);
      if (property === "readResource" && typeof operation === "function") {
        return async (request) => {
          const issueKey = jiraKeyFromResourceUri(request?.uri, request?.productId);
          if (issueKey) {
            await ensureTicketContext({ ...request, issueKey }, "issueKey");
          }
          return operation.call(target, request);
        };
      }
      if (!resourceField) return operation;
      if (typeof operation !== "function") return operation;
      return async (request) => {
        await ensureTicketContext(request, resourceField);
        return operation.call(target, request);
      };
    }
  });
}

function jiraKeyFromResourceUri(uri, productId) {
  let resource;
  try {
    resource = new URL(uri);
  } catch {
    return null;
  }
  let segments;
  try {
    segments = resource.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (
    resource.protocol !== "tkl:"
    || resource.hostname !== "products"
    || segments[0] !== productId
  ) {
    return null;
  }
  if (
    segments.length === 3
    && ["requirements", "traceability"].includes(segments[1])
  ) {
    return canonicalJiraKey(segments[2]);
  }
  if (
    segments.length === 5
    && segments[1] === "sources"
    && segments[2] === "jira"
    && segments[4] === "provenance"
  ) {
    return canonicalJiraKey(segments[3]);
  }
  return null;
}

function canonicalJiraKey(value) {
  if (typeof value !== "string") return null;
  const key = value.startsWith("requirement:") ? value.slice("requirement:".length) : value;
  return JIRA_KEY_PATTERN.test(key) ? key.toUpperCase() : null;
}

function emitAudit(auditLogger, event) {
  if (!auditLogger || typeof auditLogger.record !== "function") return;
  Promise.resolve(auditLogger.record(event)).catch(() => {});
}
