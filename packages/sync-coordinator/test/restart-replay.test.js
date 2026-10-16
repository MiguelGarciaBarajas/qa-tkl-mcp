import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPersistentRawEvidenceStore } from "@tkl/raw-evidence-store";
import { createSyncCoordinator } from "../src/index.js";
import { FixtureConnector, createTestClock, fixturePages, fixtureProductConfiguration } from "./support/fixtures.js";

/**
 * OPS-101's required verification artifact: the restart/replay operational
 * test, run against the **durable, encrypted** `PersistentRawEvidenceStore`
 * rather than an in-memory double.
 *
 * "Restart" is simulated the only way that actually proves recovery: the
 * process-level state (store instance, coordinator, connector instance) is
 * discarded entirely between phases and rebuilt from the data directory, so
 * every resume decision must come from the durable, encrypted snapshot on
 * disk. No timers, no sleeps, no live services: pagination and the mid-sync
 * failure are fixtures, and the clock is injected.
 *
 * Scratch data is written to a repository-local, git-ignored `.tmp`
 * directory and removed afterwards.
 */

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";
const KEY_REF = "env://TKL_TEST_RAW_EVIDENCE_KEY";
// Deterministic, test-only AES-256 key material. Not a credential: it never
// protects real evidence and exists only so the durable store can be
// exercised end to end.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const scratchRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
mkdirSync(scratchRoot, { recursive: true });
const dataDirectory = mkdtempSync(join(scratchRoot, "ops-101-"));

test.after(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

async function openDurableStore() {
  return createPersistentRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    dataDirectory,
    keyRef: KEY_REF,
    resolveKey: () => TEST_KEY,
    now: createTestClock(),
  });
}

function buildCoordinator({ store, connector }) {
  return createSyncCoordinator({
    configuration: fixtureProductConfiguration(),
    store,
    connectors: [{ pluginId: CONNECTOR_ID, instance: connector }],
    sync: { batchSize: 2 },
    now: createTestClock(),
    newRunId: () => "restart-replay-run",
  });
}

test("restart/replay operational test: durable recovery, idempotent replay, and no silent checkpoint reset", async (t) => {
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID, pageCount: 3, itemsPerPage: 2 });

  await t.test("phase 1: a mid-sync source failure leaves a durable, conservative checkpoint", async () => {
    const store = await openDurableStore();
    const connector = new FixtureConnector({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      pages,
      failAtPage: 2,
    });
    const summary = await buildCoordinator({ store, connector }).runOnce();

    assert.equal(summary.status, "failed");
    assert.equal(summary.connectors[0].error.stage, "collect");
    assert.equal(summary.totals.committedCount, 4);
    assert.equal(store.listRecords().length, 4);
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 1);
  });

  await t.test("phase 2: a restarted process resumes from the durable checkpoint and completes", async () => {
    // Brand-new store instance: everything below is reloaded from the
    // encrypted snapshot written in phase 1.
    const store = await openDurableStore();
    assert.equal(store.listRecords().length, 4, "durable evidence survived the restart");
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 1, "durable checkpoint survived the restart");

    const connector = new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages });
    const summary = await buildCoordinator({ store, connector }).runOnce();

    assert.equal(connector.resumedFrom[0].page, 1, "the connector resumed from the durable cursor");
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.connectors[0].resumedFromCheckpoint, true);
    assert.equal(summary.totals.duplicateCount, 2, "the replayed page is deduplicated, not double-stored");
    assert.equal(summary.totals.committedCount, 2, "only genuinely new evidence is committed");
    assert.equal(store.listRecords().length, 6);
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
  });

  await t.test("phase 3: a second restart with no new source data is a clean no-op", async () => {
    const store = await openDurableStore();
    const connector = new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages });
    const summary = await buildCoordinator({ store, connector }).runOnce();

    assert.equal(summary.status, "succeeded");
    assert.equal(summary.totals.committedCount, 0);
    assert.equal(store.listRecords().length, 6);
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
  });

  await t.test("phase 4: an unconfirmed replay is refused and changes nothing", async () => {
    const store = await openDurableStore();
    const connector = new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages });
    const coordinator = buildCoordinator({ store, connector });
    const historyBefore = store.history().length;

    await assert.rejects(() => coordinator.runOnce({ mode: "replay-full" }), {
      name: "ReplayConfirmationRequiredError",
    });

    assert.deepEqual(connector.resumedFrom, [], "no collection was attempted");
    assert.equal(store.history().length, historyBefore);
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
  });

  await t.test("phase 5: a dry-run replay plan is safe and commits nothing", async () => {
    const store = await openDurableStore();
    const connector = new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages });
    const plan = buildCoordinator({ store, connector }).plan({ mode: "replay-full" });

    assert.equal(plan.status, "planned");
    assert.equal(plan.connectors[0].storedCheckpointPresent, true);
    assert.equal(plan.connectors[0].wouldStartFromBeginning, true);
    assert.equal(plan.connectors[0].wouldAdvanceCheckpoint, false);
    assert.equal(plan.connectors[0].wouldClearCheckpoint, false);
    assert.deepEqual(connector.resumedFrom, []);
    assert.equal(store.listRecords().length, 6);
  });

  await t.test("phase 6: a confirmed full replay is idempotent and preserves the durable checkpoint", async () => {
    const store = await openDurableStore();
    const checkpointBefore = store.getCheckpoint(CONNECTOR_ID);
    const connector = new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages });
    const summary = await buildCoordinator({ store, connector }).runOnce({
      mode: "replay-full",
      confirmReplay: true,
      maxRecordsPerConnector: 100,
    });

    assert.deepEqual(connector.resumedFrom, [{}], "a full replay restarts at the source beginning");
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.totals.recordCount, 6);
    assert.equal(summary.totals.duplicateCount, 6);
    assert.equal(summary.totals.committedCount, 0);
    assert.equal(store.listRecords().length, 6, "replay never duplicates durable evidence");
    assert.deepEqual(store.getCheckpoint(CONNECTOR_ID), checkpointBefore, "replay never rewinds the cursor");
  });

  await t.test("phase 7: the durable checkpoint and evidence survive one more restart unchanged", async () => {
    const store = await openDurableStore();
    assert.equal(store.listRecords().length, 6);
    assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
    assert.ok(store.history(CONNECTOR_ID).length > 0, "the commit audit trail is intact");
  });
});
