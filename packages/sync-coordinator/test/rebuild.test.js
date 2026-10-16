import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import {
  MaintenanceConfirmationRequiredError,
  MaintenanceLockError,
  acquireRunLock,
  planSilverRebuild,
  rebuildGoldProjections,
  rebuildSilverFromRawEvidence,
} from "../src/index.js";
import { createFixtureRecord, createTestClock } from "./support/fixtures.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";
const NOW = "2026-06-01T00:00:00.000Z";

async function seedStore(recordCount = 5) {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  await store.commit({
    connectorId: CONNECTOR_ID,
    records: Array.from({ length: recordCount }, (_unused, index) =>
      createFixtureRecord({ tenantId: TENANT_ID, productId: PRODUCT_ID, page: 0, index }),
    ),
    checkpoint: { page: 1 },
  });
  return store;
}

test("Silver rebuild refuses to process the full set without a limit or confirm", async () => {
  const store = await seedStore(5);
  await assert.rejects(
    () => rebuildSilverFromRawEvidence({ rawStore: store, projectRecords: async () => {} }),
    MaintenanceConfirmationRequiredError,
  );
});

test("Silver rebuild replays raw evidence in bounded batches with a resumable cursor", async () => {
  const store = await seedStore(5);
  const projected = [];
  const projectRecords = async (records) => {
    projected.push(...records.map((r) => r.idempotencyKey));
  };

  const first = await rebuildSilverFromRawEvidence({
    rawStore: store,
    projectRecords,
    limit: 2,
    batchSize: 1,
    now: () => NOW,
  });
  assert.equal(first.tier, "silver");
  assert.equal(first.processed, 2);
  assert.equal(first.batches, 2);
  assert.equal(first.nextCursor, 2);
  assert.equal(first.done, false);
  assert.equal(first.remaining, 3);

  const second = await rebuildSilverFromRawEvidence({
    rawStore: store,
    projectRecords,
    cursor: first.nextCursor,
    confirm: true,
    now: () => NOW,
  });
  assert.equal(second.processed, 3);
  assert.equal(second.done, true);
  assert.equal(second.remaining, 0);

  // Every record was replayed exactly once across the two bounded runs.
  assert.equal(projected.length, 5);
  assert.equal(new Set(projected).size, 5);
});

test("Silver rebuild is idempotent when re-run from the start (projector upserts)", async () => {
  const store = await seedStore(3);
  const seen = new Map();
  const projectRecords = async (records) => {
    for (const r of records) seen.set(r.idempotencyKey, (seen.get(r.idempotencyKey) ?? 0) + 1);
  };
  await rebuildSilverFromRawEvidence({ rawStore: store, projectRecords, confirm: true });
  await rebuildSilverFromRawEvidence({ rawStore: store, projectRecords, confirm: true });
  // The same 3 records are replayed each run; correctness relies on the
  // projector being an idempotent upsert, which this asserts is invoked
  // with identical, stable identities.
  assert.equal(seen.size, 3);
  for (const count of seen.values()) assert.equal(count, 2);
});

test("Silver rebuild dry-run plans without projecting", async () => {
  const store = await seedStore(4);
  let called = false;
  const plan = await rebuildSilverFromRawEvidence({
    rawStore: store,
    projectRecords: async () => {
      called = true;
    },
    dryRun: true,
    limit: 2,
  });
  assert.equal(plan.reportType, "evidence.rebuild.silver.plan");
  assert.equal(plan.wouldProcess, 2);
  assert.equal(plan.matched, 4);
  assert.equal(called, false);

  const bare = planSilverRebuild({ rawStore: store });
  assert.equal(bare.wouldProcess, 4);
  assert.equal(bare.done, true);
});

test("Silver rebuild refuses to overlap an in-process run lock", async () => {
  const store = await seedStore(3);
  const held = acquireRunLock(
    { tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: "maintenance.rebuild" },
    { runId: "held", startedAt: NOW },
  );
  try {
    await assert.rejects(
      () =>
        rebuildSilverFromRawEvidence({
          rawStore: store,
          projectRecords: async () => {},
          confirm: true,
        }),
      MaintenanceLockError,
    );
  } finally {
    held.release();
  }

  // After release the rebuild can take the lock.
  const ok = await rebuildSilverFromRawEvidence({
    rawStore: store,
    projectRecords: async () => {},
    confirm: true,
  });
  assert.equal(ok.done, true);
});

test("Silver rebuild loads only bounded pages and never calls full listRecords", async () => {
  const store = await seedStore(5);
  const pageLimits = [];
  const bounded = {
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    countRecords: (filter) => store.countRecords(filter),
    pageRecords: (request) => {
      pageLimits.push(request.limit);
      return store.pageRecords(request);
    },
    listRecords() {
      throw new Error("rebuild must not call full listRecords");
    },
  };

  const projected = [];
  const first = await rebuildSilverFromRawEvidence({
    rawStore: bounded,
    projectRecords: async (records) => projected.push(...records.map((r) => r.idempotencyKey)),
    limit: 2,
    batchSize: 1,
    now: () => NOW,
  });
  assert.equal(first.matched, 5);
  assert.equal(first.processed, 2);
  assert.equal(first.done, false);
  // Every page request was bounded to the batch size; the full corpus was
  // never requested in one call.
  assert.ok(pageLimits.length >= 1);
  assert.ok(pageLimits.every((limit) => limit <= 1));

  // A dry-run plan also relies only on the bounded count primitive.
  const plan = planSilverRebuild({ rawStore: bounded, limit: 100 });
  assert.equal(plan.matched, 5);
  assert.equal(plan.wouldProcess, 5);
});

test("Gold rebuild drives the knowledge store's bounded rebuild to completion", async () => {
  // A fake knowledge store whose serving rebuild advances a cursor over N rows.
  const total = 5;
  let pending = total;
  const knowledgeStore = {
    rebuildServingProjections({ batchSize, cursor }) {
      const processed = Math.min(batchSize, total - cursor);
      const nextCursor = cursor + processed;
      pending = Math.max(0, pending - processed);
      return {
        processed,
        ...(nextCursor >= total ? {} : { nextCursor }),
        done: nextCursor >= total,
        remaining: pending,
        version: 1,
      };
    },
    pendingServingProjectionCount() {
      return pending;
    },
  };

  const result = await rebuildGoldProjections({
    knowledgeStore,
    batchSize: 2,
    now: () => NOW,
  });
  assert.equal(result.reportType, "evidence.rebuild.gold");
  assert.equal(result.processed, 5);
  assert.equal(result.done, true);
  assert.equal(result.remaining, 0);
  assert.equal(result.batches, 3);

  const plan = await rebuildGoldProjections({ knowledgeStore, dryRun: true });
  assert.equal(plan.reportType, "evidence.rebuild.gold.plan");
});

test("Gold rebuild stops at maxBatches without looping forever", async () => {
  const knowledgeStore = {
    rebuildServingProjections({ cursor }) {
      // Never reports done; always advances by 1.
      return { processed: 1, nextCursor: cursor + 1, done: false, remaining: 100, version: 1 };
    },
    pendingServingProjectionCount() {
      return 100;
    },
  };
  const result = await rebuildGoldProjections({ knowledgeStore, batchSize: 1, maxBatches: 4 });
  assert.equal(result.batches, 4);
  assert.equal(result.done, false);
  assert.equal(result.processed, 4);
});
