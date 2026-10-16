import { composeConnectors } from "@tkl/ingestion";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createPersistentRawEvidenceStore,
  rawEvidenceIdempotencyKey
} from "@tkl/raw-evidence-store";
import {
  createSyncCoordinator,
  reconcileEvidence,
  rebuildSilverFromRawEvidence
} from "@tkl/sync-coordinator";
import { yieldToEventLoop } from "./event-loop.js";

/**
 * Default Silver projection batch size. Kept small so each synchronous
 * normalization/SQLite batch between event-loop yields stays latency-safe: a
 * large batch (the previous default of 100) could hold the loop long enough to
 * starve concurrent `/health` and `/v1/source-connections` requests. Override
 * with `TKL_PROJECTION_BATCH_SIZE` or the `batchSize` option.
 */
const DEFAULT_PROJECTION_BATCH_SIZE = 25;
const DEFAULT_BACKGROUND_PROJECTION_BATCH_SIZE = 5;
/** Records processed between yields during record-by-record poison isolation. */
const DEFAULT_POISON_YIELD_INTERVAL = 25;
/** Warn (once per slow batch) when a projection batch exceeds this budget. */
const DEFAULT_SLOW_BATCH_THRESHOLD_MS = 1_000;
const DEFAULT_ON_DEMAND_MAX_RECORDS = 100;
const DEFAULT_ON_DEMAND_TIMEOUT_MS = 10_000;
const ON_DEMAND_JIRA_CONNECTOR_ID = "connector.jira.on-demand";
const ON_DEMAND_TESTRAIL_CONNECTOR_ID = "connector.testrail.on-demand";
const ON_DEMAND_REPORTPORTAL_CONNECTOR_ID = "connector.reportportal.on-demand";
const ON_DEMAND_CONFLUENCE_CONNECTOR_ID = "connector.confluence.on-demand";

function normalizePositiveInteger(value) {
  const text = typeof value === "number" || typeof value === "string"
    ? String(value).trim().replace(/^C/i, "")
    : "";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) return null;
  return BigInt(text).toString();
}

function resolveDefaultProjectionBatchSize() {
  const raw = process.env.TKL_PROJECTION_BATCH_SIZE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROJECTION_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_PROJECTION_BATCH_SIZE;
  return parsed;
}

function resolveDefaultBackgroundProjectionBatchSize() {
  const raw = process.env.TKL_BACKGROUND_PROJECTION_BATCH_SIZE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BACKGROUND_PROJECTION_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_BACKGROUND_PROJECTION_BATCH_SIZE;
  }
  return parsed;
}

const CONNECTOR_IDS = {
  jira: "connector.jira",
  github: "connector.github",
  testrail: "connector.testrail",
  confluence: "connector.confluence",
  reportportal: "connector.reportportal"
};

function githubRepositoryConnectorId(repositoryId) {
  if (
    typeof repositoryId !== "string"
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(repositoryId)
  ) {
    throw new SourceSyncError(
      "invalid_repository_id",
      "GitHub repository target ID is invalid."
    );
  }
  const safeId = repositoryId.replaceAll("_", "-").slice(0, 40);
  const hash = createHash("sha256").update(repositoryId).digest("hex").slice(0, 10);
  return `connector.github.repository.${safeId}-${hash}`;
}

function githubOnDemandConnectorId(repository) {
  const safeId = createHash("sha256")
    .update(repository.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `connector.github.on-demand.repository.${safeId}`;
}

function normalizedGitHubRepositories(value) {
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50) {
    throw new SourceSyncError(
      "invalid_source_configuration",
      "GitHub requires between 1 and 50 repository targets."
    );
  }
  const repositories = entries.map((entry) =>
    typeof entry === "string"
      ? entry.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
      : ""
  );
  if (
    repositories.some(
      (repository) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
          .test(repository)
    )
    || new Set(repositories.map((repository) => repository.toLowerCase())).size
      !== repositories.length
  ) {
    throw new SourceSyncError(
      "invalid_source_configuration",
      "GitHub repository targets must be unique owner/name values."
    );
  }
  return repositories;
}

export class SourceSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceSyncError";
    this.code = code;
  }
}

export function createSourceSyncRunner({
  tenantId,
  knowledgeService,
  dataDirectory,
  rawEvidenceKeyRef = "env://TKL_RAW_EVIDENCE_KEY",
  resolveRawEvidenceKey,
  allowedHosts = [],
  allowedInsecureHosts = [],
  allowInsecureLoopback = false,
  fetchImpl,
  auditLogger,
  healthRegistry,
  backgroundProjectionBatchSize = resolveDefaultBackgroundProjectionBatchSize(),
  rawStoreFactory = createPersistentRawEvidenceStore,
  composeConnectorsImpl = composeConnectors,
  coordinatorFactory = createSyncCoordinator,
  scheduleProjectionWork = yieldToEventLoop
}) {
  if (!knowledgeService || typeof knowledgeService.ingest !== "function") {
    throw new TypeError("knowledgeService.ingest is required");
  }
  if (!Number.isSafeInteger(backgroundProjectionBatchSize) || backgroundProjectionBatchSize < 1) {
    throw new TypeError("backgroundProjectionBatchSize must be a positive integer");
  }
  if (typeof scheduleProjectionWork !== "function") {
    throw new TypeError("scheduleProjectionWork must be a function");
  }
  const stores = new Map();
  const projectors = new Map();
  const projectionTails = new Map();

  async function getStore(productId) {
    let storePromise = stores.get(productId);
    if (!storePromise) {
      storePromise = Promise.resolve(rawStoreFactory({
        dataDirectory,
        tenantId,
        productId,
        keyRef: rawEvidenceKeyRef,
        resolveKey: resolveRawEvidenceKey
      }));
      stores.set(productId, storePromise);
    }
    return storePromise;
  }

  function getProjectorState(productId) {
    let state = projectors.get(productId);
    if (!state) {
      state = {
        running: false,
        requested: false,
        promise: null,
        passes: 0,
        projectedRecords: 0,
        lastErrorCode: null
      };
      projectors.set(productId, state);
    }
    return state;
  }

  async function runProjectionExclusive(productId, operation) {
    const previous = projectionTails.get(productId);
    let current;
    if (previous) {
      current = previous.then(operation, operation);
    } else {
      try {
        current = Promise.resolve(operation());
      } catch (error) {
        current = Promise.reject(error);
      }
    }
    const tail = current.then(() => undefined, () => undefined);
    projectionTails.set(productId, tail);
    try {
      return await current;
    } finally {
      if (projectionTails.get(productId) === tail) projectionTails.delete(productId);
    }
  }

  function emitProjectionAudit(event) {
    if (!auditLogger || typeof auditLogger.record !== "function") return;
    Promise.resolve()
      .then(() => auditLogger.record(event))
      .catch(() => {
        // Projection observability is best-effort and never rejects a worker.
      });
  }

  function startProjector(productId, store) {
    const state = getProjectorState(productId);
    state.requested = true;
    if (state.running) return state.promise;

    state.running = true;
    const worker = (async () => {
      try {
        await scheduleProjectionWork();
      } catch {
        state.lastErrorCode = "background_projection_failed";
        emitProjectionAudit({
          eventType: "sync.projection.failed",
          productId,
          code: state.lastErrorCode
        });
        return;
      }
      do {
        state.requested = false;
        try {
          const projected = await drainPendingProjections({
            store,
            projectRecords: (records) =>
              runProjectionExclusive(productId, () => knowledgeService.ingest(records)),
            batchSize: backgroundProjectionBatchSize,
            onSlowBatch: createSlowBatchObserver({ auditLogger, productId })
          });
          state.passes += 1;
          state.projectedRecords += projected;
          state.lastErrorCode = null;
          emitProjectionAudit({
            eventType: "sync.projection.completed",
            productId,
            projectedRecords: projected
          });
        } catch {
          state.lastErrorCode = "background_projection_failed";
          emitProjectionAudit({
            eventType: "sync.projection.failed",
            productId,
            code: state.lastErrorCode
          });
          break;
        }
      } while (state.requested);
    })().finally(() => {
      state.running = false;
      state.promise = null;
      if (state.requested) startProjector(productId, store);
    });
    // The worker catches projection failures. This terminal catch also makes
    // future refactors safe from unhandled background rejections.
    state.promise = worker.catch(() => undefined);
    return state.promise;
  }

  function scheduleProjectionIfPending(productId, store) {
    try {
      if (store.countPendingProjectionRecords() > 0) {
        void startProjector(productId, store);
      }
    } catch {
      emitProjectionAudit({
        eventType: "sync.projection.failed",
        productId,
        code: "background_projection_status_failed"
      });
    }
  }

  const syncSource = async function syncSource({
    productId,
    source,
    repositoryId,
    config,
    resolveCredential,
    signal
  }) {
    const pluginId = CONNECTOR_IDS[source];
    if (!pluginId) {
      throw new SourceSyncError(
        "ingestion_not_supported",
        `${source} connection validation is available, but knowledge ingestion is not implemented.`
      );
    }
    assertSyncSourceUrl(
      source,
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = productConfiguration({
      tenantId,
      productId,
      source,
      connectorId: pluginId,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [pluginId]: {
          fetch: fetchImpl,
          resolveCredential: async () => {
            const credential = await resolveCredential();
            return source === "testrail"
              ? Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64")
              : credential;
          }
        }
      }
    });
    const connectorId = source === "github" && repositoryId
      ? githubRepositoryConnectorId(repositoryId)
      : pluginId;
    const coordinator = coordinatorFactory({
      configuration,
      store,
      composition,
      ...(connectorId === pluginId
        ? {}
        : { connectorStorageIds: { [pluginId]: connectorId } }),
      auditLogger,
      healthRegistry
    });
    let summary;
    try {
      summary = await coordinator.runOnce({ connectorIds: [pluginId], signal });
    } finally {
      scheduleProjectionIfPending(productId, store);
    }
    if (
      summary.connectors?.some((result) => result.error?.code === "sync_cancelled")
    ) {
      throw new SourceSyncError(
        "sync_cancelled",
        "The synchronization was cancelled."
      );
    }
    if (summary.status !== "succeeded") {
      throw new SourceSyncError(
        "source_sync_failed",
        "The source sync did not complete successfully."
      );
    }
    return {
      runId: summary.runId,
      recordsCollected: summary.totals.recordCount,
      recordsCommitted: summary.totals.committedCount,
      duplicateRecords: summary.totals.duplicateCount,
      knowledgeRecordsProcessed: 0
    };
  };

  /**
   * Bounded, controlled Silver rebuild for one product (optionally one
   * source). Replays durable raw evidence back through the idempotent
   * knowledge ingest pipeline, so no source is contacted. Never processes the
   * full matched set implicitly: the caller must pass a finite `limit` or
   * `confirm: true`. Returns the sanitized rebuild progress including a
   * resumable cursor.
   */
  syncSource.rebuildSilver = async function rebuildSilver({
    productId,
    source,
    limit,
    cursor,
    batchSize,
    sourceVersion,
    observedFrom,
    observedTo,
    dryRun = false,
    confirm = false
  }) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new SourceSyncError("invalid_rebuild_request", "A productId is required to rebuild Silver.");
    }
    const store = await getStore(productId);
    const filters = {};
    if (source) filters.source = source;
    if (sourceVersion) filters.sourceVersion = sourceVersion;
    if (observedFrom) filters.observedFrom = observedFrom;
    if (observedTo) filters.observedTo = observedTo;
    return rebuildSilverFromRawEvidence({
      rawStore: store,
      projectRecords: (records) => knowledgeService.ingest(records),
      filters,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(batchSize === undefined ? {} : { batchSize }),
      dryRun,
      confirm
    });
  };

  /**
   * Non-mutating cross-tier reconciliation for one product. Compares the
   * durable raw evidence against the canonical (Silver) and serving (Gold)
   * counts the knowledge service can report, and returns structured findings.
   */
  syncSource.reconcile = async function reconcile({ productId, source } = {}) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new SourceSyncError("invalid_reconcile_request", "A productId is required to reconcile.");
    }
    const store = await getStore(productId);
    let knowledge;
    try {
      const servingProjectionBacklog =
        knowledgeService.pendingServingProjectionCount?.({ productId }) ?? 0;
      const knowledgeStore = knowledgeService.getStore?.(productId);
      knowledge = {
        servingProjectionBacklog,
        canonicalEntityCount: knowledgeStore?.listEntities?.(productId).length ?? 0,
        canonicalClaimCount: knowledgeStore?.listClaims?.().length ?? 0
      };
    } catch {
      knowledge = undefined;
    }
    return reconcileEvidence({
      rawStore: store,
      knowledge,
      filters: source ? { source } : {}
    });
  };

  /** Exposes the durable raw evidence store for a product (maintenance use). */
  syncSource.getRawStore = (productId) => getStore(productId);

  syncSource.clearGitHubRepositoryCheckpoint = async function clearGitHubRepositoryCheckpoint({
    productId,
    repositoryId
  }) {
    const store = await getStore(productId);
    await store.commit({
      connectorId: githubRepositoryConnectorId(repositoryId),
      records: [],
      checkpoint: null
    });
  };

  /**
   * Retrieves one exact Jira issue and its bounded comments without reading or
   * advancing the full-sync checkpoint. The small result is committed to
   * Bronze and projected to Silver before returning so the initiating read can
   * immediately use it.
   */
  syncSource.retrieveJiraIssue = async function retrieveJiraIssue({
    productId,
    issueKey,
    config,
    resolveCredential,
    signal,
    maxRecords = DEFAULT_ON_DEMAND_MAX_RECORDS,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey ?? "")) {
      throw new SourceSyncError(
        "invalid_issue_key",
        "A valid Jira issue key is required for targeted retrieval."
      );
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive integer");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("timeoutMs must be a positive integer");
    }
    assertSyncSourceUrl(
      "jira",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const normalizedIssueKey = issueKey.toUpperCase();
    const jiraConfiguration = connectorConfiguration(
      "jira",
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = {
      ...productConfiguration({
        tenantId,
        productId,
        source: "jira",
        connectorId: CONNECTOR_IDS.jira,
        config,
        allowedInsecureHosts,
        allowInsecureLoopback
      }),
      sources: {
        jira: {
          ...jiraConfiguration,
          issueKey: normalizedIssueKey
        }
      }
    };
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.jira]: {
          fetch: fetchImpl,
          resolveCredential
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.jira);
    if (!connector || typeof connector.collect !== "function") {
      throw new SourceSyncError(
        "ingestion_not_supported",
        "Targeted Jira retrieval is not available."
      );
    }

    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const records = [];
    let truncated = false;
    const iterator = connector.collect({}, { signal: combinedSignal })[Symbol.asyncIterator]();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      while (records.length < maxRecords) {
        const next = await iterator.next();
        if (next.done) break;
        records.push(next.value);
      }
      if (records.length === maxRecords) {
        truncated = true;
        await iterator.return?.();
      }
    } catch (error) {
      if (timeoutController.signal.aborted) {
        truncated = true;
      } else if (signal?.aborted) {
        throw new SourceSyncError(
          "retrieval_cancelled",
          "Targeted Jira retrieval was cancelled."
        );
      } else if (error?.status === 404 || error?.statusCode === 404) {
        throw new SourceSyncError(
          "jira_issue_not_found",
          "Jira could not find the requested issue."
        );
      } else {
        throw new SourceSyncError(
          "source_retrieval_failed",
          "Targeted Jira retrieval failed."
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    if (records.length === 0) {
      throw new SourceSyncError(
        timeoutController.signal.aborted ? "retrieval_timeout" : "jira_issue_not_found",
        timeoutController.signal.aborted
          ? "Targeted Jira retrieval exceeded its remote collection budget."
          : "Jira returned no evidence for the requested issue."
      );
    }

    const committed = await store.commit({
      connectorId: ON_DEMAND_JIRA_CONNECTOR_ID,
      records
    });
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    try {
      if (recordsToProject.length > 0) {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      }
    } catch (error) {
      scheduleProjectionIfPending(productId, store);
      throw error;
    }
    return {
      productId,
      issueKey: normalizedIssueKey,
      status: truncated ? "partial" : "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated
    };
  };

  syncSource.retrieveTestRailCases = async function retrieveTestRailCases({
    productId,
    issueKey,
    config,
    resolveCredential,
    signal,
    maxRecords = DEFAULT_ON_DEMAND_MAX_RECORDS,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey ?? "")) {
      throw new SourceSyncError(
        "invalid_issue_key",
        "A valid Jira issue key is required for TestRail enrichment."
      );
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new SourceSyncError("invalid_record_budget", "maxRecords must be a positive integer.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new SourceSyncError("invalid_timeout", "timeoutMs must be a positive integer.");
    }
    const configuration = productConfiguration({
      tenantId,
      productId,
      source: "testrail",
      connectorId: CONNECTOR_IDS.testrail,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    assertSyncSourceUrl(
      "testrail",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.testrail]: {
          fetch: fetchImpl,
          resolveCredential: async () => {
            const credential = await resolveCredential();
            return Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64");
          }
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.testrail);
    if (!connector || typeof connector.collectCasesByReference !== "function") {
      throw new SourceSyncError(
        "retrieval_not_supported",
        "Targeted TestRail retrieval is not available."
      );
    }
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    const budgetState = { truncated: false };
    try {
      for await (const record of connector.collectCasesByReference(issueKey, {
        signal: combinedSignal,
        maxRecords,
        budgetState
      })) {
        records.push(record);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new SourceSyncError("retrieval_cancelled", "Targeted TestRail retrieval was cancelled.");
      }
      if (!timeoutController.signal.aborted) {
        throw new SourceSyncError(
          "source_retrieval_failed",
          "Targeted TestRail retrieval failed."
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    if (records.length === 0) {
      return {
        productId,
        issueKey: issueKey.toUpperCase(),
        source: "testrail",
        status: timeoutController.signal.aborted || budgetState.truncated ? "partial" : "complete",
        recordsCollected: 0,
        recordsCommitted: 0,
        duplicateRecords: 0,
        truncated: timeoutController.signal.aborted || budgetState.truncated
      };

    }
    const committed = await store.commit({
      connectorId: ON_DEMAND_TESTRAIL_CONNECTOR_ID,
      records
    });
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    if (recordsToProject.length > 0) {
      try {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
    }
    return {
      productId,
      issueKey: issueKey.toUpperCase(),
      source: "testrail",
      status: timeoutController.signal.aborted || budgetState.truncated ? "partial" : "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated: timeoutController.signal.aborted || budgetState.truncated
    };
  };

  syncSource.retrieveTestRailCase = async function retrieveTestRailCase({
    productId,
    caseId,
    config,
    resolveCredential,
    signal,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    const normalizedCaseId = normalizePositiveInteger(caseId);
    if (!normalizedCaseId) {
      throw new SourceSyncError(
        "invalid_case_id",
        "A positive TestRail case ID is required for targeted retrieval."
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new SourceSyncError("invalid_timeout", "timeoutMs must be a positive integer.");
    }
    assertSyncSourceUrl(
      "testrail",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = productConfiguration({
      tenantId,
      productId,
      source: "testrail",
      connectorId: CONNECTOR_IDS.testrail,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.testrail]: {
          fetch: fetchImpl,
          resolveCredential: async () => {
            const credential = await resolveCredential();
            return Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64");
          }
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.testrail);
    if (!connector || typeof connector.collectCase !== "function") {
      throw new SourceSyncError(
        "retrieval_not_supported",
        "Exact TestRail case retrieval is not available."
      );
    }
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    try {
      for await (const record of connector.collectCase(normalizedCaseId, {
        signal: combinedSignal
      })) {
        records.push(record);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new SourceSyncError(
          "retrieval_cancelled",
          "Targeted TestRail retrieval was cancelled."
        );
      }
      if (timeoutController.signal.aborted) {
        throw new SourceSyncError(
          "retrieval_timeout",
          "Targeted TestRail retrieval exceeded its remote collection budget."
        );
      }
      if (error?.status === 404 || error?.statusCode === 404) {
        throw new SourceSyncError(
          "testrail_case_not_found",
          "TestRail could not find the requested case."
        );
      }
      throw new SourceSyncError(
        "source_retrieval_failed",
        "Targeted TestRail retrieval failed."
      );
    } finally {
      clearTimeout(timeout);
    }
    if (records.length !== 1) {
      throw new SourceSyncError(
        "testrail_case_not_found",
        "TestRail returned no evidence for the requested case."
      );
    }
    const committed = await store.commit({
      connectorId: ON_DEMAND_TESTRAIL_CONNECTOR_ID,
      records
    });
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    try {
      if (recordsToProject.length > 0) {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      }
    } catch (error) {
      scheduleProjectionIfPending(productId, store);
      throw error;
    }
    return {
      productId,
      caseId: normalizedCaseId,
      source: "testrail",
      status: "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated: false
    };
  };

  syncSource.retrieveTestRailCaseNeighborhood = async function retrieveTestRailCaseNeighborhood({
    productId,
    caseId,
    config,
    resolveCredential,
    signal,
    maxRecords = 100,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    const normalizedCaseId = normalizePositiveInteger(caseId);
    if (!normalizedCaseId) {
      throw new SourceSyncError(
        "invalid_case_id",
        "A positive TestRail case ID is required for targeted retrieval."
      );
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) {
      throw new SourceSyncError(
        "invalid_record_budget",
        "maxRecords must be an integer between 1 and 100."
      );
    }
    assertSyncSourceUrl(
      "testrail",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = productConfiguration({
      tenantId,
      productId,
      source: "testrail",
      connectorId: CONNECTOR_IDS.testrail,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.testrail]: {
          fetch: fetchImpl,
          resolveCredential: async () => {
            const credential = await resolveCredential();
            return Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64");
          }
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.testrail);
    if (!connector || typeof connector.collectCaseNeighborhood !== "function") {
      throw new SourceSyncError(
        "retrieval_not_supported",
        "Bounded TestRail neighborhood retrieval is not available."
      );
    }
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    const budgetState = { truncated: false };
    try {
      for await (const record of connector.collectCaseNeighborhood(normalizedCaseId, {
        signal: combinedSignal,
        maxRecords,
        budgetState
      })) {
        records.push(record);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new SourceSyncError(
          "retrieval_cancelled",
          "Targeted TestRail retrieval was cancelled."
        );
      }
      if (timeoutController.signal.aborted) {
        throw new SourceSyncError(
          "retrieval_timeout",
          "Targeted TestRail retrieval exceeded its remote collection budget."
        );
      }
      throw new SourceSyncError(
        "source_retrieval_failed",
        "Bounded TestRail neighborhood retrieval failed."
      );
    } finally {
      clearTimeout(timeout);
    }
    const committed = await store.commit({
      connectorId: ON_DEMAND_TESTRAIL_CONNECTOR_ID,
      records
    });
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    if (recordsToProject.length > 0) {
      try {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
    }
    return {
      productId,
      caseId: normalizedCaseId,
      source: "testrail",
      status: budgetState.truncated ? "partial" : "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated: budgetState.truncated,
      caseIds: [...new Set(records.map((record) => record.sourceId))]
    };
  };

  syncSource.retrieveTestRailSectionCases = async function retrieveTestRailSectionCases({
    productId,
    suiteId,
    sectionId,
    config,
    resolveCredential,
    signal,
    maxRecords = 100,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    const normalizedSuiteId = normalizePositiveInteger(suiteId);
    const normalizedSectionId = normalizePositiveInteger(sectionId);
    if (!normalizedSuiteId || !normalizedSectionId) {
      throw new SourceSyncError(
        "invalid_section_scope",
        "Positive TestRail suite and section IDs are required."
      );
    }
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) {
      throw new SourceSyncError(
        "invalid_record_budget",
        "maxRecords must be an integer between 1 and 100."
      );
    }
    assertSyncSourceUrl(
      "testrail",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = productConfiguration({
      tenantId,
      productId,
      source: "testrail",
      connectorId: CONNECTOR_IDS.testrail,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.testrail]: {
          fetch: fetchImpl,
          resolveCredential: async () => {
            const credential = await resolveCredential();
            return Buffer.from(`${config.username}:${credential}`, "utf8").toString("base64");
          }
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.testrail);
    if (!connector || typeof connector.collectCasesInSection !== "function") {
      throw new SourceSyncError(
        "retrieval_not_supported",
        "Bounded TestRail section retrieval is not available."
      );
    }
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    const budgetState = { truncated: false };
    try {
      for await (const record of connector.collectCasesInSection(
        normalizedSuiteId,
        normalizedSectionId,
        { signal: combinedSignal, maxRecords, budgetState },
      )) {
        records.push(record);
      }
    } catch {
      if (signal?.aborted) {
        throw new SourceSyncError(
          "retrieval_cancelled",
          "Targeted TestRail section retrieval was cancelled."
        );
      }
      if (timeoutController.signal.aborted) {
        throw new SourceSyncError(
          "retrieval_timeout",
          "Targeted TestRail section retrieval exceeded its remote collection budget."
        );
      }
      throw new SourceSyncError(
        "source_retrieval_failed",
        "Targeted TestRail section retrieval failed."
      );
    } finally {
      clearTimeout(timeout);
    }
    const committed = await store.commit({
      connectorId: ON_DEMAND_TESTRAIL_CONNECTOR_ID,
      records
    });
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    if (recordsToProject.length > 0) {
      try {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
    }
    return {
      productId,
      suiteId: normalizedSuiteId,
      sectionId: normalizedSectionId,
      source: "testrail",
      status: budgetState.truncated ? "partial" : "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated: budgetState.truncated,
      caseIds: records.map((record) => record.sourceId)
    };
  };

  syncSource.retrieveReportPortalTestHistory =
    async function retrieveReportPortalTestHistory({
      productId,
      identity,
      config,
      resolveCredential,
      signal,
      timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
    }) {
      const normalizedIdentity = typeof identity === "string" ? identity.trim() : "";
      if (normalizedIdentity.length === 0 || normalizedIdentity.length > 500) {
        throw new SourceSyncError(
          "invalid_test_identity",
          "A ReportPortal uniqueId or codeRef between 1 and 500 characters is required."
        );
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new SourceSyncError("invalid_timeout", "timeoutMs must be a positive integer.");
      }
      assertSyncSourceUrl(
        "reportportal",
        config,
        allowedHosts,
        allowedInsecureHosts,
        allowInsecureLoopback
      );
      const configuration = productConfiguration({
        tenantId,
        productId,
        source: "reportportal",
        connectorId: CONNECTOR_IDS.reportportal,
        config,
        allowedInsecureHosts,
        allowInsecureLoopback
      });
      const store = await getStore(productId);
      const composition = composeConnectorsImpl({
        configuration,
        dependencies: {
          [CONNECTOR_IDS.reportportal]: {
            fetch: fetchImpl,
            resolveCredential
          }
        }
      });
      const connector = composition.getPlugin(CONNECTOR_IDS.reportportal);
      if (!connector || typeof connector.collectTestItemsByIdentity !== "function") {
        throw new SourceSyncError(
          "retrieval_not_supported",
          "ReportPortal test identity retrieval is not available."
        );
      }
      const timeoutController = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
      const records = [];
      try {
        for await (const record of connector.collectTestItemsByIdentity(normalizedIdentity, {
          signal: combinedSignal
        })) {
          records.push(record);
        }
      } catch {
        if (signal?.aborted) {
          throw new SourceSyncError(
            "retrieval_cancelled",
            "Targeted ReportPortal retrieval was cancelled."
          );
        }
        if (timeoutController.signal.aborted) {
          throw new SourceSyncError(
            "retrieval_timeout",
            "Targeted ReportPortal retrieval exceeded its remote collection budget."
          );
        }
        throw new SourceSyncError(
          "source_retrieval_failed",
          "Targeted ReportPortal retrieval failed."
        );
      } finally {
        clearTimeout(timeout);
      }
      if (records.length === 0) {
        return {
          productId,
          identity: normalizedIdentity,
          source: "reportportal",
          status: "not-found",
          recordsCollected: 0,
          recordsCommitted: 0,
          duplicateRecords: 0,
          truncated: false
        };
      }
      const committed = await store.commit({
        connectorId: ON_DEMAND_REPORTPORTAL_CONNECTOR_ID,
        records
      });
      const committedKeys = new Set(committed.committedIdempotencyKeys);
      const recordsToProject = records.filter((record) =>
        committedKeys.has(record.idempotencyKey)
        || store.hasPendingProjection?.(record.idempotencyKey));
      try {
        if (recordsToProject.length > 0) {
          await runProjectionExclusive(productId, async () => {
            await knowledgeService.ingest(recordsToProject);
            await store.acknowledgeProjected(
              recordsToProject.map((record) => record.idempotencyKey)
            );
          });
        }
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
      return {
        productId,
        identity: normalizedIdentity,
        source: "reportportal",
        status: "complete",
        recordsCollected: records.length,
        recordsCommitted: committed.committedCount,
        duplicateRecords: committed.duplicateCount,
        truncated: false
      };
    };

  syncSource.retrieveConfluencePagesByText = async function retrieveConfluencePagesByText({
    productId,
    query,
    config,
    resolveCredential,
    signal,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (normalizedQuery.length < 3 || normalizedQuery.length > 200) {
      throw new SourceSyncError(
        "invalid_search_query",
        "A contextual query between 3 and 200 characters is required."
      );
    }
    assertSyncSourceUrl(
      "confluence",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const configuration = productConfiguration({
      tenantId,
      productId,
      source: "confluence",
      connectorId: CONNECTOR_IDS.confluence,
      config,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    const store = await getStore(productId);
    const composition = composeConnectorsImpl({
      configuration,
      dependencies: {
        [CONNECTOR_IDS.confluence]: {
          fetch: fetchImpl,
          resolveCredential
        }
      }
    });
    const connector = composition.getPlugin(CONNECTOR_IDS.confluence);
    if (!connector || typeof connector.collectPagesByText !== "function") {
      throw new SourceSyncError(
        "retrieval_not_supported",
        "Contextual Confluence retrieval is not available."
      );
    }
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    try {
      for await (const record of connector.collectPagesByText(normalizedQuery, {
        signal: combinedSignal
      })) {
        records.push(record);
      }
    } catch {
      if (signal?.aborted) {
        throw new SourceSyncError(
          "retrieval_cancelled",
          "Contextual Confluence retrieval was cancelled."
        );
      }
      if (timeoutController.signal.aborted) {
        throw new SourceSyncError(
          "retrieval_timeout",
          "Contextual Confluence retrieval exceeded its remote collection budget."
        );
      }
      throw new SourceSyncError(
        "source_retrieval_failed",
        "Contextual Confluence retrieval failed."
      );
    } finally {
      clearTimeout(timeout);
    }
    const committed = records.length > 0
      ? await store.commit({ connectorId: ON_DEMAND_CONFLUENCE_CONNECTOR_ID, records })
      : { committedCount: 0, duplicateCount: 0, committedIdempotencyKeys: [] };
    const committedKeys = new Set(committed.committedIdempotencyKeys);
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    if (recordsToProject.length > 0) {
      try {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
    }
    return {
      productId,
      query: normalizedQuery,
      source: "confluence",
      status: "complete",
      recordsCollected: records.length,
      recordsCommitted: committed.committedCount,
      duplicateRecords: committed.duplicateCount,
      truncated: false
    };
  };

  syncSource.retrieveGitHubPullRequests = async function retrieveGitHubPullRequests({
    productId,
    issueKey,
    config,
    resolveCredential,
    signal,
    maxPullRequests = 10,
    maxChangedFiles = 50,
    timeoutMs = DEFAULT_ON_DEMAND_TIMEOUT_MS
  }) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey ?? "")) {
      throw new SourceSyncError(
        "invalid_issue_key",
        "A valid Jira issue key is required for GitHub enrichment."
      );
    }
    if (!Number.isSafeInteger(maxPullRequests) || maxPullRequests < 1) {
      throw new SourceSyncError(
        "invalid_pull_request_budget",
        "maxPullRequests must be a positive integer."
      );
    }
    if (!Number.isSafeInteger(maxChangedFiles) || maxChangedFiles < 0) {
      throw new SourceSyncError(
        "invalid_changed_file_budget",
        "maxChangedFiles must be a non-negative integer."
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new SourceSyncError("invalid_timeout", "timeoutMs must be a positive integer.");
    }
    assertSyncSourceUrl(
      "github",
      config,
      allowedHosts,
      allowedInsecureHosts,
      allowInsecureLoopback
    );
    const repositories = normalizedGitHubRepositories(config.repositories);
    const store = await getStore(productId);
    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const records = [];
    const repositoryOutcomes = [];
    let pullRequestsCollected = 0;
    let changedFilesCollected = 0;
    let committedCount = 0;
    let duplicateCount = 0;
    let truncated = false;
    const committedKeys = new Set();
    try {
      for (const repository of repositories) {
        if (combinedSignal.aborted) {
          truncated = true;
          break;
        }
        const remainingPullRequests = maxPullRequests - pullRequestsCollected;
        const remainingChangedFiles = maxChangedFiles - changedFilesCollected;
        if (remainingPullRequests < 1) {
          truncated = true;
          repositoryOutcomes.push({
            repository,
            status: "skipped",
            recordsCollected: 0,
            error: null
          });
          continue;
        }
        const repositoryConfig = { ...config, repositories: [repository] };
        const configuration = productConfiguration({
          tenantId,
          productId,
          source: "github",
          connectorId: CONNECTOR_IDS.github,
          config: repositoryConfig,
          allowedInsecureHosts,
          allowInsecureLoopback
        });
        const composition = composeConnectorsImpl({
          configuration,
          dependencies: {
            [CONNECTOR_IDS.github]: {
              fetch: fetchImpl,
              resolveCredential
            }
          }
        });
        const connector = composition.getPlugin(CONNECTOR_IDS.github);
        if (!connector || typeof connector.collectPullRequestsByIssue !== "function") {
          throw new SourceSyncError(
            "retrieval_not_supported",
            "Targeted GitHub retrieval is not available."
          );
        }
        const repositoryRecords = [];
        const budgetState = { truncated: false };
        let collectionCompleted = false;
        try {
          for await (const record of connector.collectPullRequestsByIssue(issueKey, {
            signal: combinedSignal,
            maxPullRequests: remainingPullRequests,
            maxChangedFiles: remainingChangedFiles,
            budgetState
          })) {
            repositoryRecords.push(record);
          }
          collectionCompleted = true;
          const repositoryPullRequests = repositoryRecords.filter(
            (record) => record.contentType === "github.pull_request"
          ).length;
          const repositoryChangedFiles = repositoryRecords.filter(
            (record) => record.contentType === "github.changed_file"
          ).length;
          pullRequestsCollected += repositoryPullRequests;
          changedFilesCollected += repositoryChangedFiles;
          records.push(...repositoryRecords);
          truncated ||= budgetState.truncated;
          const committed = await store.commit({
            connectorId: githubOnDemandConnectorId(repository),
            records: repositoryRecords
          });
          committedCount += committed.committedCount;
          duplicateCount += committed.duplicateCount;
          for (const key of committed.committedIdempotencyKeys) committedKeys.add(key);
          repositoryOutcomes.push({
            repository,
            status: budgetState.truncated ? "partial" : "complete",
            recordsCollected: repositoryRecords.length,
            error: null
          });
        } catch (error) {
          if (signal?.aborted) {
            throw new SourceSyncError(
              "retrieval_cancelled",
              "Targeted GitHub retrieval was cancelled."
            );
          }
          if (timeoutController.signal.aborted) {
            if (!collectionCompleted && repositoryRecords.length > 0) {
              const repositoryPullRequests = repositoryRecords.filter(
                (record) => record.contentType === "github.pull_request"
              ).length;
              const repositoryChangedFiles = repositoryRecords.filter(
                (record) => record.contentType === "github.changed_file"
              ).length;
              pullRequestsCollected += repositoryPullRequests;
              changedFilesCollected += repositoryChangedFiles;
              records.push(...repositoryRecords);
              const committed = await store.commit({
                connectorId: githubOnDemandConnectorId(repository),
                records: repositoryRecords
              });
              committedCount += committed.committedCount;
              duplicateCount += committed.duplicateCount;
              for (const key of committed.committedIdempotencyKeys) committedKeys.add(key);
            }
            truncated = true;
            repositoryOutcomes.push({
              repository,
              status: "partial",
              recordsCollected: repositoryRecords.length,
              error: {
                code: "source_retrieval_timed_out",
                category: "network",
                message: "Targeted GitHub retrieval timed out for this repository."
              }
            });
            break;
          }
          if (!collectionCompleted && repositoryRecords.length > 0) {
            const repositoryPullRequests = repositoryRecords.filter(
              (record) => record.contentType === "github.pull_request"
            ).length;
            const repositoryChangedFiles = repositoryRecords.filter(
              (record) => record.contentType === "github.changed_file"
            ).length;
            pullRequestsCollected += repositoryPullRequests;
            changedFilesCollected += repositoryChangedFiles;
            records.push(...repositoryRecords);
            const committed = await store.commit({
              connectorId: githubOnDemandConnectorId(repository),
              records: repositoryRecords
            });
            committedCount += committed.committedCount;
            duplicateCount += committed.duplicateCount;
            for (const key of committed.committedIdempotencyKeys) committedKeys.add(key);
          }
          repositoryOutcomes.push({
            repository,
            status: repositoryRecords.length > 0 ? "partial" : "unavailable",
            recordsCollected: repositoryRecords.length,
            error: {
              code: "source_retrieval_failed",
              category: "provider",
              message: "Targeted GitHub retrieval failed for this repository."
            }
          });
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const recordsToProject = records.filter((record) =>
      committedKeys.has(record.idempotencyKey)
      || store.hasPendingProjection?.(record.idempotencyKey));
    if (recordsToProject.length > 0) {
      try {
        await runProjectionExclusive(productId, async () => {
          await knowledgeService.ingest(recordsToProject);
          await store.acknowledgeProjected(
            recordsToProject.map((record) => record.idempotencyKey)
          );
        });
      } catch (error) {
        scheduleProjectionIfPending(productId, store);
        throw error;
      }
    }
    return {
      productId,
      issueKey: issueKey.toUpperCase(),
      source: "github",
      status:
        timeoutController.signal.aborted
        || truncated
        || repositoryOutcomes.some((outcome) => outcome.status === "unavailable")
          ? "partial"
          : "complete",
      recordsCollected: records.length,
      recordsCommitted: committedCount,
      duplicateRecords: duplicateCount,
      truncated: timeoutController.signal.aborted || truncated,
      repositories: repositoryOutcomes
    };
  };

  /** Explicitly resumes the durable raw-to-Silver backlog without contacting a source. */
  syncSource.resumePendingProjections = async function resumePendingProjections({ productId }) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new SourceSyncError(
        "invalid_projection_request",
        "A productId is required to resume pending projections."
      );
    }
    const store = await getStore(productId);
    if (store.countPendingProjectionRecords() === 0) {
      return syncSource.projectionStatus({ productId });
    }
    await startProjector(productId, store);
    return syncSource.projectionStatus({ productId });
  };

  /** Resumes every product scope already persisted under this tenant. */
  syncSource.resumeAllPendingProjections = async function resumeAllPendingProjections() {
    const tenantDirectory = join(dataDirectory, tenantId);
    let entries;
    try {
      entries = await readdir(tenantDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          syncSource.resumePendingProjections({ productId: entry.name }))
    );
  };

  /** Returns sanitized in-process worker and durable backlog status. */
  syncSource.projectionStatus = async function projectionStatus({ productId }) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new SourceSyncError(
        "invalid_projection_request",
        "A productId is required to inspect projection status."
      );
    }
    const store = await getStore(productId);
    const state = getProjectorState(productId);
    return {
      productId,
      running: state.running,
      triggerPending: state.requested,
      pendingRecords: store.countPendingProjectionRecords(),
      passes: state.passes,
      projectedRecords: state.projectedRecords,
      lastErrorCode: state.lastErrorCode
    };
  };

  syncSource.waitForProjection = async function waitForProjection({ productId }) {
    if (typeof productId !== "string" || productId.length === 0) {
      throw new SourceSyncError(
        "invalid_projection_request",
        "A productId is required to wait for projection."
      );
    }
    const state = getProjectorState(productId);
    while (state.promise) {
      await state.promise;
    }
    const tail = projectionTails.get(productId);
    if (tail) await tail;
    return syncSource.projectionStatus({ productId });
  };

  return syncSource;
}

export async function drainPendingProjections({
  store,
  projectRecords,
  batchSize = resolveDefaultProjectionBatchSize(),
  yieldToEventLoop: yieldFn = yieldToEventLoop,
  poisonYieldInterval = DEFAULT_POISON_YIELD_INTERVAL,
  onSlowBatch,
  slowBatchThresholdMs = DEFAULT_SLOW_BATCH_THRESHOLD_MS
}) {
  if (
    !store
    || typeof store.listPendingProjectionRecords !== "function"
    || typeof store.countPendingProjectionRecords !== "function"
    || typeof store.acknowledgeProjected !== "function"
    || typeof store.recordProjectionFailures !== "function"
  ) {
    throw new TypeError("store with durable projection failure handling is required");
  }
  if (typeof projectRecords !== "function") {
    throw new TypeError("projectRecords must be a function");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError("batchSize must be a positive integer");
  }
  if (typeof yieldFn !== "function") {
    throw new TypeError("yieldToEventLoop must be a function");
  }
  if (!Number.isSafeInteger(poisonYieldInterval) || poisonYieldInterval < 1) {
    throw new TypeError("poisonYieldInterval must be a positive integer");
  }
  const reportSlowBatch = (phase, count, durationMs) => {
    if (typeof onSlowBatch === "function" && durationMs >= slowBatchThresholdMs) {
      // Bounded, sanitized signal only: phase + scalar counts/durations. No
      // record payloads or per-record source identifiers are included.
      onSlowBatch({ phase, batchSize: count, durationMs: Math.round(durationMs) });
    }
  };
  let projectedCount = 0;
  let recordsRemainingThisPass = store.countPendingProjectionRecords();
  while (recordsRemainingThisPass > 0) {
    const records = store.listPendingProjectionRecords(
      Math.min(batchSize, recordsRemainingThisPass)
    );
    if (records.length === 0) break;
    let result;
    const startedAt = nowMs();
    try {
      result = await projectRecords(records);
    } catch {
      reportSlowBatch("silver-projection-batch", records.length, nowMs() - startedAt);
      // Record-by-record poison isolation. Yield at a bounded interval so a
      // large poisoned batch cannot starve the event loop while each record is
      // reprojected synchronously.
      const failedKeys = [];
      let processedSinceYield = 0;
      for (const record of records) {
        const key = rawEvidenceIdempotencyKey(record);
        let singleResult;
        try {
          singleResult = await projectRecords([record]);
        } catch {
          failedKeys.push(key);
          if ((processedSinceYield += 1) >= poisonYieldInterval) {
            processedSinceYield = 0;
            await yieldFn();
          }
          continue;
        }
        await store.acknowledgeProjected([key]);
        projectedCount += Number.isSafeInteger(singleResult?.ingestedRecords)
          ? singleResult.ingestedRecords
          : 1;
        if ((processedSinceYield += 1) >= poisonYieldInterval) {
          processedSinceYield = 0;
          await yieldFn();
        }
      }
      if (failedKeys.length > 0) {
        await store.recordProjectionFailures(failedKeys);
      }
      recordsRemainingThisPass -= records.length;
      // Yield before starting the next durable pass.
      await yieldFn();
      continue;
    }
    reportSlowBatch("silver-projection-batch", records.length, nowMs() - startedAt);
    await store.acknowledgeProjected(records.map(rawEvidenceIdempotencyKey));
    projectedCount += Number.isSafeInteger(result?.ingestedRecords)
      ? result.ingestedRecords
      : records.length;
    recordsRemainingThisPass -= records.length;
    // Return control to the macrotask/I-O queue after each acknowledged batch
    // so concurrent HTTP work runs between batches.
    await yieldFn();
  }
  return projectedCount;
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Builds a best-effort slow-batch observer that records a sanitized audit
 * event. Only the phase name, coarse scope (tenant product + source *type*),
 * and bounded scalar timings travel to the sink -- never record payloads or
 * per-record source identifiers -- so future stalls can be attributed to a
 * phase without leaking sensitive data.
 */
function createSlowBatchObserver({ auditLogger, productId, source }) {
  if (!auditLogger || typeof auditLogger.record !== "function") return undefined;
  return ({ phase, batchSize, durationMs }) => {
    Promise.resolve()
      .then(() =>
        auditLogger.record({
          eventType: "sync.projection.slow_batch",
          phase,
          productId,
          source,
          batchSize,
          durationMs
        })
      )
      .catch(() => {
        // Observability is best-effort and must never fail a durable sync.
      });
  };
}

function assertSyncSourceUrl(
  source,
  config,
  allowedHosts,
  allowedInsecureHosts,
  allowInsecureLoopback
) {
  const rawUrl = source === "github" ? config.apiUrl ?? "https://api.github.com" : config.baseUrl;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceSyncError("invalid_source_url", "The source URL is invalid.");
  }
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const host = url.hostname.toLowerCase();
  const githubDefault = source === "github" && host === "api.github.com";
  const loopbackAllowed = allowInsecureLoopback && isLoopback(host);
  const insecureHostAllowed =
    source === "reportportal"
    && url.protocol === "http:"
    && allowedInsecureHosts.some((allowedHost) => allowedHost.toLowerCase() === host);
  if (
    (url.protocol !== "https:" && !loopbackAllowed && !insecureHostAllowed)
    || (!hosts.has(host) && !githubDefault && !loopbackAllowed)
  ) {
    throw new SourceSyncError(
      "source_host_not_allowed",
      "The source host is not approved for this deployment."
    );
  }
  if (source === "github" && config.webBaseUrl) {
    assertApprovedUrl(config.webBaseUrl, allowedHosts, allowInsecureLoopback, "github.com");
  }
}

function assertApprovedUrl(rawUrl, allowedHosts, allowInsecureLoopback, defaultHost) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceSyncError("invalid_source_url", "The source URL is invalid.");
  }
  const host = url.hostname.toLowerCase();
  const loopbackAllowed = allowInsecureLoopback && isLoopback(host);
  if (
    (url.protocol !== "https:" && !(loopbackAllowed && url.protocol === "http:"))
    || (
      !allowedHosts.some((allowedHost) => allowedHost.toLowerCase() === host)
      && host !== defaultHost
      && !loopbackAllowed
    )
  ) {
    throw new SourceSyncError(
      "source_host_not_allowed",
      "The source host is not approved for this deployment."
    );
  }
}

function productConfiguration({
  tenantId,
  productId,
  source,
  connectorId,
  config,
  allowedInsecureHosts,
  allowInsecureLoopback
}) {
  return {
    configVersion: "0.1",
    tenantId,
    productId,
    enabledPlugins: [connectorId],
    plannedPlugins: [],
    credentialRefs: {
      [connectorId]: `secret://source-connections/${productId}/${source}`
    },
    sources: {
      [source]: connectorConfiguration(
        source,
        config,
        allowedInsecureHosts,
        allowInsecureLoopback
      )
    }
  };
}

function connectorConfiguration(
  source,
  config,
  allowedInsecureHosts,
  allowInsecureLoopback
) {
  const base = {
    enabled: true,
    configurationStatus: "ready",
    allowInsecureLoopback
  };
  if (source === "github") {
    const repositories = normalizedGitHubRepositories(config.repositories);
    if (repositories.length !== 1) {
      throw new SourceSyncError(
        "invalid_source_configuration",
        "A repository-scoped GitHub sync requires exactly one repository target."
      );
    }
    return {
      ...base,
      repository: repositories[0],
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
      ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {})
    };
  }

  if (source === "jira") {
    return {
      ...base,
      baseUrl: config.baseUrl,
      allowedProjects: config.allowedProjects,
      allowedJql: [config.allowedJql],
      jql: config.allowedJql
    };
  }
  if (source === "confluence") {
    return {
      ...base,
      baseUrl: config.baseUrl,
      username: config.username,
      authMode: config.authMode ?? "basic",
      spaceKeys: config.spaceKeys,
      contentScope: config.contentScope ?? "space",
      ...(config.rootPageRefs ? { rootPageRefs: config.rootPageRefs } : {})
    };
  }
  if (source === "reportportal") {
    const sourceUrl = new URL(config.baseUrl);
    const insecureHostAllowed =
      sourceUrl.protocol === "http:"
      && allowedInsecureHosts.some(
        (allowedHost) => allowedHost.toLowerCase() === sourceUrl.hostname.toLowerCase()
      );
    return {
      ...base,
      baseUrl: config.baseUrl,
      project: config.project,
      allowInsecureHost: insecureHostAllowed
    };
  }
  return {
    ...base,
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    suiteScope: config.suiteScope ?? (config.suiteIds ? "selected" : "all"),
    ...(config.suiteIds ? { suiteIds: config.suiteIds } : {})
  };
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
