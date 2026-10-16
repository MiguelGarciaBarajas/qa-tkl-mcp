import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import {
  MaintenanceConfirmationRequiredError,
  RetentionPolicyError,
  applyReconciliationRepairs,
  rawEvidenceChecksum,
  reconcileEvidence,
  selectRawRecords,
} from "../src/index.js";
import { createFixtureRecord, createTestClock } from "./support/fixtures.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";
const NOW = "2026-06-01T00:00:00.000Z";

async function seedStore({ recordCount = 3, projectionFailureThreshold = 3 } = {}) {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
    projectionFailureThreshold,
  });
  await store.commit({
    connectorId: CONNECTOR_ID,
    records: Array.from({ length: recordCount }, (_unused, index) =>
      createFixtureRecord({
        tenantId: TENANT_ID,
        productId: PRODUCT_ID,
        page: 0,
        index,
        observedAt: `2026-05-1${index}T00:00:00.000Z`,
      }),
    ),
    checkpoint: { page: 1 },
  });
  return store;
}

test("reconciliation reports raw counts and a stable evidence checksum without mutating", async () => {
  const store = await seedStore({ recordCount: 3 });
  const report = reconcileEvidence({ rawStore: store, now: () => NOW });

  assert.equal(report.reportType, "evidence.reconciliation");
  assert.equal(report.tenantId, TENANT_ID);
  assert.equal(report.bronze.recordCount, 3);
  assert.equal(report.bronze.pendingProjection, 3);
  assert.equal(report.bronze.deadLettered, 0);
  assert.equal(report.bronze.historyCommittedCount, 3);
  assert.match(report.bronze.evidenceChecksum, /^[0-9a-f]{64}$/);
  assert.equal(report.silver, null);
  assert.equal(report.gold, null);

  // A pending-projection backlog is surfaced as an actionable finding.
  const pendingFinding = report.findings.find((f) => f.code === "raw.pending-projection-backlog");
  assert.ok(pendingFinding);
  assert.equal(pendingFinding.remediation, "drain-projections");

  // No mutation happened.
  assert.equal(store.countPendingProjectionRecords(), 3);

  // The checksum is deterministic for the same evidence set.
  const again = reconcileEvidence({ rawStore: store, now: () => NOW });
  assert.equal(again.bronze.evidenceChecksum, report.bronze.evidenceChecksum);
});

test("reconciliation flags dead-letter records at error severity", async () => {
  const store = await seedStore({ recordCount: 3, projectionFailureThreshold: 2 });
  const poison = store.listPendingProjectionRecords()[0].idempotencyKey;
  await store.recordProjectionFailures([poison]);
  await store.recordProjectionFailures([poison]);
  assert.equal(store.countDeadLetterProjectionRecords(), 1);

  const report = reconcileEvidence({ rawStore: store, now: () => NOW });
  assert.equal(report.bronze.deadLettered, 1);
  assert.equal(report.highestSeverity, "error");
  const finding = report.findings.find((f) => f.code === "raw.projection-dead-letter");
  assert.ok(finding);
  assert.equal(finding.severity, "error");
});

test("reconciliation folds Silver/Gold counts and flags cross-tier drift", async () => {
  const store = await seedStore({ recordCount: 3 });
  const report = reconcileEvidence({
    rawStore: store,
    knowledge: {
      canonicalEntityCount: 3,
      canonicalClaimCount: 5,
      deferredTraceLinkCount: 1,
      servingProjectionBacklog: 2,
      sourceCounts: { github: 4 },
    },
    now: () => NOW,
  });

  assert.equal(report.silver.canonicalEntityCount, 3);
  assert.equal(report.gold.servingProjectionBacklog, 2);
  assert.ok(report.findings.some((f) => f.code === "silver.deferred-trace-links"));
  assert.ok(report.findings.some((f) => f.code === "gold.serving-projection-backlog"));
  // Canonical (4 github) exceeds raw github count (3) -> provenance drift.
  const drift = report.findings.find((f) => f.code === "silver.canonical-exceeds-raw");
  assert.ok(drift);
  assert.equal(drift.severity, "error");
});

test("selectRawRecords honors source, version, and observed-range filters", async () => {
  const store = await seedStore({ recordCount: 3 });
  const all = selectRawRecords(store, {});
  assert.equal(all.length, 3);

  const ranged = selectRawRecords(store, {
    observedFrom: "2026-05-11T00:00:00.000Z",
    observedTo: "2026-05-12T00:00:00.000Z",
  });
  assert.equal(ranged.length, 2);

  const versioned = selectRawRecords(store, { sourceVersion: "v1" });
  assert.equal(versioned.length, 3);
  const noMatch = selectRawRecords(store, { source: "jira" });
  assert.equal(noMatch.length, 0);

  // Checksum changes when the matched set changes.
  assert.notEqual(rawEvidenceChecksum(all), rawEvidenceChecksum(ranged));
});

test("reconciliation repair requires confirmation and is bounded", async () => {
  const store = await seedStore({ recordCount: 3, projectionFailureThreshold: 1 });
  const keys = store.listPendingProjectionRecords().map((r) => r.idempotencyKey);
  await store.recordProjectionFailures(keys); // threshold 1 -> all dead-lettered
  assert.equal(store.countDeadLetterProjectionRecords(), 3);

  // Without confirm, it fails closed and mutates nothing.
  await assert.rejects(
    () => applyReconciliationRepairs({ rawStore: store, actions: { requeueDeadLetter: true } }),
    MaintenanceConfirmationRequiredError,
  );
  assert.equal(store.countDeadLetterProjectionRecords(), 3);

  // Bounded by limit.
  const result = await applyReconciliationRepairs({
    rawStore: store,
    actions: { requeueDeadLetter: true },
    confirm: true,
    limit: 2,
    now: () => NOW,
  });
  assert.equal(result.requeued, 2);
  assert.equal(store.countDeadLetterProjectionRecords(), 1);

  await assert.rejects(
    () => applyReconciliationRepairs({ rawStore: store, actions: {}, confirm: true }),
    RetentionPolicyError,
  );
});

/**
 * Wraps a real store but makes any call to the full-corpus `listRecords`
 * throw, and counts bounded `pageRecords`/`countRecords` usage. Proves the
 * reconciler reads only bounded pages.
 */
function boundedOnlyStore(store) {
  const calls = { pageRecords: 0, countRecords: 0 };
  return {
    tenantId: store.tenantId,
    productId: store.productId,
    history: (connectorId) => store.history(connectorId),
    countPendingProjectionRecords: () => store.countPendingProjectionRecords(),
    countDeadLetterProjectionRecords: () => store.countDeadLetterProjectionRecords(),
    listDeadLetterProjectionRecords: (limit) => store.listDeadLetterProjectionRecords(limit),
    requeueDeadLetterProjectionRecords: (k) => store.requeueDeadLetterProjectionRecords(k),
    countRecords: (filter) => {
      calls.countRecords += 1;
      return store.countRecords(filter);
    },
    pageRecords: (request) => {
      calls.pageRecords += 1;
      return store.pageRecords(request);
    },
    listRecords() {
      throw new Error("reconciliation must not call full listRecords");
    },
    calls,
  };
}

test("reconciliation reads bounded pages and never calls full listRecords", async () => {
  const store = await seedStore({ recordCount: 5 });
  const bounded = boundedOnlyStore(store);

  const report = reconcileEvidence({ rawStore: bounded, now: () => NOW });
  assert.equal(report.bronze.recordCount, 5);
  assert.equal(report.bronze.evidenceChecksumComplete, true);
  assert.ok(bounded.calls.pageRecords >= 1);
  assert.ok(bounded.calls.countRecords >= 1);

  // The bounded scan yields the same checksum as the array helper over the
  // full set, so the streaming digest is faithful.
  const all = selectRawRecords(store, {});
  assert.equal(report.bronze.evidenceChecksum, rawEvidenceChecksum(all));
});

test("reconciliation scan is bounded and reports truncation with a resumable cursor", async () => {
  const store = await seedStore({ recordCount: 5 });
  const report = reconcileEvidence({ rawStore: store, scan: { maxRecords: 2, pageSize: 1 }, now: () => NOW });

  assert.equal(report.bronze.recordCount, 5); // exact, not bounded
  assert.equal(report.bronze.evidenceChecksumComplete, false);
  assert.equal(report.bronze.recordsBySourceComplete, false);
  assert.equal(report.bronze.evidenceScan.scanned, 2);
  assert.equal(report.bronze.evidenceScan.complete, false);
  assert.equal(report.bronze.evidenceScan.nextCursor, 2);
  const truncated = report.findings.find((f) => f.code === "raw.reconciliation-truncated");
  assert.ok(truncated);
  assert.equal(truncated.nextCursor, 2);
  assert.equal(truncated.recordCount, 5);
});
