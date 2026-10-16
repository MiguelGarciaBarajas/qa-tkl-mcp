import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import {
  RetentionPolicyError,
  createSyncCoordinator,
  planRetention,
  resolveSyncSettings,
} from "../src/index.js";
import {
  FixtureConnector,
  createFixtureRecord,
  createTestClock,
  fixtureProductConfiguration,
} from "./support/fixtures.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";
const NOW = "2026-06-01T00:00:00.000Z";

async function seedStore() {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  await store.commit({
    connectorId: CONNECTOR_ID,
    records: [
      createFixtureRecord({
        tenantId: TENANT_ID,
        productId: PRODUCT_ID,
        page: 0,
        index: 0,
        observedAt: "2024-01-01T00:00:00.000Z",
      }),
      createFixtureRecord({
        tenantId: TENANT_ID,
        productId: PRODUCT_ID,
        page: 0,
        index: 1,
        observedAt: "2026-05-31T00:00:00.000Z",
      }),
    ],
    checkpoint: { page: 1 },
  });
  return store;
}

test("reports what a retention horizon covers without deleting anything", async () => {
  const store = await seedStore();
  const settings = resolveSyncSettings({ retention: { rawEvidenceMaxAgeDays: 30 } });

  const report = planRetention({
    store,
    settings,
    connectorIds: [CONNECTOR_ID],
    now: () => NOW,
  });

  assert.equal(report.mode, "report-only");
  assert.equal(report.pruneSupported, false);
  assert.equal(report.deletedCount, 0);
  assert.equal(report.policyConfigured, true);
  assert.equal(report.horizonStartsAt, "2026-05-02T00:00:00.000Z");
  assert.equal(report.totals.recordCount, 2);
  assert.equal(report.totals.recordsBeyondHorizon, 1);
  assert.equal(report.connectors[0].recordsWithinHorizon, 1);
  assert.equal(report.connectors[0].oldestObservedAt, "2024-01-01T00:00:00.000Z");
  assert.equal(report.connectors[0].newestObservedAt, "2026-05-31T00:00:00.000Z");
  assert.equal(report.connectors[0].checkpointPresent, true);

  // The evidence, its checkpoint, and the commit history are all untouched:
  // raw evidence is immutable provenance and this seam never mutates.
  assert.equal(store.listRecords().length, 2);
  assert.deepEqual(store.getCheckpoint(CONNECTOR_ID).page, 1);
  assert.equal(store.history(CONNECTOR_ID).length, 1);
});

test("reports zero eligible records when no retention horizon has been approved", async () => {
  const store = await seedStore();
  const report = planRetention({
    store,
    settings: resolveSyncSettings(),
    connectorIds: [CONNECTOR_ID],
    now: () => NOW,
  });

  assert.equal(report.policyConfigured, false);
  assert.equal(report.horizonStartsAt, null);
  assert.equal(report.totals.recordsBeyondHorizon, 0);
  assert.ok(report.limitations.includes("retention-horizon-pending-external-approval"));
});

test("counts history entries beyond a configured limit without truncating the audit trail", async () => {
  const store = await seedStore();
  await store.commit({
    connectorId: CONNECTOR_ID,
    records: [
      createFixtureRecord({ tenantId: TENANT_ID, productId: PRODUCT_ID, page: 1, index: 0 }),
    ],
    checkpoint: { page: 2 },
  });

  const report = planRetention({
    store,
    settings: resolveSyncSettings({ retention: { historyMaxEntries: 1 } }),
    connectorIds: [CONNECTOR_ID],
    now: () => NOW,
  });

  assert.equal(report.connectors[0].historyEntryCount, 2);
  assert.equal(report.connectors[0].historyEntriesBeyondLimit, 1);
  assert.equal(store.history(CONNECTOR_ID).length, 2, "history is never truncated");
});

test("refuses a destructive retention request instead of pretending to prune", async () => {
  const store = await seedStore();
  assert.throws(
    () => planRetention({ store, settings: { retention: { mode: "prune" } } }),
    RetentionPolicyError,
  );
  assert.throws(() => planRetention({ store, settings: {} }), RetentionPolicyError);
  assert.throws(() => planRetention({ settings: resolveSyncSettings() }), RetentionPolicyError);
});

test("exposes the retention report through the coordinator, sanitized", async () => {
  const store = await seedStore();
  const coordinator = createSyncCoordinator({
    configuration: fixtureProductConfiguration(),
    store,
    connectors: [
      {
        pluginId: CONNECTOR_ID,
        instance: new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages: [] }),
      },
    ],
    sync: { retention: { rawEvidenceMaxAgeDays: 365 } },
    now: () => NOW,
  });

  const report = coordinator.planRetention();
  assert.equal(report.reportType, "sync.retention.plan");
  assert.equal(report.tenantId, TENANT_ID);
  assert.equal(report.deletedCount, 0);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("secret://"), false);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(coordinator.describe().retention.pruneSupported, false);
});
