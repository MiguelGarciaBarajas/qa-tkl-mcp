import { randomUUID } from "node:crypto";
import { assertProductConfiguration, stableJson } from "@tkl/contracts";
import { composeConnectors as composeConfiguredConnectors } from "@tkl/ingestion";
import {
  CheckpointValidationError,
  ReplayConfirmationRequiredError,
  SyncConfigurationError,
  SyncRunConflictError,
  describeError,
} from "./errors.js";
import { acquireRunLock, isRunInProgress } from "./locks.js";
import { planRetention } from "./retention.js";
import { reconcileEvidence, applyReconciliationRepairs } from "./reconcile.js";
import {
  planSilverRebuild,
  rebuildSilverFromRawEvidence,
  rebuildGoldProjections,
} from "./rebuild.js";
import { sanitizeOperationsData } from "./sanitize.js";
import { describeSchedule, resolveSyncSettings } from "./schedule.js";

/**
 * OPS-101: the scheduled-sync orchestration boundary.
 *
 * This module owns *when and how* an already-built connector runs and *how
 * its output reaches durable storage*. It owns no source knowledge at all:
 * it never builds an HTTP client, never knows a Jira/GitHub/TestRail
 * pagination rule, never creates a raw evidence record, and never decides
 * an allowlist. Connectors are composed by `@tkl/ingestion`
 * (`composeConnectors`, ING-104) from validated product configuration, and
 * evidence plus checkpoints are committed through the `RawEvidenceStore`
 * contract from `@tkl/raw-evidence-store` (ING-105). Adding or disabling a
 * connector is a configuration change; nothing here changes.
 *
 * Guarantees, stated precisely:
 *
 * - **Resume.** Each connector's start position is the checkpoint that was
 *   durably committed by its last successful batch, read back from the
 *   store, not from process memory. A fresh process with a fresh store
 *   instance therefore resumes exactly where the previous one stopped.
 * - **Atomic progress.** Records and the next checkpoint are handed to the
 *   store in a single `commit()` -- the store's own transaction -- so a
 *   checkpoint can never advance past evidence that was not persisted.
 * - **Never skip on failure.** When collection fails mid-stream, evidence
 *   already fetched is still committed, but *without* advancing the
 *   checkpoint. The next run therefore re-reads from the last fully
 *   committed position; duplicates are deduplicated by the store's
 *   idempotency keys. The alternative (advancing a cursor past a failed
 *   region) could permanently skip evidence.
 * - **Never rewind silently.** No mode in this module ever clears a stored
 *   checkpoint (`commit({ checkpoint: null })` is never issued) and replay
 *   modes default to leaving the stored checkpoint untouched.
 * - **No embedded scheduler.** One `runOnce()` per external trigger; see
 *   `./schedule.js`.
 * - **No overlap in a process.** See `./locks.js` for the in-process
 *   guarantee and the cross-process limitation.
 */

export const SYNC_MODES = Object.freeze(["incremental", "replay-from-checkpoint", "replay-full"]);
export const CHECKPOINT_POLICIES = Object.freeze(["advance", "preserve"]);

const REPLAY_MODES = new Set(["replay-from-checkpoint", "replay-full"]);
const DEFAULT_CHECKPOINT_POLICY = Object.freeze({
  incremental: "advance",
  "replay-from-checkpoint": "preserve",
  "replay-full": "preserve",
});

const MAX_CHECKPOINT_DEPTH = 10;
const MAX_CHECKPOINT_KEYS = 100;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveInteger(value, field, max) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new SyncConfigurationError(`${field} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

/**
 * A checkpoint is persisted (structured-cloned, encrypted, reloaded) and
 * later fed back into a connector, so only plain JSON data is accepted.
 * Anything else fails the batch closed rather than being coerced, dropped,
 * or persisted in a shape that a later run cannot use.
 */
function assertJsonCheckpoint(connectorId, checkpoint, depth = 0, keyCount = { total: 0 }) {
  if (depth === 0 && !isPlainObject(checkpoint)) {
    throw new CheckpointValidationError(connectorId, "it must be a plain object");
  }
  for (const [key, value] of Object.entries(checkpoint)) {
    keyCount.total += 1;
    if (keyCount.total > MAX_CHECKPOINT_KEYS) {
      throw new CheckpointValidationError(connectorId, `it exceeds ${MAX_CHECKPOINT_KEYS} keys`);
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new CheckpointValidationError(connectorId, "it contains an empty key");
    }
    assertJsonCheckpointValue(connectorId, value, depth, keyCount);
  }
  return checkpoint;
}

function assertJsonCheckpointValue(connectorId, value, depth, keyCount) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CheckpointValidationError(connectorId, "it contains a non-finite number");
    }
    return;
  }
  if (depth + 1 > MAX_CHECKPOINT_DEPTH) {
    throw new CheckpointValidationError(connectorId, `it nests deeper than ${MAX_CHECKPOINT_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonCheckpointValue(connectorId, entry, depth + 1, keyCount);
    return;
  }
  if (isPlainObject(value)) {
    assertJsonCheckpoint(connectorId, value, depth + 1, keyCount);
    return;
  }
  throw new CheckpointValidationError(
    connectorId,
    "it contains a value that is not JSON-serializable data",
  );
}

/**
 * Identity of a checkpoint for "did the cursor actually move?" comparisons.
 * `observedAt` is excluded because it is the time the cursor was recorded,
 * not part of the cursor itself -- otherwise every run would look like
 * progress and commit an empty batch on each tick.
 */
function checkpointIdentity(checkpoint) {
  if (checkpoint === undefined || checkpoint === null) return null;
  const { observedAt: _ignored, ...identity } = checkpoint;
  return stableJson(identity);
}

/**
 * Default way to learn a connector's current cursor. The three production
 * connectors (ING-101..103) already maintain `metrics.lastCheckpoint` while
 * they stream, and also expose it through `health()`. A connector that
 * offers an explicit `currentCheckpoint()` is preferred when present. A
 * connector that offers neither simply never advances a checkpoint, and the
 * run summary reports that honestly instead of inventing a cursor.
 */
function defaultReadCheckpoint(instance) {
  if (typeof instance?.currentCheckpoint === "function") {
    return instance.currentCheckpoint();
  }
  return instance?.metrics?.lastCheckpoint;
}

/** Cooperative event-loop yield: resolves on the next macrotask tick. */
function defaultYieldAfterCommit() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function resolveConnectorInstances({ configuration, connectors, composition, dependencies, registry }) {
  if (connectors !== undefined) {
    const entries = Array.isArray(connectors) ? connectors : [...(connectors?.entries?.() ?? [])];
    const normalized = entries.map((entry) =>
      Array.isArray(entry) ? { pluginId: entry[0], instance: entry[1] } : entry,
    );
    return new Map(normalized.map(({ pluginId, instance }) => [pluginId, instance]));
  }
  const composed =
    composition ?? composeConfiguredConnectors({ configuration, dependencies, ...(registry ? { registry } : {}) });
  return new Map(composed.listPlugins().map(({ pluginId, instance }) => [pluginId, instance]));
}

/**
 * Builds the coordinator for exactly one tenant/product scope.
 *
 * @param {object} options
 * @param {object} options.configuration Validated ARCH-103 product configuration.
 * @param {object} options.store A `RawEvidenceStore` (ING-105) already scoped to the same tenant/product.
 * @param {object} [options.sync] Operational settings (see `./schedule.js`), typically `config/operations/sync.json`.
 * @param {object} [options.syncOverrides] Call-site overrides applied over `sync`.
 * @param {Array|Map} [options.connectors] Pre-built connectors; defaults to composing them from configuration.
 * @param {object} [options.composition] An existing `composeConnectors` result to reuse.
 * @param {object} [options.dependencies] Per-plugin composition dependencies (clients, credential resolvers).
 * @param {Function} [options.now] Injected clock returning an ISO timestamp.
 * @param {Function} [options.monotonicNow] Injected monotonic millisecond clock for duration caps.
 * @param {Function} [options.newRunId] Injected run-ID generator.
 * @param {object} [options.auditLogger] `@tkl/observability` audit logger; receives sanitized events.
 * @param {object} [options.healthRegistry] `@tkl/observability` health registry; receives connector health.
 * @param {object} [options.externalLock] Optional cross-process mutual-exclusion seam.
 * @param {object} [options.connectorStorageIds] Optional plugin-ID to checkpoint/evidence namespace map.
 * @param {Function} [options.readCheckpoint] Override for how a connector's cursor is read.
 */
export function createSyncCoordinator({
  configuration,
  store,
  sync = {},
  syncOverrides = {},
  connectors,
  composition,
  dependencies = {},
  registry,
  now = () => new Date().toISOString(),
  monotonicNow = () => performance.now(),
  newRunId = () => randomUUID(),
  auditLogger,
  healthRegistry,
  externalLock,
  connectorStorageIds = {},
  readCheckpoint = defaultReadCheckpoint,
  yieldAfterCommit = defaultYieldAfterCommit,
} = {}) {
  const product = assertProductConfiguration(configuration);
  if (!store || typeof store.commit !== "function" || typeof store.getCheckpoint !== "function") {
    throw new SyncConfigurationError(
      "A raw evidence store with commit/getCheckpoint is required (see @tkl/raw-evidence-store)",
    );
  }
  if (store.tenantId !== product.tenantId || store.productId !== product.productId) {
    throw new SyncConfigurationError(
      "The raw evidence store scope does not match the product configuration tenant/product",
    );
  }
  if (typeof readCheckpoint !== "function") {
    throw new SyncConfigurationError("readCheckpoint must be a function");
  }
  if (typeof yieldAfterCommit !== "function") {
    throw new SyncConfigurationError("yieldAfterCommit must be a function");
  }
  if (typeof monotonicNow !== "function") {
    throw new SyncConfigurationError("monotonicNow must be a function");
  }
  if (externalLock !== undefined && typeof externalLock?.acquire !== "function") {
    throw new SyncConfigurationError("externalLock must expose an async acquire(scope) function");
  }
  if (!isPlainObject(connectorStorageIds)) {
    throw new SyncConfigurationError("connectorStorageIds must be an object");
  }

  const settings = resolveSyncSettings(sync, syncOverrides);
  const instances = resolveConnectorInstances({
    configuration: product,
    connectors,
    composition,
    dependencies,
    registry,
  });
  const enabledConnectorIds = product.enabledPlugins.filter((pluginId) =>
    pluginId.startsWith("connector."),
  );
  for (const connectorId of enabledConnectorIds) {
    const instance = instances.get(connectorId);
    if (!instance || typeof instance.collect !== "function") {
      throw new SyncConfigurationError(
        `Enabled connector "${connectorId}" has no composed instance exposing collect()`,
      );
    }
  }

  const scope = { tenantId: product.tenantId, productId: product.productId };
  let lastSummary = null;

  function storageConnectorId(connectorId) {
    const storageId = connectorStorageIds[connectorId] ?? connectorId;
    if (
      typeof storageId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(storageId)
    ) {
      throw new SyncConfigurationError(
        `Storage connector ID for "${connectorId}" is invalid`
      );
    }
    return storageId;
  }

  async function emitAudit(event) {
    if (!auditLogger || typeof auditLogger.record !== "function") return;
    try {
      await auditLogger.record(sanitizeOperationsData(event, "auditEvent"));
    } catch {
      // A broken audit sink must never turn a durable, committed sync into a
      // reported failure. The sanitized summary is still returned to the caller.
    }
  }

  function recordHealth(connectorId, health) {
    if (!healthRegistry || typeof healthRegistry.record !== "function") return;
    try {
      healthRegistry.record(connectorId, health);
    } catch {
      // Same rationale as emitAudit: observability is best-effort.
    }
  }

  function resolveRunOptions(options = {}) {
    if (!isPlainObject(options)) throw new SyncConfigurationError("Run options must be an object");
    const mode = options.mode ?? "incremental";
    if (!SYNC_MODES.includes(mode)) {
      throw new SyncConfigurationError(`mode must be one of: ${SYNC_MODES.join(", ")}`);
    }
    const dryRun = options.dryRun === true;
    if (REPLAY_MODES.has(mode) && options.confirmReplay !== true && !dryRun) {
      throw new ReplayConfirmationRequiredError(mode);
    }
    const checkpointPolicy = options.checkpointPolicy ?? DEFAULT_CHECKPOINT_POLICY[mode];
    if (!CHECKPOINT_POLICIES.includes(checkpointPolicy)) {
      throw new SyncConfigurationError(
        `checkpointPolicy must be one of: ${CHECKPOINT_POLICIES.join(", ")}`,
      );
    }

    let startCheckpoint;
    if (options.startCheckpoint !== undefined) {
      if (mode !== "replay-from-checkpoint") {
        throw new SyncConfigurationError(
          'startCheckpoint is only accepted for mode "replay-from-checkpoint"; an incremental run ' +
            "always resumes from the durably committed checkpoint",
        );
      }
      if (!isPlainObject(options.startCheckpoint)) {
        throw new SyncConfigurationError("startCheckpoint must be a plain object");
      }
      startCheckpoint = assertJsonCheckpoint("<startCheckpoint>", options.startCheckpoint);
    }

    const requested = options.connectorIds;
    let connectorIds = enabledConnectorIds;
    if (requested !== undefined) {
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new SyncConfigurationError("connectorIds must be a non-empty array when provided");
      }
      for (const connectorId of requested) {
        if (!enabledConnectorIds.includes(connectorId)) {
          throw new SyncConfigurationError(
            `Connector "${connectorId}" is not an enabled connector for this product configuration`,
          );
        }
      }
      connectorIds = [...new Set(requested)];
    }

    const batchSize =
      options.batchSize === undefined
        ? settings.batchSize
        : assertPositiveInteger(options.batchSize, "batchSize", 10_000);
    const maxRecordsPerConnector =
      options.maxRecordsPerConnector === undefined
        ? settings.maxRecordsPerConnector
        : assertPositiveInteger(options.maxRecordsPerConnector, "maxRecordsPerConnector", 10_000_000);
    const maxDurationMs =
      options.maxDurationMs === undefined
        ? settings.maxDurationMs
        : assertPositiveInteger(options.maxDurationMs, "maxDurationMs", 86_400_000);
    const overlapPolicy = options.overlapPolicy ?? settings.overlapPolicy;
    if (overlapPolicy !== "skip" && overlapPolicy !== "fail") {
      throw new SyncConfigurationError('overlapPolicy must be "skip" or "fail"');
    }
    if (!dryRun && REPLAY_MODES.has(mode)) {
      if (connectorIds.length !== 1) {
        throw new SyncConfigurationError("Replay modes require exactly one connector");
      }
      if (maxRecordsPerConnector === null || maxRecordsPerConnector === undefined) {
        throw new SyncConfigurationError(
          "Replay modes require a finite maxRecordsPerConnector safety cap",
        );
      }
    }
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
      throw new SyncConfigurationError("signal must be an AbortSignal");
    }

    return {
      mode,
      dryRun,
      checkpointPolicy,
      startCheckpoint,
      connectorIds,
      batchSize,
      maxRecordsPerConnector,
      maxDurationMs,
      overlapPolicy,
      signal: options.signal,
      confirmedReplay: REPLAY_MODES.has(mode) && options.confirmReplay === true,
    };
  }

  function resolveStartCheckpoint(connectorId, runOptions) {
    const stored = store.getCheckpoint(storageConnectorId(connectorId));
    if (runOptions.mode === "replay-full") {
      // A full replay deliberately starts at the source's beginning
      // (page zero) without touching the stored cursor; the store's
      // idempotency keys make the re-read a no-op for evidence that is
      // already present.
      return { start: {}, stored, resumed: false };
    }
    if (runOptions.startCheckpoint !== undefined) {
      return { start: runOptions.startCheckpoint, stored, resumed: true };
    }
    return { start: stored ?? {}, stored, resumed: stored !== undefined };
  }

  async function acquireLocks(connectorId, runId, startedAt) {
    const lockScope = { ...scope, connectorId: storageConnectorId(connectorId) };
    const local = acquireRunLock(lockScope, { runId, startedAt });
    if (!local) return { acquired: false, reason: "run-already-in-progress", release: async () => [] };
    if (!externalLock) {
      return {
        acquired: true,
        release: async () => {
          local.release();
          return [];
        },
      };
    }
    let external;
    try {
      external = await externalLock.acquire({ ...lockScope, runId });
    } catch (error) {
      local.release();
      throw error;
    }
    if (!external) {
      local.release();
      return { acquired: false, reason: "external-lock-unavailable", release: async () => [] };
    }
    return {
      acquired: true,
      /**
       * Releasing is best-effort and never throws: this runs in a `finally`
       * after the run's outcome is already decided, so a rejected lease
       * release (a realistic network failure for an external lock) must not
       * discard a completed run's summary or skip the remaining connectors.
       * The in-process lock is always freed regardless, and the failure is
       * surfaced as a sanitized warning on the connector result instead.
       */
      async release() {
        const warnings = [];
        try {
          await external.release?.();
        } catch {
          warnings.push("external-lock-release-failed");
        } finally {
          local.release();
        }
        return warnings;
      },
    };
  }

  async function runConnector(connectorId, runOptions, runId) {
    const instance = instances.get(connectorId);
    const startedAt = now();
    const startedMonotonic = monotonicNow();
    let lock;
    try {
      lock = await acquireLocks(connectorId, runId, startedAt);
    } catch (error) {
      // An external lock provider that fails is a fail-closed condition for
      // this connector only: it must not abort the other connectors, whose
      // scopes are independent. `acquireLocks` already released the
      // in-process lock before rethrowing.
      const completedAt = now();
      return {
        connectorId,
        status: "failed",
        mode: runOptions.mode,
        startedAt,
        completedAt,
        resumedFromCheckpoint: false,
        checkpointAdvanced: false,
        batches: 0,
        recordCount: 0,
        committedCount: 0,
        duplicateCount: 0,
        durationMs: elapsedDurationMs(startedAt, completedAt),
        throughputRecordsPerSecond: 0,
        duplicateRate: 0,
        ingestionLagSeconds: null,
        truncated: false,
        durabilityWarnings: 0,
        error: describeError(error, "lock"),
      };
    }
    if (!lock.acquired) {
      if (runOptions.overlapPolicy === "fail") {
        throw new SyncRunConflictError({ ...scope, connectorId });
      }
      return {
        connectorId,
        status: "skipped",
        reason: lock.reason,
        mode: runOptions.mode,
        startedAt,
        completedAt: startedAt,
        resumedFromCheckpoint: false,
        checkpointAdvanced: false,
        batches: 0,
        recordCount: 0,
        committedCount: 0,
        duplicateCount: 0,
        durationMs: 0,
        throughputRecordsPerSecond: 0,
        duplicateRate: 0,
        ingestionLagSeconds: null,
        truncated: false,
        durabilityWarnings: 0,
      };
    }

    // Everything from here on runs inside the try whose finally releases the
    // lock. Nothing -- including reading the stored checkpoint, which can
    // throw for an uninitialized or unreadable store -- may run between
    // acquiring the lock and entering that try: an escape there would leave
    // the scope locked for the lifetime of the process, and every later run
    // would be reported as a harmless "already in progress" skip while the
    // schedule silently stalled.
    let buffer = [];
    let batches = 0;
    let recordCount = 0;
    let committedCount = 0;
    let duplicateCount = 0;
    let durabilityWarnings = 0;
    let checkpointAdvanced = false;
    let truncated = false;
    let truncationReason = null;
    let resumed = false;
    let failure;
    let warnings = [];
    /**
     * Which side of the boundary the current await is on, so a failure can
     * be attributed accurately: `"collect"` means the connector/source
     * failed, `"commit"` means the durable store rejected the batch (and
     * already rolled it back), `"checkpoint"` means the proposed cursor was
     * not persistable, `"start"` means the stored cursor could not be read.
     */
    let stage = "start";
    let lastCommittedIdentity = null;
    let sourceWatermark = null;
    const collectionController = new AbortController();
    const deadlineError = new Error("Connector collection exceeded maxDurationMs");
    deadlineError.name = "SyncDeadlineExceededError";
    const cancellationError = new Error("The synchronization was cancelled");
    cancellationError.name = "SyncCancelledError";
    cancellationError.code = "sync_cancelled";
    let externallyCancelled = false;
    const cancelFromExternalSignal = () => {
      if (collectionController.signal.aborted) return;
      externallyCancelled = true;
      collectionController.abort(cancellationError);
    };
    if (runOptions.signal?.aborted) {
      cancelFromExternalSignal();
    } else {
      runOptions.signal?.addEventListener("abort", cancelFromExternalSignal, { once: true });
    }
    const deadlineTimer =
      runOptions.maxDurationMs === null || runOptions.maxDurationMs === undefined
        ? null
        : setTimeout(() => {
          if (!collectionController.signal.aborted) {
            collectionController.abort(deadlineError);
          }
        }, runOptions.maxDurationMs);

    function throwIfExternallyCancelled() {
      if (externallyCancelled || runOptions.signal?.aborted) {
        throw cancellationError;
      }
    }

    async function commitBuffer({ advanceCheckpoint }) {
      const records = buffer;
      let checkpointToCommit;
      if (advanceCheckpoint && runOptions.checkpointPolicy === "advance") {
        const proposed = readCheckpoint(instance);
        if (proposed !== undefined && proposed !== null) {
          stage = "checkpoint";
          assertJsonCheckpoint(connectorId, proposed);
          stage = "collect";
          if (checkpointIdentity(proposed) !== lastCommittedIdentity) {
            checkpointToCommit = { ...proposed, observedAt: proposed.observedAt ?? now() };
            sourceWatermark = validTimestamp(checkpointToCommit.sourceWatermark)
              ?? sourceWatermark;
          }
        }
      }
      if (records.length === 0 && checkpointToCommit === undefined) return;
      stage = "commit";
      const result = await store.commit({
        connectorId: storageConnectorId(connectorId),
        records,
        ...(checkpointToCommit === undefined ? {} : { checkpoint: checkpointToCommit }),
      });
      stage = "collect";
      // Only after the store has committed: a rejected commit rolls back
      // completely (ING-105), so those records are still uncommitted and
      // must stay owned by this run rather than being dropped.
      buffer = [];
      batches += 1;
      committedCount += result.committedCount;
      duplicateCount += result.duplicateCount;
      if (result.durabilityWarning) durabilityWarnings += 1;
      if (checkpointToCommit !== undefined) {
        lastCommittedIdentity = checkpointIdentity(checkpointToCommit);
        checkpointAdvanced = true;
      }
      // Return control to the macrotask/I-O queue after each committed batch.
      // `store.commit` fsyncs (real I/O) and normally yields on its own, but an
      // in-memory or fast store could otherwise let a tight collect->commit
      // loop starve unrelated requests.
      await yieldAfterCommit();
    }

    try {
      const startState = resolveStartCheckpoint(connectorId, runOptions);
      resumed = startState.resumed;
      lastCommittedIdentity = checkpointIdentity(startState.stored);
      sourceWatermark = validTimestamp(startState.stored?.sourceWatermark);
      stage = "collect";
      const startCheckpoint = structuredClone(startState.start);
      throwIfExternallyCancelled();
      const collected = instance.collect(startCheckpoint, {
        signal: collectionController.signal,
      });
      for await (const record of collected) {
        throwIfExternallyCancelled();
        recordCount += 1;
        buffer.push(record);
        if (
          runOptions.maxRecordsPerConnector !== null &&
          runOptions.maxRecordsPerConnector !== undefined &&
          recordCount >= runOptions.maxRecordsPerConnector
        ) {
          truncated = true;
          truncationReason = "max-records";
        }
        if (
          !truncated
          && !externallyCancelled
          && runOptions.maxDurationMs !== null
          && runOptions.maxDurationMs !== undefined
          && monotonicNow() - startedMonotonic >= runOptions.maxDurationMs
        ) {
          truncated = true;
          truncationReason = "max-duration";
          if (!collectionController.signal.aborted) {
            collectionController.abort(deadlineError);
          }
        }
        if (buffer.length >= runOptions.batchSize || truncated) {
          await commitBuffer({ advanceCheckpoint: true });
        }
        if (truncated) break;
      }
      if (
        !truncated
        && runOptions.maxDurationMs !== null
        && runOptions.maxDurationMs !== undefined
        && (
          collectionController.signal.aborted
          || monotonicNow() - startedMonotonic >= runOptions.maxDurationMs
        )
      ) {
        truncated = true;
        truncationReason = "max-duration";
      }
      throwIfExternallyCancelled();
      await commitBuffer({ advanceCheckpoint: true });
      throwIfExternallyCancelled();
    } catch (error) {
      const externalCancellation =
        externallyCancelled
        && stage === "collect";
      const deadlineExceeded =
        !externalCancellation
        && collectionController.signal.aborted
        && stage === "collect";
      if (externalCancellation) {
        truncated = false;
        truncationReason = null;
        failure = describeError(cancellationError, "collect");
      } else if (deadlineExceeded) {
        truncated = true;
        truncationReason = "max-duration";
      } else {
        failure = describeError(error, stage);
      }
      // Evidence already streamed is still durable-worthy, but the cursor
      // must not move past a region whose collection failed: committing
      // records without advancing the checkpoint keeps the next run's
      // re-read safe (duplicates are deduplicated by the store) and can
      // never skip evidence.
      //
      // The salvage is skipped when the failure came from the store itself,
      // because ING-105 already rolled that batch back completely and
      // re-submitting the identical batch would just fail again, replacing
      // the original, more informative failure descriptor.
      if (externalCancellation) {
        try {
          await commitBuffer({ advanceCheckpoint: false });
        } catch (commitError) {
          failure = describeError(commitError, "commit-after-failure");
        }
      } else if (deadlineExceeded) {
        try {
          await commitBuffer({ advanceCheckpoint: true });
        } catch (commitError) {
          failure = describeError(commitError, "commit-after-failure");
        }
      } else if (stage !== "commit" && stage !== "start") {
        try {
          await commitBuffer({ advanceCheckpoint: false });
        } catch (commitError) {
          failure = describeError(commitError, "commit-after-failure");
        }
      }
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      runOptions.signal?.removeEventListener("abort", cancelFromExternalSignal);
      warnings = await lock.release();
    }

    const completedAt = now();
    const durationMs = elapsedDurationMs(startedAt, completedAt);
    const result = {
      connectorId,
      // A truncated run is deliberately *not* reported as a plain success:
      // it stopped before the source was exhausted, and whether the next
      // run makes progress depends on the connector resuming from a
      // mid-stream cursor -- something the production connectors
      // intentionally do not do (they replay from page zero for safety).
      status: failure ? "failed" : truncated ? "truncated" : "succeeded",
      mode: runOptions.mode,
      startedAt,
      completedAt,
      resumedFromCheckpoint: resumed,
      startedFromStoredCheckpoint: runOptions.mode !== "replay-full" && runOptions.startCheckpoint === undefined,
      checkpointPolicy: runOptions.checkpointPolicy,
      checkpointAdvanced,
      batches,
      recordCount,
      committedCount,
      duplicateCount,
      durationMs,
      throughputRecordsPerSecond: throughput(recordCount, durationMs),
      duplicateRate: ratio(duplicateCount, recordCount),
      ingestionLagSeconds: sourceWatermark === null
        ? null
        : Math.max(0, (Date.parse(completedAt) - sourceWatermark) / 1_000),
      truncated,
      durabilityWarnings,
    };
    if (truncationReason) result.truncationReason = truncationReason;
    if (failure) result.error = failure;
    if (warnings.length > 0) result.warnings = warnings;

    if (typeof instance.health === "function") {
      try {
        recordHealth(connectorId, await instance.health());
      } catch {
        // A connector whose health() throws must not fail an otherwise complete run.
      }
    }
    return result;
  }

  function planConnector(connectorId, runOptions) {
    const { stored, resumed } = resolveStartCheckpoint(connectorId, runOptions);
    return {
      connectorId,
      status: "planned",
      reason: "dry-run",
      mode: runOptions.mode,
      storedCheckpointPresent: stored !== undefined,
      wouldResumeFromStoredCheckpoint: resumed,
      wouldStartFromBeginning: runOptions.mode === "replay-full",
      checkpointPolicy: runOptions.checkpointPolicy,
      wouldAdvanceCheckpoint: runOptions.checkpointPolicy === "advance",
      wouldClearCheckpoint: false,
      runAlreadyInProgress: isRunInProgress({
        ...scope,
        connectorId: storageConnectorId(connectorId)
      }),
      batchSize: runOptions.batchSize,
      maxRecordsPerConnector: runOptions.maxRecordsPerConnector ?? null,
      maxDurationMs: runOptions.maxDurationMs ?? null,
      replayConfirmed: runOptions.confirmedReplay,
    };
  }

  function summarize(runOptions, runId, startedAt, connectorResults, { planned }) {
    const totals = connectorResults.reduce(
      (accumulator, result) => ({
        recordCount: accumulator.recordCount + (result.recordCount ?? 0),
        committedCount: accumulator.committedCount + (result.committedCount ?? 0),
        duplicateCount: accumulator.duplicateCount + (result.duplicateCount ?? 0),
        batches: accumulator.batches + (result.batches ?? 0),
        succeeded: accumulator.succeeded + (result.status === "succeeded" ? 1 : 0),
        failed: accumulator.failed + (result.status === "failed" ? 1 : 0),
        skipped: accumulator.skipped + (result.status === "skipped" ? 1 : 0),
        truncated: accumulator.truncated + (result.status === "truncated" ? 1 : 0),
      }),
      {
        recordCount: 0,
        committedCount: 0,
        duplicateCount: 0,
        batches: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        truncated: 0,
      },
    );
    const completedAt = now();
    const durationMs = elapsedDurationMs(startedAt, completedAt);
    totals.durationMs = durationMs;
    totals.throughputRecordsPerSecond = throughput(totals.recordCount, durationMs);
    totals.duplicateRate = ratio(totals.duplicateCount, totals.recordCount);
    const ingestionLags = connectorResults
      .map((result) => result.ingestionLagSeconds)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    totals.ingestionLagSeconds = ingestionLags.length > 0 ? Math.max(...ingestionLags) : null;
    // A run is only "succeeded" when every connector that actually ran
    // finished its source. A truncated connector stopped early, so the run
    // is reported as incomplete ("partial") and the CLI exits non-zero:
    // whether the next run makes progress depends on that connector
    // resuming from a mid-stream cursor, which is not a guarantee this
    // boundary can make on a connector's behalf.
    const status = planned
      ? "planned"
      : totals.failed > 0 && totals.succeeded === 0 && totals.truncated === 0
        ? "failed"
        : totals.failed > 0 || totals.truncated > 0
          ? "partial"
          : totals.succeeded > 0
            ? "succeeded"
            : "skipped";
    return sanitizeOperationsData(
      {
        reportType: planned ? "sync.run.plan" : "sync.run.summary",
        runId,
        tenantId: scope.tenantId,
        productId: scope.productId,
        mode: runOptions.mode,
        dryRun: runOptions.dryRun,
        status,
        startedAt,
        completedAt,
        scheduleCadence: settings.schedule.cadence,
        scheduleStatus: settings.schedule.configurationStatus,
        overlapPolicy: runOptions.overlapPolicy,
        batchSize: runOptions.batchSize,
        maxRecordsPerConnector: runOptions.maxRecordsPerConnector ?? null,
        maxDurationMs: runOptions.maxDurationMs ?? null,
        connectors: connectorResults,
        totals,
      },
      "runSummary",
    );
  }

  return Object.freeze({
    tenantId: scope.tenantId,
    productId: scope.productId,
    settings,

    /** Enabled connector IDs this coordinator will run, in configuration order. */
    listConnectors() {
      return [...enabledConnectorIds];
    },

    /** Operator-facing description of scope, schedule, and retention posture. */
    describe() {
      return {
        tenantId: scope.tenantId,
        productId: scope.productId,
        connectors: [...enabledConnectorIds],
        schedule: describeSchedule(settings.schedule),
        batchSize: settings.batchSize,
        maxRecordsPerConnector: settings.maxRecordsPerConnector,
        maxDurationMs: settings.maxDurationMs,
        overlapPolicy: settings.overlapPolicy,
        retention: { ...settings.retention, pruneSupported: false },
        modes: [...SYNC_MODES],
      };
    },

    /**
     * Plans a run without contacting any source, committing anything, or
     * taking a lock. Safe to run in production at any time, including for a
     * replay that has not been confirmed yet.
     */
    plan(options = {}) {
      const runOptions = resolveRunOptions({ ...options, dryRun: true });
      const runId = newRunId();
      const startedAt = now();
      const connectorResults = runOptions.connectorIds.map((connectorId) =>
        planConnector(connectorId, runOptions),
      );
      return summarize(runOptions, runId, startedAt, connectorResults, { planned: true });
    },

    /**
     * Runs every requested connector once and returns a sanitized summary.
     * This is the unit of work an external cron/job runner invokes; it
     * starts no timer and leaves nothing running.
     *
     * A connector failure never aborts the other connectors: each one has
     * its own lock, its own checkpoint namespace, and its own result entry,
     * so a degraded source cannot block a healthy one.
     */
    async runOnce(options = {}) {
      const runOptions = resolveRunOptions(options);
      const runId = newRunId();
      const startedAt = now();

      if (runOptions.dryRun) {
        const plan = summarize(
          runOptions,
          runId,
          startedAt,
          runOptions.connectorIds.map((connectorId) => planConnector(connectorId, runOptions)),
          { planned: true },
        );
        await emitAudit({ eventType: "sync.run.planned", ...plan });
        lastSummary = plan;
        return plan;
      }

      await emitAudit({
        eventType: "sync.run.started",
        runId,
        tenantId: scope.tenantId,
        productId: scope.productId,
        mode: runOptions.mode,
        connectors: runOptions.connectorIds,
        batchSize: runOptions.batchSize,
        startedAt,
      });

      const connectorResults = [];
      for (const connectorId of runOptions.connectorIds) {
        const result = await runConnector(connectorId, runOptions, runId);
        connectorResults.push(result);
        await emitAudit({ eventType: "sync.connector.completed", runId, ...result });
      }

      const summary = summarize(runOptions, runId, startedAt, connectorResults, { planned: false });
      lastSummary = summary;
      await emitAudit({ eventType: "sync.run.completed", ...summary });
      return summary;
    },

    /**
     * Non-destructive retention report for this scope. Never deletes; see
     * `./retention.js` for why pruning is not offered. The store and the
     * configured policy are fixed by this coordinator's scope and cannot be
     * overridden per call.
     */
    planRetention({ connectorIds, now: clock } = {}) {
      const report = sanitizeOperationsData(
        planRetention({
          store,
          settings,
          connectorIds: connectorIds ?? enabledConnectorIds,
          now: clock ?? now,
        }),
        "retentionReport",
      );
      void emitAudit({ eventType: "sync.retention.planned", ...report });
      return report;
    },

    /**
     * Bounded, crash-safe raw-evidence compaction. Non-destructive by default;
     * see `@tkl/raw-evidence-store` `compact()`. Serializes with sync commits
     * on the same store instance. Returns a sanitized status.
     */
    async compact(options = {}) {
      if (typeof store.compact !== "function") {
        throw new SyncConfigurationError(
          "The configured raw evidence store does not support compaction",
        );
      }
      const result = sanitizeOperationsData(
        { reportType: "evidence.compaction", ...(await store.compact(options)) },
        "compactionResult",
      );
      await emitAudit({ eventType: "sync.evidence.compacted", ...result });
      return result;
    },

    /** Sanitized compaction/maintenance posture for this scope, if supported. */
    maintenanceStatus() {
      if (typeof store.maintenanceStatus !== "function") return null;
      return sanitizeOperationsData(
        { reportType: "evidence.maintenance.status", ...store.maintenanceStatus() },
        "maintenanceStatus",
      );
    },

    /**
     * Non-mutating cross-tier reconciliation. Reads raw counts/checksums,
     * pending projection/dead-letter state, and (when `knowledge` counts are
     * supplied) the Silver/Gold tiers, and returns structured findings.
     */
    reconcile({ filters, knowledge, now: clock } = {}) {
      const report = sanitizeOperationsData(
        reconcileEvidence({ rawStore: store, filters, knowledge, now: clock ?? now }),
        "reconciliationReport",
      );
      void emitAudit({ eventType: "sync.evidence.reconciled", ...report });
      return report;
    },

    /**
     * Executes an explicitly confirmed, bounded reconciliation repair
     * (currently dead-letter requeue) against the raw store.
     */
    async applyReconciliationRepairs({ actions, confirm, limit, now: clock } = {}) {
      const result = sanitizeOperationsData(
        await applyReconciliationRepairs({
          rawStore: store,
          actions,
          confirm,
          limit,
          now: clock ?? now,
        }),
        "reconciliationRepair",
      );
      await emitAudit({ eventType: "sync.evidence.repaired", ...result });
      return result;
    },

    /** Plans a bounded Silver rebuild from durable raw evidence. */
    planSilverRebuild({ filters, limit, cursor } = {}) {
      return sanitizeOperationsData(
        planSilverRebuild({ rawStore: store, filters, limit, cursor }),
        "silverRebuildPlan",
      );
    },

    /**
     * Rebuilds the Silver tier by replaying durable raw evidence through the
     * supplied idempotent projector, in bounded batches with a resumable
     * cursor. Never processes the full matched set without a `limit` or
     * explicit `confirm`.
     */
    async rebuildSilver({ projectRecords, filters, limit, cursor, batchSize, dryRun, confirm, now: clock } = {}) {
      const result = sanitizeOperationsData(
        await rebuildSilverFromRawEvidence({
          rawStore: store,
          projectRecords,
          filters,
          limit,
          cursor,
          batchSize,
          dryRun,
          confirm,
          now: clock ?? now,
        }),
        "silverRebuild",
      );
      await emitAudit({ eventType: "sync.evidence.silver-rebuilt", ...result });
      return result;
    },

    /**
     * Rebuilds the Gold serving projections using the supplied knowledge
     * store's bounded rebuild primitive.
     */
    async rebuildGold({ knowledgeStore, batchSize, cursor, maxBatches, dryRun, now: clock } = {}) {
      const result = sanitizeOperationsData(
        await rebuildGoldProjections({
          knowledgeStore,
          batchSize,
          cursor,
          maxBatches,
          dryRun,
          now: clock ?? now,
        }),
        "goldRebuild",
      );
      await emitAudit({ eventType: "sync.evidence.gold-rebuilt", ...result });
      return result;
    },

    /** The last run/plan summary produced by this coordinator instance, if any. */
    lastRunSummary() {
      return lastSummary === null ? null : structuredClone(lastSummary);
    },

    /**
     * Coordinator-level health, derived only from the last run summary in
     * this process. `"unknown"` means no run has happened here yet -- it is
     * never reported as healthy by default.
     */
    health() {
      if (lastSummary === null) {
        return { status: "unknown", tenantId: scope.tenantId, productId: scope.productId };
      }
      return {
        status:
          lastSummary.status === "succeeded" || lastSummary.status === "planned"
            ? "healthy"
            : lastSummary.status === "skipped"
              ? "unknown"
              : "degraded",
        tenantId: scope.tenantId,
        productId: scope.productId,
        lastRunId: lastSummary.runId,
        lastRunStatus: lastSummary.status,
        lastRunCompletedAt: lastSummary.completedAt,
        lastRunTotals: lastSummary.totals,
      };
    },
  });
}

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function elapsedDurationMs(startedAt, completedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function throughput(recordCount, durationMs) {
  return durationMs > 0 ? recordCount / (durationMs / 1_000) : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
