import { randomUUID } from "node:crypto";
import { acquireRunLock } from "./locks.js";
import { countRawRecords, normalizeReconcileFilters, pageRawRecords } from "./reconcile.js";
import {
  MaintenanceConfirmationRequiredError,
  MaintenanceLockError,
  RetentionPolicyError,
} from "./errors.js";

/**
 * Controlled, bounded rebuilds for the Silver (canonical) and Gold (serving)
 * tiers (P4).
 *
 * Silver rebuild replays durable raw evidence (Bronze) back through the
 * caller-supplied normalization/ingest projector. Because canonical ingestion
 * is content-addressed and idempotent (upsert by content hash), replaying a
 * record reconciles the canonical store to match the evidence without dropping
 * provenance or creating duplicates. A rebuild never processes the full
 * matched set implicitly: the caller must pass a finite `limit` or explicit
 * `confirm: true`. Progress is reported as a record cursor so a large rebuild
 * can be resumed across invocations.
 *
 * Gold rebuild reuses the knowledge store's own bounded
 * `rebuildServingProjections(cursor/batch)` primitive and drives it to
 * completion within a bounded number of batches.
 */

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;
const DEFAULT_MAX_GOLD_BATCHES = 100;
const MAINTENANCE_LOCK_CONNECTOR = "maintenance.rebuild";

function assertRawStore(rawStore) {
  if (
    !rawStore
    || (typeof rawStore.pageRecords !== "function" && typeof rawStore.listRecords !== "function")
  ) {
    throw new RetentionPolicyError(
      "A raw evidence store with pageRecords/countRecords is required for rebuild",
    );
  }
}

function assertBatchSize(batchSize) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RetentionPolicyError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
}

function assertCursor(cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RetentionPolicyError("cursor must be a non-negative integer");
  }
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RetentionPolicyError("limit must be a positive integer");
  }
  return limit;
}

/**
 * Plans a Silver rebuild without projecting anything: reports how many raw
 * records match the filters and how many this bounded run would process.
 */
export function planSilverRebuild({ rawStore, filters = {}, limit, cursor = 0 } = {}) {
  assertRawStore(rawStore);
  assertCursor(cursor);
  const normalizedLimit = normalizeLimit(limit);
  const matched = countRawRecords(rawStore, filters);
  const available = Math.max(0, matched - cursor);
  const wouldProcess = normalizedLimit === undefined ? available : Math.min(normalizedLimit, available);
  return Object.freeze({
    reportType: "evidence.rebuild.silver.plan",
    tenantId: rawStore.tenantId,
    productId: rawStore.productId,
    tier: "silver",
    matched,
    cursor,
    wouldProcess,
    nextCursor: cursor + wouldProcess,
    done: cursor + wouldProcess >= matched,
    limit: normalizedLimit ?? null,
  });
}

/**
 * Rebuilds the Silver tier from durable raw evidence in bounded batches.
 *
 * @param {object} args
 * @param {object} args.rawStore Durable raw-evidence store (Bronze).
 * @param {(records: object[]) => Promise<unknown>} [args.projectRecords]
 *   Idempotent canonical projector (required unless `dryRun`).
 * @param {object} [args.filters] `{ connectorId, source, sourceVersion,
 *   observedFrom, observedTo }`.
 * @param {number} [args.limit] Max records to process this run (safety cap).
 * @param {number} [args.cursor] Records already processed (resume offset).
 * @param {number} [args.batchSize]
 * @param {boolean} [args.dryRun]
 * @param {boolean} [args.confirm] Required to process the full matched set
 *   when no `limit` is given.
 * @param {() => string} [args.now]
 */
export async function rebuildSilverFromRawEvidence({
  rawStore,
  projectRecords,
  filters = {},
  limit,
  cursor = 0,
  batchSize = DEFAULT_BATCH_SIZE,
  dryRun = false,
  confirm = false,
  now = () => new Date().toISOString(),
} = {}) {
  assertRawStore(rawStore);
  assertCursor(cursor);
  assertBatchSize(batchSize);
  const normalizedLimit = normalizeLimit(limit);

  if (dryRun) {
    return planSilverRebuild({ rawStore, filters, limit: normalizedLimit, cursor });
  }

  // Never rebuild the full matched history implicitly: require either a finite
  // per-run cap or an explicit confirmation.
  if (normalizedLimit === undefined && confirm !== true) {
    throw new MaintenanceConfirmationRequiredError("rebuild-silver");
  }
  if (typeof projectRecords !== "function") {
    throw new RetentionPolicyError("projectRecords must be a function for a non-dry-run rebuild");
  }

  const scope = {
    tenantId: rawStore.tenantId,
    productId: rawStore.productId,
    connectorId: MAINTENANCE_LOCK_CONNECTOR,
  };
  const startedAt = now();
  const lock = acquireRunLock(scope, { runId: randomUUID(), startedAt });
  if (!lock) throw new MaintenanceLockError(scope);

  try {
    const normalizedFilters = normalizeReconcileFilters(filters);
    const matched = countRawRecords(rawStore, normalizedFilters);
    const available = Math.max(0, matched - cursor);
    const target = normalizedLimit === undefined ? available : Math.min(normalizedLimit, available);
    let processed = 0;
    let batches = 0;
    // Load and project only bounded pages: at most `batchSize` records are
    // cloned into memory at a time, so a `limit`ed run (e.g. 100) never
    // materializes the full corpus.
    while (processed < target) {
      const pageLimit = Math.min(batchSize, target - processed);
      const page = pageRawRecords(rawStore, normalizedFilters, cursor + processed, pageLimit);
      if (page.records.length === 0) break;
      await projectRecords(page.records);
      processed += page.records.length;
      batches += 1;
    }
    const nextCursor = cursor + processed;
    return Object.freeze({
      reportType: "evidence.rebuild.silver",
      tenantId: rawStore.tenantId,
      productId: rawStore.productId,
      tier: "silver",
      matched,
      cursor,
      processed,
      batches,
      nextCursor,
      remaining: Math.max(0, matched - nextCursor),
      done: nextCursor >= matched,
      completedAt: now(),
    });
  } finally {
    lock.release();
  }
}

/**
 * Rebuilds the Gold serving projections using the knowledge store's own
 * bounded rebuild primitive, driven to completion within `maxBatches`.
 *
 * @param {object} args
 * @param {object} args.knowledgeStore Store exposing
 *   `rebuildServingProjections({ batchSize, cursor })` and
 *   `pendingServingProjectionCount()`.
 * @param {number} [args.batchSize]
 * @param {number} [args.cursor]
 * @param {number} [args.maxBatches] Upper bound on rebuild batches per run.
 * @param {boolean} [args.dryRun]
 * @param {() => string} [args.now]
 */
export async function rebuildGoldProjections({
  knowledgeStore,
  batchSize = DEFAULT_BATCH_SIZE,
  cursor = 0,
  maxBatches = DEFAULT_MAX_GOLD_BATCHES,
  dryRun = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (!knowledgeStore || typeof knowledgeStore.rebuildServingProjections !== "function") {
    throw new RetentionPolicyError(
      "A knowledge store with rebuildServingProjections is required for a Gold rebuild",
    );
  }
  assertCursor(cursor);
  assertBatchSize(batchSize);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new RetentionPolicyError("maxBatches must be a positive integer");
  }

  const pendingBefore = typeof knowledgeStore.pendingServingProjectionCount === "function"
    ? knowledgeStore.pendingServingProjectionCount()
    : null;

  if (dryRun) {
    return Object.freeze({
      reportType: "evidence.rebuild.gold.plan",
      tier: "gold",
      cursor,
      batchSize,
      maxBatches,
      pendingBefore,
    });
  }

  let currentCursor = cursor;
  let processed = 0;
  let batches = 0;
  let done = false;
  let lastResult;
  while (batches < maxBatches) {
    lastResult = knowledgeStore.rebuildServingProjections({ batchSize, cursor: currentCursor });
    processed += Number.isSafeInteger(lastResult.processed) ? lastResult.processed : 0;
    batches += 1;
    if (lastResult.done) {
      done = true;
      break;
    }
    if (lastResult.nextCursor === undefined || lastResult.nextCursor === currentCursor) {
      break;
    }
    currentCursor = lastResult.nextCursor;
  }

  return Object.freeze({
    reportType: "evidence.rebuild.gold",
    tier: "gold",
    cursor,
    processed,
    batches,
    done,
    nextCursor: done ? null : lastResult?.nextCursor ?? currentCursor,
    remaining: typeof knowledgeStore.pendingServingProjectionCount === "function"
      ? knowledgeStore.pendingServingProjectionCount()
      : null,
    version: lastResult?.version ?? null,
    completedAt: now(),
  });
}
