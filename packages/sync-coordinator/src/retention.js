import { RetentionPolicyError } from "./errors.js";

/**
 * Retention planning for OPS-101 -- deliberately non-destructive.
 *
 * Why this is a planning/reporting seam and not a pruner:
 *
 * 1. `@tkl/raw-evidence-store` (ING-105) exposes `commit`, `getCheckpoint`,
 *    `getRecord`, `listRecords`, and `history`. There is **no delete API**,
 *    in either the in-memory or the durable encrypted implementation, and
 *    its durable snapshot is written as one authenticated envelope per
 *    scope. Deleting records would mean rewriting that snapshot from
 *    outside the store's own transaction boundary -- exactly the kind of
 *    out-of-band write its crash-recovery/one-writer design forbids.
 * 2. Raw evidence *is* the provenance for canonical knowledge: normalized
 *    entities, claims, and trace links reference the source version,
 *    timestamps, and content hashes captured in these records, and the
 *    repository rule is that provenance is preserved. Pruning a record that
 *    a published claim cites would silently break traceability, which no
 *    retention horizon justifies.
 * 3. History entries are the append-only audit trail of commits; they are
 *    what a restart/replay investigation reads.
 *
 * So the coordinator reports what a retention horizon *would* cover and
 * leaves the decision (archive to approved cold storage, rotate a scope
 * directory, or extend the horizon) to an operator with an approved policy.
 * `planRetention` never mutates the store, and `deletedCount` is always 0 by
 * construction, not by configuration.
 */

export const RETENTION_MODES = Object.freeze(["report-only"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function earlier(left, right) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left <= right ? left : right;
}

function later(left, right) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left >= right ? left : right;
}

/**
 * Builds a sanitized retention report for a tenant/product scope.
 *
 * Only counts, connector IDs, and ISO timestamps are reported: never a
 * payload, a source URL, an idempotency key, a credential reference, or a
 * filesystem path.
 */
export function planRetention({ store, settings, connectorIds = [], now = () => new Date().toISOString() }) {
  if (!store || typeof store.listRecords !== "function" || typeof store.history !== "function") {
    throw new RetentionPolicyError("A raw evidence store with listRecords/history is required");
  }
  const retention = settings?.retention;
  if (!retention || !RETENTION_MODES.includes(retention.mode)) {
    throw new RetentionPolicyError(
      `Retention mode must be one of: ${RETENTION_MODES.join(", ")}; destructive pruning is not supported`,
    );
  }

  const generatedAt = now();
  const generatedAtMs = parseTimestamp(generatedAt);
  if (generatedAtMs === undefined) {
    throw new RetentionPolicyError("Retention report requires an ISO-8601 clock value");
  }
  const cutoffMs =
    retention.rawEvidenceMaxAgeDays === null
      ? undefined
      : generatedAtMs - retention.rawEvidenceMaxAgeDays * DAY_MS;

  const history = store.history();
  const scopeConnectorIds = [
    ...new Set([...connectorIds, ...history.map((entry) => entry.connectorId)]),
  ].sort();

  const connectors = scopeConnectorIds.map((connectorId) => {
    const records = store.listRecords({ connectorId });
    const connectorHistory = store.history(connectorId);
    let eligibleRecordCount = 0;
    let undatedRecordCount = 0;
    let oldest;
    let newest;
    for (const record of records) {
      const observedAtMs = parseTimestamp(record.observedAt);
      if (observedAtMs === undefined) {
        undatedRecordCount += 1;
        continue;
      }
      oldest = earlier(oldest, observedAtMs);
      newest = later(newest, observedAtMs);
      if (cutoffMs !== undefined && observedAtMs < cutoffMs) eligibleRecordCount += 1;
    }
    const historyOverflow =
      retention.historyMaxEntries === null
        ? 0
        : Math.max(0, connectorHistory.length - retention.historyMaxEntries);
    return {
      connectorId,
      recordCount: records.length,
      recordsBeyondHorizon: eligibleRecordCount,
      recordsWithinHorizon: records.length - eligibleRecordCount - undatedRecordCount,
      recordsWithUnparseableTimestamp: undatedRecordCount,
      oldestObservedAt: oldest === undefined ? null : new Date(oldest).toISOString(),
      newestObservedAt: newest === undefined ? null : new Date(newest).toISOString(),
      historyEntryCount: connectorHistory.length,
      historyEntriesBeyondLimit: historyOverflow,
      checkpointPresent: store.getCheckpoint(connectorId) !== undefined,
    };
  });

  const totals = connectors.reduce(
    (accumulator, connector) => ({
      recordCount: accumulator.recordCount + connector.recordCount,
      recordsBeyondHorizon: accumulator.recordsBeyondHorizon + connector.recordsBeyondHorizon,
      historyEntryCount: accumulator.historyEntryCount + connector.historyEntryCount,
      historyEntriesBeyondLimit:
        accumulator.historyEntriesBeyondLimit + connector.historyEntriesBeyondLimit,
    }),
    { recordCount: 0, recordsBeyondHorizon: 0, historyEntryCount: 0, historyEntriesBeyondLimit: 0 },
  );

  const policyConfigured =
    retention.rawEvidenceMaxAgeDays !== null || retention.historyMaxEntries !== null;

  return Object.freeze({
    reportType: "sync.retention.plan",
    tenantId: store.tenantId,
    productId: store.productId,
    generatedAt,
    mode: retention.mode,
    policyConfigured,
    policy: {
      rawEvidenceMaxAgeDays: retention.rawEvidenceMaxAgeDays,
      historyMaxEntries: retention.historyMaxEntries,
    },
    horizonStartsAt: cutoffMs === undefined ? null : new Date(cutoffMs).toISOString(),
    /** Always false: the durable store exposes no deletion API (see module docs). */
    pruneSupported: false,
    /** Always 0 by construction; this function performs no mutation at all. */
    deletedCount: 0,
    connectors,
    totals,
    limitations: Object.freeze([
      "raw-evidence-store-has-no-deletion-api",
      "raw-evidence-is-immutable-provenance-for-canonical-knowledge",
      "retention-horizon-pending-external-approval",
      "archival-target-is-an-external-deployment-decision",
    ]),
  });
}
