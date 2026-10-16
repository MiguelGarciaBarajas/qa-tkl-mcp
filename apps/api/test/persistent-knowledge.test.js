import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { SqliteKnowledgeStore } from "@tkl/knowledge-store";
import {
  createKnowledgeService,
  createPersistentKnowledgeStoreFactory
} from "../src/knowledge-service.js";

const concurrencyWorkerSource = `
  import { parentPort, workerData } from "node:worker_threads";
  const {
    createKnowledgeService,
    createPersistentKnowledgeStoreFactory
  } = await import(workerData.moduleUrl);
  const service = createKnowledgeService({
    tenantId: "solera",
    createStoreOnRead: true,
    storeFactory: createPersistentKnowledgeStoreFactory({
      dataDirectory: workerData.dataDirectory,
      busyTimeoutMs: 15000
    })
  });
  parentPort.on("message", async ({ id, command, records }) => {
    try {
      if (command === "ingest") {
        parentPort.postMessage({ id, started: true });
        await service.ingest(records);
      } else if (command === "close") {
        service.close();
      }
      parentPort.postMessage({ id });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.stack ?? error) });
    }
  });
  parentPort.postMessage({ ready: true });
`;

async function startConcurrencyWorker(dataDirectory) {
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(concurrencyWorkerSource)}`),
    {
      workerData: {
        dataDirectory,
        moduleUrl: new URL("../src/knowledge-service.js", import.meta.url).href
      }
    }
  );
  await new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (!message.ready) return;
      worker.off("error", reject);
      worker.off("message", onMessage);
      resolve();
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  });
  return worker;
}

let workerRequestId = 0;

function requestWorker(worker, command, records) {
  const id = ++workerRequestId;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const completed = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.id !== id) return;
      if (message.started) {
        markStarted();
        return;
      }
      worker.off("error", onError);
      worker.off("message", onMessage);
      if (message.error) reject(new Error(message.error));
      else resolve();
    };
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.postMessage({ id, command, records });
  });
  completed.started = started;
  return completed;
}

function githubRecord(number, ticketKey) {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    source: "github",
    sourceId: String(number),
    sourceVersion: "1",
    observedAt: "2026-09-12T00:00:00.000Z",
    contentType: "github.pull-request",
    contentHash: `concurrent-github-${number}`,
    classification: "internal",
    payload: {
      number,
      title: `Concurrent trace link ${number}`,
      ticketKey
    }
  };
}

function jiraRecord(ticketKey) {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: ticketKey,
    sourceVersion: "1",
    observedAt: "2026-09-12T00:01:00.000Z",
    contentType: "jira.issue",
    contentHash: `concurrent-jira-${ticketKey}`,
    classification: "internal",
    payload: {
      key: ticketKey,
      summary: `Resolve ${ticketKey}`,
      acceptanceCriteria: []
    }
  };
}

test("canonical knowledge remains queryable after the service restarts", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-knowledge-"));
  const storeFactory = createPersistentKnowledgeStoreFactory({ dataDirectory });
  let writer;
  let restarted;
  try {
    writer = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });

    await writer.ingest([{
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "STT-9001",
      sourceVersion: "1",
      observedAt: "2026-09-12T00:00:00.000Z",
      contentType: "jira.issue",
      contentHash: "persistent-jira-fixture",
      classification: "internal",
      payload: {
        key: "STT-9001",
        summary: "Persist canonical knowledge",
        acceptanceCriteria: ["Knowledge survives an API restart"]
      }
    }]);
    const immediate = await writer.search({
      productId: "fl-titling",
      source: "jira",
      query: "Knowledge survives",
      limit: 20,
      offset: 0
    });
    assert.deepEqual(immediate.items.map((entity) => entity.id), [
      "requirement:STT-9001"
    ]);

    restarted = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const result = await restarted.search({
      productId: "fl-titling",
      source: "jira",
      query: "Knowledge survives",
      limit: 20,
      offset: 0
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Persist canonical knowledge");
  } finally {
    writer?.close();
    restarted?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("legacy migration is searchable via canonical fallback without draining serving projections", async () => {
  const dataDirectory = await mkdtemp(join(process.cwd(), ".tkl-legacy-search-"));
  const legacyDirectory = join(dataDirectory, "solera", "fl-titling");
  let service;
  try {
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      join(legacyDirectory, "knowledge-store.json"),
      JSON.stringify({
        schemaVersion: 3,
        revision: 1,
        tenantId: "solera",
        productId: "fl-titling",
        entities: [{
          id: "requirement:STT-9100",
          tenantId: "solera",
          productId: "fl-titling",
          type: "requirement",
          title: "Migrated searchable requirement",
          provenance: {
            source: "jira",
            sourceId: "STT-9100",
            sourceVersion: "1",
            contentHash: "legacy-search",
            observedAt: "2026-09-12T00:00:00.000Z",
            normalizerId: "jira-normalizer",
            normalizerVersion: "0.2.0"
          }
        }],
        claims: [],
        traceLinks: [],
        deferredTraceLinks: [],
        conflicts: [],
        reviews: [],
        history: []
      }),
      "utf-8"
    );
    service = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory: createPersistentKnowledgeStoreFactory({ dataDirectory })
    });

    const result = await service.search({
      productId: "fl-titling",
      source: "jira",
      query: "STT-9100",
      limit: 10,
      offset: 0
    });
    assert.deepEqual(result.items.map((entity) => entity.id), [
      "requirement:STT-9100"
    ]);
    // The read returns the migrated entity via the canonical fallback without
    // draining the serving-projection backlog created by the migration.
    assert.ok(
      service.pendingServingProjectionCount({ productId: "fl-titling" }) > 0
    );
  } finally {
    service?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("service surfaces projection failure and restart retries durable work", async () => {
  const dataDirectory = await mkdtemp(join(process.cwd(), ".tkl-projection-retry-"));
  class FailingProjectionStore extends SqliteKnowledgeStore {
    failNextProjection = true;

    projectServingEntity(entity) {
      if (this.failNextProjection) {
        this.failNextProjection = false;
        throw new Error("injected service projection failure");
      }
      super.projectServingEntity(entity);
    }
  }
  let writer;
  let restarted;
  try {
    writer = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory: ({ tenantId, productId }) => new FailingProjectionStore({
        dataDirectory,
        tenantId,
        productId
      })
    });
    await assert.rejects(
      writer.ingest([jiraRecord("STT-9200")]),
      /injected service projection failure/
    );
    assert.equal(
      writer.pendingServingProjectionCount({ productId: "fl-titling" }),
      1
    );
    writer.close();
    writer = undefined;

    restarted = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory: createPersistentKnowledgeStoreFactory({ dataDirectory })
    });
    const result = await restarted.search({
      productId: "fl-titling",
      source: "jira",
      query: "STT-9200",
      limit: 10,
      offset: 0
    });
    assert.deepEqual(result.items.map((entity) => entity.id), [
      "requirement:STT-9200"
    ]);
    // The read returns canonical data via the fallback but performs no Gold
    // maintenance, so the durable projection failure is still pending.
    assert.equal(
      restarted.pendingServingProjectionCount({ productId: "fl-titling" }),
      1
    );
    // Explicit maintenance retries the durable work and clears the backlog.
    restarted.drainServingProjections({ productId: "fl-titling", limit: 100 });
    assert.equal(
      restarted.pendingServingProjectionCount({ productId: "fl-titling" }),
      0
    );
  } finally {
    writer?.close();
    restarted?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("reads never drain serving projections and fall back to canonical data when a backlog exists", async () => {
  let drainCalls = 0;
  const entity = {
    id: "requirement:STT-9300",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "Canonical backlog result",
    status: "active",
    provenance: {
      source: "jira",
      sourceId: "STT-9300",
      sourceVersion: "1",
      contentHash: "backlog",
      observedAt: "2026-09-12T00:00:00.000Z",
      normalizerId: "jira-normalizer",
      normalizerVersion: "0.2.0"
    }
  };
  const service = createKnowledgeService({
    tenantId: "solera",
    createStoreOnRead: true,
    storeFactory: () => ({
      // A large durable backlog is pending, but a read must not drain any of
      // it. SqliteKnowledgeStore.searchEntities returns canonical results while
      // projections are pending; this stub models that contract.
      pendingServingProjectionCount: () => 1000,
      drainServingProjections: () => {
        drainCalls += 1;
        return { attempted: 1, projected: 1, remaining: 999, version: 1 };
      },
      searchEntities: () => [entity],
      listEntities: () => [entity],
      close() {}
    })
  });
  try {
    const result = await service.search({
      productId: "fl-titling",
      source: "jira",
      query: "backlog",
      limit: 10,
      offset: 0
    });
    assert.deepEqual(result.items.map((item) => item.id), [entity.id]);
    assert.equal(drainCalls, 0);
  } finally {
    service.close();
  }
});

test("ingestion advances only a small bounded slice of the serving-projection backlog", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-ingest-bounded-drain-"));
  const drainCalls = [];
  class SpyStore extends SqliteKnowledgeStore {
    drainServingProjections(options) {
      drainCalls.push(options);
      return super.drainServingProjections(options);
    }
  }
  let service;
  try {
    service = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory: ({ tenantId, productId }) =>
        new SpyStore({ dataDirectory, tenantId, productId })
    });
    const records = Array.from({ length: 60 }, (_, index) =>
      jiraRecord(`STT-BD-${index}`));
    const result = await service.ingest(records);
    assert.equal(result.ingestedRecords, 60);

    // A single ingest performs at most one bounded serving-projection batch,
    // capped at INGESTION_GOLD_DRAIN_LIMIT (25), rather than draining up to a
    // thousand documents synchronously before returning.
    assert.equal(drainCalls.length, 1);
    assert.equal(drainCalls[0].limit, 25);

    // The remaining durable backlog is left for maintenance/background work.
    const remaining = service.pendingServingProjectionCount({ productId: "fl-titling" });
    assert.ok(remaining > 0, "expected a durable backlog to remain after a bounded drain");
    assert.ok(remaining >= 60 - 25, "no more than one bounded batch should be drained");

    // The read still returns canonical results while the backlog is pending.
    const search = await service.search({
      productId: "fl-titling",
      source: "jira",
      query: "STT-BD-0",
      limit: 10,
      offset: 0
    });
    assert.ok(search.items.some((item) => item.id === "requirement:STT-BD-0"));
    // The read did not add any further drain work.
    assert.equal(drainCalls.length, 1);
  } finally {
    service?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});


test("deferred cross-source links survive restart and resolve after late evidence arrives", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-deferred-links-"));
  const storeFactory = createPersistentKnowledgeStoreFactory({ dataDirectory });
  let writer;
  let restarted;
  try {
    writer = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const deferred = await writer.ingest([{
      tenantId: "solera",
      productId: "fl-titling",
      source: "github",
      sourceId: "77",
      sourceVersion: "1",
      observedAt: "2026-09-12T00:00:00.000Z",
      contentType: "github.pull-request",
      contentHash: "persistent-deferred-github",
      classification: "internal",
      payload: {
        number: 77,
        title: "Automate deferred requirement",
        ticketKey: "STT-7777"
      }
    }]);
    assert.equal(deferred.unresolvedLinks.length, 1);

    restarted = createKnowledgeService({
      tenantId: "solera",
      createStoreOnRead: true,
      storeFactory
    });
    const resolved = await restarted.ingest([{
      tenantId: "solera",
      productId: "fl-titling",
      source: "jira",
      sourceId: "STT-7777",
      sourceVersion: "1",
      observedAt: "2026-09-12T00:01:00.000Z",
      contentType: "jira.issue",
      contentHash: "persistent-deferred-jira",
      classification: "internal",
      payload: {
        key: "STT-7777",
        summary: "Deferred requirement",
        acceptanceCriteria: []
      }
    }]);
    assert.deepEqual(resolved.unresolvedLinks, []);

    const traceability = await restarted.explainTraceability({
      productId: "fl-titling",
      requirementId: "STT-7777"
    });
    assert.deepEqual(traceability.relationships.map((link) => link.id), [
      "link:77:STT-7777:0"
    ]);
  } finally {
    writer?.close();
    restarted?.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("two service instances do not lose or resurrect deferred links when writes interleave", async () => {
  const dataDirectory = await mkdtemp(join(process.cwd(), ".tkl-link-race-"));
  let first;
  let second;
  let gate;
  let gateTransactionOpen = false;
  try {
    [first, second] = await Promise.all([
      startConcurrencyWorker(dataDirectory),
      startConcurrencyWorker(dataDirectory)
    ]);
    const rounds = 12;
    const pendingPerRound = 24;
    for (let round = 0; round < rounds; round += 1) {
      const sharedTicket = `STA-${7000 + round}`;
      await requestWorker(
        first,
        "ingest",
        [githubRecord(7000 + round, sharedTicket)]
      );
      const pendingBatch = Array.from({ length: pendingPerRound }, (_, index) => {
        const number = 100000 + (round * pendingPerRound) + index;
        return githubRecord(number, `STB-${number}`);
      });
      gate ??= new DatabaseSync(join(dataDirectory, "knowledge-store.sqlite"));
      gate.exec("BEGIN IMMEDIATE");
      gateTransactionOpen = true;
      const resolveShared = requestWorker(
        first,
        "ingest",
        [jiraRecord(sharedTicket)]
      );
      const addPending = requestWorker(second, "ingest", pendingBatch);
      await Promise.all([resolveShared.started, addPending.started]);
      await new Promise((resolve) => setTimeout(resolve, 75));
      gate.exec("COMMIT");
      gateTransactionOpen = false;
      await Promise.all([resolveShared, addPending]);
    }
    gate.close();
    gate = undefined;
    await Promise.all([
      requestWorker(first, "close"),
      requestWorker(second, "close")
    ]);
    await Promise.all([first.terminate(), second.terminate()]);
    first = undefined;
    second = undefined;

    const database = new DatabaseSync(join(dataDirectory, "knowledge-store.sqlite"));
    const deferred = database.prepare(`
      SELECT COUNT(*) AS count
      FROM deferred_trace_links
      WHERE tenant_id = ? AND product_id = ?
    `).get("solera", "fl-titling");
    const resolvedShared = database.prepare(`
      SELECT COUNT(*) AS count
      FROM trace_links
      WHERE tenant_id = ? AND product_id = ?
        AND to_entity_id LIKE 'requirement:STA-%'
    `).get("solera", "fl-titling");
    const resurrectedShared = database.prepare(`
      SELECT COUNT(*) AS count
      FROM deferred_trace_links
      WHERE tenant_id = ? AND product_id = ?
        AND to_entity_id LIKE 'requirement:STA-%'
    `).get("solera", "fl-titling");
    database.close();
    assert.equal(Number(deferred.count), rounds * pendingPerRound);
    assert.equal(Number(resolvedShared.count), rounds);
    assert.equal(Number(resurrectedShared.count), 0);
  } finally {
    if (gate) {
      if (gateTransactionOpen) gate.exec("ROLLBACK");
      gate.close();
    }
    if (first) {
      await requestWorker(first, "close").catch(() => {});
      await first.terminate();
    }
    if (second) {
      await requestWorker(second, "close").catch(() => {});
      await second.terminate();
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
