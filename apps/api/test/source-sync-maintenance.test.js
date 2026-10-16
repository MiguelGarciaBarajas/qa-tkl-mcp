import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRawEvidenceRecord, sha256 } from "@tkl/contracts";
import { createSourceSyncRunner } from "../src/source-sync.js";

/**
 * Coverage for the P4 maintenance methods attached to the source-sync runner:
 * bounded Silver rebuild from durable raw evidence and non-mutating
 * cross-tier reconciliation. Neither contacts a source.
 */

function rawRecord(index) {
  return createRawEvidenceRecord({
    tenantId: "solera",
    productId: "fl-titling",
    source: "github",
    sourceId: `owner/repo#${index}`,
    sourceVersion: "v1",
    observedAt: "2026-05-10T00:00:00.000Z",
    contentType: "fixture.item",
    payload: { index },
    classification: "internal",
    idempotencyKey: sha256(`fixture:item-${index}`)
  });
}

async function seed(store, count) {
  for (let index = 0; index < count; index += 1) {
    await store.commit({
      connectorId: "connector.github",
      records: [rawRecord(index)],
      checkpoint: { page: index }
    });
  }
}

test("rebuildSilver replays durable raw evidence through ingest in bounded batches", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-p4-rebuild-"));
  const ingested = [];
  const knowledgeService = {
    async ingest(records) {
      ingested.push(...records.map((r) => r.sourceId));
      return { ingestedRecords: records.length };
    }
  };
  try {
    const runner = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService,
      dataDirectory,
      resolveRawEvidenceKey: () => Buffer.alloc(32, 7)
    });
    const store = await runner.getRawStore("fl-titling");
    await seed(store, 5);

    const first = await runner.rebuildSilver({ productId: "fl-titling", source: "github", limit: 2 });
    assert.equal(first.tier, "silver");
    assert.equal(first.processed, 2);
    assert.equal(first.done, false);

    const rest = await runner.rebuildSilver({
      productId: "fl-titling",
      cursor: first.nextCursor,
      confirm: true
    });
    assert.equal(rest.processed, 3);
    assert.equal(rest.done, true);
    assert.equal(ingested.length, 5);
    assert.equal(new Set(ingested).size, 5);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("rebuildSilver dry-run plans without ingesting", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-p4-rebuild-dry-"));
  let called = false;
  try {
    const runner = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: {
        async ingest() {
          called = true;
        }
      },
      dataDirectory,
      resolveRawEvidenceKey: () => Buffer.alloc(32, 7)
    });
    const store = await runner.getRawStore("fl-titling");
    await seed(store, 3);

    const plan = await runner.rebuildSilver({ productId: "fl-titling", dryRun: true });
    assert.equal(plan.reportType, "evidence.rebuild.silver.plan");
    assert.equal(plan.matched, 3);
    assert.equal(called, false);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("reconcile reports raw findings and folds available knowledge counts", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-p4-reconcile-"));
  try {
    const runner = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: {
        async ingest() {},
        pendingServingProjectionCount: () => 0,
        getStore: () => ({ listEntities: () => [], listClaims: () => [] })
      },
      dataDirectory,
      resolveRawEvidenceKey: () => Buffer.alloc(32, 7)
    });
    const store = await runner.getRawStore("fl-titling");
    await seed(store, 4);

    const report = await runner.reconcile({ productId: "fl-titling", source: "github" });
    assert.equal(report.reportType, "evidence.reconciliation");
    assert.equal(report.bronze.recordCount, 4);
    assert.equal(report.bronze.pendingProjection, 4);
    assert.equal(report.silver.canonicalEntityCount, 0);
    assert.equal(report.gold.servingProjectionBacklog, 0);
    assert.ok(report.findings.some((f) => f.code === "raw.pending-projection-backlog"));
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
