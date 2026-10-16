import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import {
  MaintenanceConfirmationRequiredError,
  SyncConfigurationError,
  createSyncCoordinator,
} from "../src/index.js";
import {
  FixtureConnector,
  createFixtureRecord,
  createTestClock,
  fixturePages,
  fixtureProductConfiguration,
} from "./support/fixtures.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";

function buildCoordinator(store, auditEvents = []) {
  return createSyncCoordinator({
    configuration: fixtureProductConfiguration(),
    store,
    connectors: [
      {
        pluginId: CONNECTOR_ID,
        instance: new FixtureConnector({
          tenantId: TENANT_ID,
          productId: PRODUCT_ID,
          pages: fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID }),
        }),
      },
    ],
    now: createTestClock(),
    auditLogger: {
      record(event) {
        auditEvents.push(event);
      },
    },
  });
}

async function seededStore(count = 3) {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  await store.commit({
    connectorId: CONNECTOR_ID,
    records: Array.from({ length: count }, (_unused, index) =>
      createFixtureRecord({ tenantId: TENANT_ID, productId: PRODUCT_ID, page: 0, index }),
    ),
    checkpoint: { page: 1 },
  });
  return store;
}

test("coordinator.reconcile emits a sanitized, audited report", async () => {
  const store = await seededStore(3);
  const auditEvents = [];
  const coordinator = buildCoordinator(store, auditEvents);

  const report = coordinator.reconcile();
  assert.equal(report.reportType, "evidence.reconciliation");
  assert.equal(report.bronze.recordCount, 3);
  assert.ok(report.findings.some((f) => f.code === "raw.pending-projection-backlog"));
  assert.ok(auditEvents.some((event) => event.eventType === "sync.evidence.reconciled"));
});

test("coordinator.compact fails closed for a store without compaction support", async () => {
  const store = await seededStore(2);
  const coordinator = buildCoordinator(store);
  await assert.rejects(() => coordinator.compact(), SyncConfigurationError);
});

test("coordinator.rebuildSilver replays raw evidence through the projector", async () => {
  const store = await seededStore(4);
  const coordinator = buildCoordinator(store);
  const projected = [];

  const plan = coordinator.planSilverRebuild({ limit: 2 });
  assert.equal(plan.wouldProcess, 2);
  assert.equal(plan.matched, 4);

  const result = await coordinator.rebuildSilver({
    projectRecords: async (records) => projected.push(...records.map((r) => r.idempotencyKey)),
    confirm: true,
    batchSize: 2,
  });
  assert.equal(result.tier, "silver");
  assert.equal(result.processed, 4);
  assert.equal(result.done, true);
  assert.equal(projected.length, 4);
});

test("coordinator.rebuildSilver refuses the full set without a limit or confirm", async () => {
  const store = await seededStore(3);
  const coordinator = buildCoordinator(store);
  await assert.rejects(
    () => coordinator.rebuildSilver({ projectRecords: async () => {} }),
    MaintenanceConfirmationRequiredError,
  );
});
