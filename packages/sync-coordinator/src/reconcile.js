import { createHash } from "node:crypto";
import { MaintenanceConfirmationRequiredError, RetentionPolicyError } from "./errors.js";

/**
 * Bounded, non-destructive reconciliation for the Bronze/Silver/Gold TKL
 * pipeline (P4).
 *
 * `reconcileEvidence` compares what the durable raw-evidence store (Bronze)
 * holds against its own derived state and, when the caller supplies a
 * `knowledge` snapshot, against the canonical (Silver) and serving (Gold)
 * tiers. It **never mutates** anything: it reads counts, checkpoints, the
 * append-only history, and dead-letter metadata and returns structured,
 * actionable findings. Repairs are a separate, explicitly gated step
 * (`applyReconciliationRepairs`).
 *
 * Everything emitted is a count, an enum string, an ISO timestamp, or a hex
 * digest, so it passes the coordinator's sanitization guard unchanged (no
 * payloads, source IDs, URLs, credential references, or filesystem paths).
 */

const SEVERITY_ORDER = { info: 0, warning: 1, error: 2 };

function parseTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function assertRawStore(rawStore) {
  if (
    !rawStore
    || typeof rawStore.history !== "function"
    || typeof rawStore.countPendingProjectionRecords !== "function"
    || typeof rawStore.countDeadLetterProjectionRecords !== "function"
    || (typeof rawStore.pageRecords !== "function" && typeof rawStore.listRecords !== "function")
  ) {
    throw new RetentionPolicyError(
      "A raw evidence store with pageRecords/history/count* is required for reconciliation",
    );
  }
}

export function normalizeReconcileFilters(filters = {}) {
  return normalizeFilters(filters);
}

function normalizeFilters(filters = {}) {
  const normalized = {};
  if (filters.connectorId !== undefined) normalized.connectorId = String(filters.connectorId);
  if (filters.source !== undefined) normalized.source = String(filters.source);
  if (filters.sourceVersion !== undefined) {
    normalized.sourceVersion = String(filters.sourceVersion);
  }
  if (filters.observedFrom !== undefined) {
    const from = parseTimestamp(filters.observedFrom);
    if (from === undefined) throw new RetentionPolicyError("observedFrom must be an ISO-8601 value");
    normalized.observedFrom = new Date(from).toISOString();
  }
  if (filters.observedTo !== undefined) {
    const to = parseTimestamp(filters.observedTo);
    if (to === undefined) throw new RetentionPolicyError("observedTo must be an ISO-8601 value");
    normalized.observedTo = new Date(to).toISOString();
  }
  return normalized;
}

const DEFAULT_SELECT_PAGE_SIZE = 500;

/**
 * Legacy fallback for stores that expose only `listRecords`: applies the
 * source/version/range filters the store filter may not cover. Only used when
 * bounded `pageRecords`/`countRecords` primitives are unavailable.
 */
function selectViaListRecords(rawStore, normalized) {
  const storeFilter = {};
  if (normalized.connectorId) storeFilter.connectorId = normalized.connectorId;
  if (normalized.source) storeFilter.source = normalized.source;
  const fromMs = normalized.observedFrom ? Date.parse(normalized.observedFrom) : undefined;
  const toMs = normalized.observedTo ? Date.parse(normalized.observedTo) : undefined;
  return rawStore.listRecords(storeFilter).filter((record) => {
    if (normalized.sourceVersion && String(record.sourceVersion) !== normalized.sourceVersion) {
      return false;
    }
    const observedMs = parseTimestamp(record.observedAt);
    if (fromMs !== undefined && (observedMs === undefined || observedMs < fromMs)) return false;
    if (toMs !== undefined && (observedMs === undefined || observedMs > toMs)) return false;
    return true;
  });
}

/**
 * Counts matching raw records without cloning the corpus. Prefers the store's
 * bounded `countRecords` primitive and falls back to `listRecords` only for
 * legacy stores that predate it.
 */
export function countRawRecords(rawStore, filters = {}) {
  const normalized = normalizeFilters(filters);
  if (typeof rawStore.countRecords === "function") {
    return rawStore.countRecords(normalized);
  }
  return selectViaListRecords(rawStore, normalized).length;
}

/**
 * Fetches one bounded page of matching raw records in durable order, cloning
 * only that page. `normalized` must already be a normalized filter object (see
 * {@link normalizeReconcileFilters}).
 */
export function pageRawRecords(rawStore, normalized, cursor, limit) {
  if (typeof rawStore.pageRecords === "function") {
    return rawStore.pageRecords({ filter: normalized, cursor, limit });
  }
  const all = selectViaListRecords(rawStore, normalized);
  const records = all.slice(cursor, cursor + limit);
  const nextCursor = cursor + records.length;
  return { records, cursor, nextCursor, done: nextCursor >= all.length };
}

/**
 * Returns all matched records in durable commit order. Prefers bounded paging
 * so it never asks a store to deep-clone its whole corpus in one call; large
 * callers should instead use {@link countRawRecords}/{@link pageRawRecords}
 * directly to avoid materializing the full set.
 */
export function selectRawRecords(rawStore, filters = {}) {
  const normalized = normalizeFilters(filters);
  if (typeof rawStore.pageRecords !== "function") {
    return selectViaListRecords(rawStore, normalized);
  }
  const out = [];
  let cursor = 0;
  for (;;) {
    const page = rawStore.pageRecords({ filter: normalized, cursor, limit: DEFAULT_SELECT_PAGE_SIZE });
    out.push(...page.records);
    if (page.done || page.records.length === 0) break;
    cursor = page.nextCursor;
  }
  return out;
}

function checksumLine(record) {
  return `${record.source}\u0000${record.sourceId}\u0000${record.sourceVersion}\u0000${record.contentHash}`;
}

function digestChecksumLines(lines) {
  const sorted = [...lines].sort();
  const digest = createHash("sha256");
  for (const line of sorted) digest.update(line);
  digest.update(`\u0000count=${sorted.length}`);
  return digest.digest("hex");
}

/**
 * Stable content-addressed digest over the matched raw records. Uses the
 * per-record content hash and source identity captured at ingestion, so it
 * changes if evidence is added, dropped, or rewritten -- the meaningful
 * "checksum" for detecting drift between what a source produced and what the
 * store retains. Sorted so it is independent of iteration order.
 */
export function rawEvidenceChecksum(records) {
  return digestChecksumLines(records.map(checksumLine));
}

const DEFAULT_MAX_SCAN_RECORDS = 1_000_000;
const DEFAULT_MAX_SCAN_PAGES = 100_000;
const DEFAULT_SCAN_PAGE_SIZE = 500;

function normalizeScanOptions(scan = {}) {
  const maxRecords = scan.maxRecords ?? DEFAULT_MAX_SCAN_RECORDS;
  const maxPages = scan.maxPages ?? DEFAULT_MAX_SCAN_PAGES;
  const pageSize = scan.pageSize ?? DEFAULT_SCAN_PAGE_SIZE;
  const cursor = scan.cursor ?? 0;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new RetentionPolicyError("scan.maxRecords must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RetentionPolicyError("scan.maxPages must be a positive integer");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RetentionPolicyError("scan.pageSize must be a positive integer");
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RetentionPolicyError("scan.cursor must be a non-negative integer");
  }
  let deadlineMs;
  if (scan.deadline !== undefined) {
    deadlineMs = parseTimestamp(scan.deadline);
    if (deadlineMs === undefined) throw new RetentionPolicyError("scan.deadline must be an ISO-8601 value");
  } else if (scan.deadlineMs !== undefined) {
    if (!Number.isFinite(scan.deadlineMs)) throw new RetentionPolicyError("scan.deadlineMs must be finite");
    deadlineMs = scan.deadlineMs;
  }
  return { maxRecords, maxPages, pageSize, cursor, deadlineMs };
}

/**
 * Scans matched records page-by-page to build the evidence checksum and
 * per-source counts without ever cloning the whole corpus. Bounded by a finite
 * `maxRecords`, `maxPages`, and optional `deadline`; when a bound is reached it
 * stops and reports `complete: false` plus a resumable cursor. Only small
 * checksum lines (source/id/version/hash) are retained, so peak memory is one
 * cloned page plus at most `maxRecords` short strings.
 */
function scanEvidence(rawStore, normalized, scan, now) {
  const { maxRecords, maxPages, pageSize, cursor, deadlineMs } = scan;
  const lines = [];
  const recordsBySource = {};
  let scanned = 0;
  let pages = 0;
  let currentCursor = cursor;
  let complete = false;
  for (;;) {
    if (pages >= maxPages) break;
    if (deadlineMs !== undefined && (parseTimestamp(now()) ?? Infinity) > deadlineMs) break;
    const remaining = maxRecords - scanned;
    if (remaining <= 0) break;
    const limit = Math.min(pageSize, remaining);
    const page = pageRawRecords(rawStore, normalized, currentCursor, limit);
    for (const record of page.records) {
      lines.push(checksumLine(record));
      const source = typeof record.source === "string" ? record.source : "unknown";
      recordsBySource[source] = (recordsBySource[source] ?? 0) + 1;
    }
    scanned += page.records.length;
    pages += 1;
    currentCursor = page.nextCursor;
    if (page.done || page.records.length === 0) {
      complete = true;
      break;
    }
  }
  return {
    evidenceChecksum: digestChecksumLines(lines),
    recordsBySource,
    scanned,
    pages,
    complete,
    nextCursor: complete ? null : currentCursor,
    maxRecords,
    maxPages,
  };
}

/**
 * Produces a sanitized, non-mutating reconciliation report for a
 * tenant/product scope.
 *
 * @param {object} args
 * @param {object} args.rawStore Durable raw-evidence store (Bronze).
 * @param {object} [args.knowledge] Optional Silver/Gold count snapshot:
 *   `{ canonicalEntityCount, canonicalClaimCount, servingProjectionBacklog,
 *      deferredTraceLinkCount, sourceCounts }`.
 * @param {object} [args.filters] `{ connectorId, source, sourceVersion,
 *   observedFrom, observedTo }`.
 * @param {object} [args.scan] Bounds for the page-by-page evidence scan:
 *   `{ maxRecords, maxPages, pageSize, deadline, cursor }`. All bounds are
 *   finite; when one is reached the report is marked truncated with a
 *   resumable cursor.
 * @param {() => string} [args.now]
 */
export function reconcileEvidence({ rawStore, knowledge, filters = {}, scan = {}, now = () => new Date().toISOString() } = {}) {
  assertRawStore(rawStore);
  const normalizedFilters = normalizeFilters(filters);
  const scanOptions = normalizeScanOptions(scan);
  const generatedAt = now();
  if (parseTimestamp(generatedAt) === undefined) {
    throw new RetentionPolicyError("Reconciliation report requires an ISO-8601 clock value");
  }

  const recordCount = countRawRecords(rawStore, normalizedFilters);
  const scanResult = scanEvidence(rawStore, normalizedFilters, scanOptions, now);
  const history = rawStore.history(normalizedFilters.connectorId);
  const committedFromHistory = history.reduce(
    (total, entry) => total + (Number.isSafeInteger(entry.committedCount) ? entry.committedCount : 0),
    0,
  );
  const pendingProjection = rawStore.countPendingProjectionRecords();
  const deadLettered = rawStore.countDeadLetterProjectionRecords();

  const findings = [];
  const addFinding = (finding) => findings.push(Object.freeze(finding));

  if (pendingProjection > 0) {
    addFinding({
      code: "raw.pending-projection-backlog",
      severity: "warning",
      tier: "bronze",
      pendingProjection,
      remediation: "drain-projections",
    });
  }
  if (deadLettered > 0) {
    addFinding({
      code: "raw.projection-dead-letter",
      severity: "error",
      tier: "bronze",
      deadLettered,
      remediation: "requeue-dead-letter",
    });
  }
  // The evidence scan is bounded; a truncated scan means the checksum and
  // per-source counts cover only a prefix, so it is surfaced as an actionable,
  // resumable finding rather than silently reported as complete.
  if (!scanResult.complete) {
    addFinding({
      code: "raw.reconciliation-truncated",
      severity: "warning",
      tier: "bronze",
      scanned: scanResult.scanned,
      recordCount,
      nextCursor: scanResult.nextCursor,
      remediation: "resume-reconciliation",
    });
  }
  // History is the append-only audit trail; with no filter its committed
  // total must equal the retained record count. A mismatch signals a missing
  // or duplicated transaction and is never silently corrected. Uses the exact
  // (unbounded, non-cloning) record count so a truncated scan cannot cause a
  // false mismatch.
  const filtersRestrictRecords =
    normalizedFilters.source !== undefined
    || normalizedFilters.sourceVersion !== undefined
    || normalizedFilters.observedFrom !== undefined
    || normalizedFilters.observedTo !== undefined;
  if (!filtersRestrictRecords && committedFromHistory !== recordCount) {
    addFinding({
      code: "raw.history-record-count-mismatch",
      severity: "error",
      tier: "bronze",
      historyCommittedCount: committedFromHistory,
      recordCount,
      remediation: "investigate-durability",
    });
  }

  const report = {
    reportType: "evidence.reconciliation",
    tenantId: rawStore.tenantId,
    productId: rawStore.productId,
    generatedAt,
    filters: normalizedFilters,
    bronze: {
      recordCount,
      recordsBySource: scanResult.recordsBySource,
      recordsBySourceComplete: scanResult.complete,
      historyEntryCount: history.length,
      historyCommittedCount: committedFromHistory,
      pendingProjection,
      deadLettered,
      evidenceChecksum: scanResult.evidenceChecksum,
      evidenceChecksumComplete: scanResult.complete,
      evidenceScan: {
        scanned: scanResult.scanned,
        pages: scanResult.pages,
        complete: scanResult.complete,
        nextCursor: scanResult.nextCursor,
        maxRecords: scanResult.maxRecords,
        maxPages: scanResult.maxPages,
      },
    },
    silver: null,
    gold: null,
  };

  if (knowledge && typeof knowledge === "object") {
    const canonicalEntityCount = safeCount(knowledge.canonicalEntityCount);
    const canonicalClaimCount = safeCount(knowledge.canonicalClaimCount);
    const deferredTraceLinkCount = safeCount(knowledge.deferredTraceLinkCount);
    const servingProjectionBacklog = safeCount(knowledge.servingProjectionBacklog);
    report.silver = {
      canonicalEntityCount,
      canonicalClaimCount,
      deferredTraceLinkCount,
    };
    report.gold = {
      servingProjectionBacklog,
    };
    if (deferredTraceLinkCount > 0) {
      addFinding({
        code: "silver.deferred-trace-links",
        severity: "warning",
        tier: "silver",
        deferredTraceLinkCount,
        remediation: "await-or-rebuild-silver",
      });
    }
    if (servingProjectionBacklog > 0) {
      addFinding({
        code: "gold.serving-projection-backlog",
        severity: "warning",
        tier: "gold",
        servingProjectionBacklog,
        remediation: "drain-or-rebuild-gold",
      });
    }
    // Per-source provenance drift compares canonical counts against the raw
    // per-source counts. Those come from the bounded scan, so this check runs
    // only when the scan covered the full matched set; a truncated scan is
    // already surfaced by `raw.reconciliation-truncated`.
    if (scanResult.complete && knowledge.sourceCounts && typeof knowledge.sourceCounts === "object") {
      const rawBySource = report.bronze.recordsBySource;
      for (const [source, canonicalCount] of Object.entries(knowledge.sourceCounts)) {
        const rawCount = rawBySource[source] ?? 0;
        if (safeCount(canonicalCount) > rawCount) {
          addFinding({
            code: "silver.canonical-exceeds-raw",
            severity: "error",
            tier: "silver",
            source,
            canonicalCount: safeCount(canonicalCount),
            rawCount,
            remediation: "investigate-provenance",
          });
        }
      }
    }
  }

  report.findings = findings.sort(
    (left, right) => SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity],
  );
  report.actionable = findings.length > 0;
  report.highestSeverity = findings.reduce(
    (highest, finding) =>
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highest] ? finding.severity : highest,
    "info",
  );
  return Object.freeze(report);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Executes explicitly requested, bounded reconciliation repairs against the
 * raw store. Mutating, so it fails closed unless `confirm === true`. Currently
 * supports requeueing dead-letter projection records (bounded by `limit`) so a
 * transient projection outage can be recovered without a full rebuild.
 *
 * @param {object} args
 * @param {object} args.rawStore
 * @param {object} args.actions `{ requeueDeadLetter?: boolean }`
 * @param {boolean} [args.confirm]
 * @param {number} [args.limit] Max dead-letter records to requeue this call.
 * @param {() => string} [args.now]
 */
export async function applyReconciliationRepairs({
  rawStore,
  actions = {},
  confirm = false,
  limit = 100,
  now = () => new Date().toISOString(),
} = {}) {
  assertRawStore(rawStore);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RetentionPolicyError("limit must be a positive integer");
  }
  const requeueDeadLetter = actions.requeueDeadLetter === true;
  if (!requeueDeadLetter) {
    throw new RetentionPolicyError("No supported repair action was requested");
  }
  if (confirm !== true) {
    throw new MaintenanceConfirmationRequiredError("reconciliation-repair");
  }
  if (
    typeof rawStore.listDeadLetterProjectionRecords !== "function"
    || typeof rawStore.requeueDeadLetterProjectionRecords !== "function"
  ) {
    throw new RetentionPolicyError("The raw store does not support dead-letter requeue");
  }

  const generatedAt = now();
  const deadLetterBefore = rawStore.countDeadLetterProjectionRecords();
  const keys = rawStore
    .listDeadLetterProjectionRecords(limit)
    .map((entry) => entry.idempotencyKey);
  const requeued = keys.length === 0 ? 0 : await rawStore.requeueDeadLetterProjectionRecords(keys);

  return Object.freeze({
    reportType: "evidence.reconciliation.repair",
    tenantId: rawStore.tenantId,
    productId: rawStore.productId,
    generatedAt,
    action: "requeue-dead-letter",
    deadLetterBefore,
    requeued,
    deadLetterRemaining: rawStore.countDeadLetterProjectionRecords(),
    pendingProjection: rawStore.countPendingProjectionRecords(),
  });
}
