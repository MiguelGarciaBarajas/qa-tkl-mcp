import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import { createAuditLogger, createHealthRegistry } from "../../observability/src/index.js";
import {
  CHECKPOINT_POLICIES,
  ReplayConfirmationRequiredError,
  SYNC_MODES,
  SyncConfigurationError,
  SyncRunConflictError,
  createSyncCoordinator,
  isRunInProgress,
} from "../src/index.js";
import {
  FixtureConnector,
  GatedConnector,
  UnserializableCheckpointConnector,
  createDeferred,
  createTestClock,
  fixturePages,
  fixtureProductConfiguration,
} from "./support/fixtures.js";

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const CONNECTOR_ID = "connector.github";

function createHarness({
  pages,
  failAtPage = null,
  store = new InMemoryRawEvidenceStore({ tenantId: TENANT_ID, productId: PRODUCT_ID, now: createTestClock() }),
  connector,
  sync = {},
  auditEvents = [],
  ...rest
} = {}) {
  const resolvedPages = pages ?? fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const instance =
    connector ??
    new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages: resolvedPages, failAtPage });
  const auditLogger = createAuditLogger({
    sink: {
      info(event) {
        auditEvents.push(event);
      },
    },
  });
  const healthRegistry = createHealthRegistry({ correlationId: "ops-101-test" });
  const coordinator = createSyncCoordinator({
    configuration: fixtureProductConfiguration(),
    store,
    connectors: [{ pluginId: CONNECTOR_ID, instance }],
    sync: { batchSize: 2, ...sync },
    now: createTestClock(),
    newRunId: (() => {
      let counter = 0;
      return () => `run-${(counter += 1)}`;
    })(),
    auditLogger,
    healthRegistry,
    ...rest,
  });
  return { coordinator, store, connector: instance, auditEvents, healthRegistry, pages: resolvedPages };
}

test("runs an enabled connector, commits records with its checkpoint, and reports a sanitized summary", async () => {
  const { coordinator, store, connector } = createHarness();

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "succeeded");
  assert.equal(summary.mode, "incremental");
  assert.equal(summary.totals.recordCount, 6);
  assert.equal(summary.totals.committedCount, 6);
  assert.equal(summary.totals.duplicateCount, 0);
  assert.equal(store.listRecords().length, 6);
  assert.deepEqual(connector.resumedFrom, [{}]);

  const [connectorResult] = summary.connectors;
  assert.equal(connectorResult.connectorId, CONNECTOR_ID);
  assert.equal(connectorResult.status, "succeeded");
  assert.equal(connectorResult.checkpointAdvanced, true);
  assert.equal(connectorResult.resumedFromCheckpoint, false);

  const checkpoint = store.getCheckpoint(CONNECTOR_ID);
  assert.equal(checkpoint.page, 2);
  assert.ok(checkpoint.observedAt);
});

test("isolates checkpoint storage from the canonical plugin ID", async () => {
  const storageId = "connector.github.repository.application-1234567890";
  const { coordinator, store } = createHarness({
    connectorStorageIds: {
      [CONNECTOR_ID]: storageId
    }
  });

  await coordinator.runOnce();

  assert.equal(store.getCheckpoint(CONNECTOR_ID), undefined);
  assert.equal(store.getCheckpoint(storageId).page, 2);
  assert.equal(store.history(CONNECTOR_ID).length, 0);
  assert.equal(store.history(storageId).length, 3);
  assert.equal(store.listRecords({ connectorId: CONNECTOR_ID }).length, 0);
  assert.equal(store.listRecords({ connectorId: storageId }).length, 6);
});

test("reports duration, throughput, duplicate rate, and valid source-watermark lag", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const records = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID, pageCount: 1 });
  await store.commit({ connectorId: CONNECTOR_ID, records: [records[0][0]] });
  const connector = {
    metrics: { lastCheckpoint: null },
    async *collect() {
      for (const record of records[0]) {
        this.metrics.lastCheckpoint = {
          page: 0,
          sourceWatermark: "2026-02-01T00:00:00.000Z",
        };
        yield record;
      }
    },
  };
  const timestamps = [
    "2026-02-01T00:00:00.000Z",
    "2026-02-01T00:00:01.000Z",
    "2026-02-01T00:00:02.000Z",
    "2026-02-01T00:00:05.000Z",
    "2026-02-01T00:00:10.000Z",
  ];
  const { coordinator } = createHarness({
    store,
    connector,
    now: () => timestamps.shift() ?? "2026-02-01T00:00:10.000Z",
  });

  const summary = await coordinator.runOnce();
  const [result] = summary.connectors;
  assert.equal(result.durationMs, 4_000);
  assert.equal(result.throughputRecordsPerSecond, 0.5);
  assert.equal(result.duplicateRate, 0.5);
  assert.equal(result.ingestionLagSeconds, 5);
  assert.equal(summary.totals.durationMs, 10_000);
  assert.equal(summary.totals.throughputRecordsPerSecond, 0.2);
  assert.equal(summary.totals.duplicateRate, 0.5);
  assert.equal(summary.totals.ingestionLagSeconds, 5);
});

test("commits each batch atomically so the checkpoint never moves past uncommitted evidence", async () => {
  const { coordinator, store } = createHarness();
  await coordinator.runOnce();

  const history = store.history(CONNECTOR_ID);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((entry) => entry.committedCount),
    [2, 2, 2],
  );
});

test("resumes from the durably committed checkpoint after a mid-sync failure, without skipping or losing evidence", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const failing = createHarness({ store, pages, failAtPage: 2 });

  const firstSummary = await failing.coordinator.runOnce();
  assert.equal(firstSummary.status, "failed");
  assert.equal(firstSummary.connectors[0].error.stage, "collect");
  assert.equal(firstSummary.connectors[0].error.name, "FixtureSourceError");
  assert.equal(firstSummary.connectors[0].error.status, 503);
  assert.equal(store.listRecords().length, 4);
  assert.deepEqual(store.getCheckpoint(CONNECTOR_ID).page, 1);

  // A fresh coordinator and a fresh connector instance: nothing is carried
  // in process memory, exactly like a restarted job.
  const recovered = createHarness({ store, pages });
  const secondSummary = await recovered.coordinator.runOnce();

  assert.equal(secondSummary.status, "succeeded");
  assert.deepEqual(recovered.connector.resumedFrom[0].page, 1);
  assert.equal(secondSummary.connectors[0].resumedFromCheckpoint, true);
  assert.equal(secondSummary.totals.duplicateCount, 2, "page 1 is replayed and deduplicated");
  assert.equal(secondSummary.totals.committedCount, 2, "only page 2 is new");
  assert.equal(store.listRecords().length, 6);
  assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
});

test("commits evidence already fetched when collection fails, but never advances the checkpoint past it", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID, itemsPerPage: 3 });
  // batchSize 4 with 3 records per page guarantees a partially filled buffer
  // when page 2 fails: one batch of 4 was committed, two records are still
  // buffered.
  const { coordinator } = createHarness({ store, pages, failAtPage: 2, sync: { batchSize: 4 } });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "failed");
  assert.equal(summary.totals.recordCount, 6);
  assert.equal(summary.totals.committedCount, 6, "buffered evidence is still committed");
  assert.equal(store.listRecords().length, 6);
  assert.equal(
    store.getCheckpoint(CONNECTOR_ID).page,
    1,
    "the cursor stays at the last fully collected position",
  );
});

test("treats an identical re-run as duplicates and never double-commits evidence", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  await createHarness({ store, pages }).coordinator.runOnce();

  const replayHarness = createHarness({ store, pages });
  const summary = await replayHarness.coordinator.runOnce({
    mode: "replay-full",
    confirmReplay: true,
    maxRecordsPerConnector: 100,
  });

  assert.equal(summary.status, "succeeded");
  assert.equal(summary.totals.duplicateCount, 6);
  assert.equal(summary.totals.committedCount, 0);
  assert.equal(store.listRecords().length, 6);
});

test("replay-full restarts at the beginning and leaves the stored checkpoint untouched by default", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  await createHarness({ store, pages }).coordinator.runOnce();
  const checkpointBefore = store.getCheckpoint(CONNECTOR_ID);

  const replay = createHarness({ store, pages });
  const summary = await replay.coordinator.runOnce({
    mode: "replay-full",
    confirmReplay: true,
    maxRecordsPerConnector: 100,
  });

  assert.deepEqual(replay.connector.resumedFrom, [{}], "replay-full starts from the source beginning");
  assert.equal(summary.connectors[0].checkpointPolicy, "preserve");
  assert.equal(summary.connectors[0].checkpointAdvanced, false);
  assert.deepEqual(store.getCheckpoint(CONNECTOR_ID), checkpointBefore);
});

test("rejects a replay that was not explicitly confirmed and never rewinds a checkpoint implicitly", async () => {
  const { coordinator, store } = createHarness();
  await coordinator.runOnce();
  const checkpointBefore = store.getCheckpoint(CONNECTOR_ID);

  for (const mode of SYNC_MODES.filter((candidate) => candidate !== "incremental")) {
    await assert.rejects(
      () => coordinator.runOnce({ mode }),
      (error) => error instanceof ReplayConfirmationRequiredError && error.mode === mode,
    );
  }
  assert.deepEqual(store.getCheckpoint(CONNECTOR_ID), checkpointBefore);
});

test("replays from an explicit checkpoint only in replay-from-checkpoint mode", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  await createHarness({ store, pages }).coordinator.runOnce();

  const replay = createHarness({ store, pages });
  const summary = await replay.coordinator.runOnce({
    mode: "replay-from-checkpoint",
    confirmReplay: true,
    maxRecordsPerConnector: 100,
    startCheckpoint: { page: 1 },
  });

  assert.deepEqual(replay.connector.resumedFrom, [{ page: 1 }]);
  assert.equal(summary.totals.recordCount, 4);
  assert.equal(summary.totals.duplicateCount, 4);

  const incremental = createHarness({ store, pages });
  await assert.rejects(
    () => incremental.coordinator.runOnce({ startCheckpoint: { page: 0 } }),
    SyncConfigurationError,
  );
});

test("advances the checkpoint during a replay only when the operator asks for it explicitly", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const replay = createHarness({ store, pages });

  const summary = await replay.coordinator.runOnce({
    mode: "replay-full",
    confirmReplay: true,
    maxRecordsPerConnector: 100,
    checkpointPolicy: "advance",
  });

  assert.equal(summary.connectors[0].checkpointAdvanced, true);
  assert.equal(store.getCheckpoint(CONNECTOR_ID).page, 2);
  assert.deepEqual(CHECKPOINT_POLICIES, ["advance", "preserve"]);
});

test("skips a connector whose run is already in progress in this process", async () => {
  const gate = createDeferred();
  const started = createDeferred();
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const connector = new GatedConnector({ pages, gate: gate.promise, onStart: () => started.resolve() });
  const { coordinator, store } = createHarness({ connector, pages });

  const firstRun = coordinator.runOnce();
  // The gated connector is suspended inside collect(), so the lock is held.
  await started.promise;
  assert.equal(isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }), true);

  const overlapping = await coordinator.runOnce();
  assert.equal(overlapping.status, "skipped");
  assert.equal(overlapping.connectors[0].status, "skipped");
  assert.equal(overlapping.connectors[0].reason, "run-already-in-progress");
  assert.equal(overlapping.totals.recordCount, 0);

  gate.resolve();
  const firstSummary = await firstRun;
  assert.equal(firstSummary.status, "succeeded");
  assert.equal(store.listRecords().length, 6);
  assert.equal(isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }), false);
});

test("fails closed on an overlapping run when the overlap policy is fail", async () => {
  const gate = createDeferred();
  const started = createDeferred();
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const connector = new GatedConnector({ pages, gate: gate.promise, onStart: () => started.resolve() });
  const { coordinator } = createHarness({ connector, pages, sync: { batchSize: 2, overlapPolicy: "fail" } });

  const firstRun = coordinator.runOnce();
  await started.promise;
  await assert.rejects(() => coordinator.runOnce(), SyncRunConflictError);

  gate.resolve();
  await firstRun;
});

test("releases the in-process lock even when a connector fails", async () => {
  const { coordinator } = createHarness({ failAtPage: 0 });
  const summary = await coordinator.runOnce();
  assert.equal(summary.status, "failed");
  assert.equal(isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }), false);
});

test("honors an injected cross-process lock seam and reports an unavailable lease as a skip", async () => {
  const released = [];
  const { coordinator, store } = createHarness({
    externalLock: {
      async acquire({ connectorId }) {
        return connectorId === CONNECTOR_ID
          ? { release: async () => released.push(connectorId) }
          : null;
      },
    },
  });
  const granted = await coordinator.runOnce();
  assert.equal(granted.status, "succeeded");
  assert.deepEqual(released, [CONNECTOR_ID]);

  const denied = createHarness({
    store,
    externalLock: { acquire: async () => null },
  });
  const deniedSummary = await denied.coordinator.runOnce();
  assert.equal(deniedSummary.connectors[0].status, "skipped");
  assert.equal(deniedSummary.connectors[0].reason, "external-lock-unavailable");
});

test("fails only the affected connector when an external lock provider throws", async () => {
  const { coordinator, store } = createHarness({
    externalLock: {
      async acquire() {
        const error = new Error("lease provider unreachable at https://lease.invalid/locks");
        error.name = "LeaseProviderError";
        error.code = "ECONNREFUSED";
        throw error;
      },
    },
  });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "failed");
  assert.equal(summary.connectors[0].error.stage, "lock");
  assert.equal(summary.connectors[0].error.code, "ECONNREFUSED");
  assert.equal(store.listRecords().length, 0);
  assert.equal(
    isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }),
    false,
    "the in-process lock is released when the external lease cannot be acquired",
  );
  assert.equal(JSON.stringify(summary).includes("lease.invalid"), false);
});

test("stops a bounded run and reports it as truncated, not as a plain success", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const pages = fixturePages({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const bounded = createHarness({ store, pages, sync: { batchSize: 2, maxRecordsPerConnector: 2 } });

  const first = await bounded.coordinator.runOnce();
  assert.equal(first.connectors[0].truncated, true);
  assert.equal(first.connectors[0].status, "truncated");
  assert.equal(
    first.status,
    "partial",
    "a run that stopped before exhausting its source is never reported as succeeded",
  );
  assert.equal(first.totals.truncated, 1);
  assert.equal(first.totals.recordCount, 2);
  assert.equal(store.listRecords().length, 2);

  // A connector that resumes from a mid-stream cursor does make progress on
  // the next run. The production connectors deliberately do not: they
  // replay from page zero, which is why truncation is surfaced instead of
  // being presented as a safe way to bound a schedule.
  const next = createHarness({ store, pages, sync: { batchSize: 2 } });
  const second = await next.coordinator.runOnce();
  assert.equal(second.connectors[0].truncated, false);
  assert.equal(second.status, "succeeded");
  assert.equal(store.listRecords().length, 6);
});

test("stops a run when maxDurationMs is exceeded and reports a partial timeout", async () => {
  const monotonicValues = [0, 2];
  const { coordinator, store } = createHarness({
    monotonicNow: () => monotonicValues.shift() ?? 2,
  });

  const summary = await coordinator.runOnce({ maxDurationMs: 1 });

  assert.equal(summary.status, "partial");
  assert.equal(summary.connectors[0].status, "truncated");
  assert.equal(summary.connectors[0].truncationReason, "max-duration");
  assert.equal(summary.connectors[0].recordCount, 1);
  assert.equal(store.listRecords().length, 1);
});

test("aborts connector work blocked before its first yield and releases the run lock", async () => {
  let activeCollections = 0;
  let collectionCalls = 0;
  let observedAbort = false;
  const connector = {
    metrics: { lastCheckpoint: null },
    async *collect(_checkpoint, { signal } = {}) {
      collectionCalls += 1;
      if (collectionCalls > 1) return;
      activeCollections += 1;
      try {
        await new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      } finally {
        activeCollections -= 1;
      }
    },
  };
  const { coordinator } = createHarness({ connector });
  const startedAt = performance.now();

  const summary = await coordinator.runOnce({ maxDurationMs: 25 });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(summary.status, "partial");
  assert.equal(summary.connectors[0].status, "truncated");
  assert.equal(summary.connectors[0].truncationReason, "max-duration");
  assert.equal(summary.connectors[0].recordCount, 0);
  assert.equal(observedAbort, true);
  assert.equal(activeCollections, 0);
  assert.ok(elapsedMs < 500, `deadline cancellation took ${elapsedMs}ms`);
  assert.equal(
    isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }),
    false,
  );

  const next = await coordinator.runOnce();
  assert.equal(next.status, "succeeded");
  assert.equal(collectionCalls, 2);
});

test("classifies external cancellation separately and salvages without advancing checkpoint", async () => {
  const waitingForAbort = createDeferred();
  const record = fixturePages({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    pageCount: 1,
  })[0][0];
  const connector = {
    metrics: { lastCheckpoint: null },
    async *collect(_checkpoint, { signal } = {}) {
      this.metrics.lastCheckpoint = { page: 99 };
      yield record;
      waitingForAbort.resolve();
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const controller = new AbortController();
  const { coordinator, store } = createHarness({ connector });

  const run = coordinator.runOnce({ signal: controller.signal });
  await waitingForAbort.promise;
  controller.abort(new Error("raw caller reason must not escape"));
  const summary = await run;

  assert.equal(summary.status, "failed");
  assert.equal(summary.connectors[0].status, "failed");
  assert.equal(summary.connectors[0].truncated, false);
  assert.equal(summary.connectors[0].truncationReason, undefined);
  assert.deepEqual(summary.connectors[0].error, {
    stage: "collect",
    name: "SyncCancelledError",
    code: "sync_cancelled",
  });
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.getCheckpoint(CONNECTOR_ID), undefined);
  assert.equal(JSON.stringify(summary).includes("raw caller reason"), false);
  assert.equal(
    isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }),
    false,
  );
});

test("keeps deadline classification when external cancellation arrives after the deadline", async () => {
  const deadlineObserved = createDeferred();
  const releaseCollection = createDeferred();
  const connector = {
    metrics: { lastCheckpoint: null },
    async *collect(_checkpoint, { signal } = {}) {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      deadlineObserved.resolve();
      await releaseCollection.promise;
      throw signal.reason;
    },
  };
  const controller = new AbortController();
  const { coordinator } = createHarness({ connector });

  const run = coordinator.runOnce({
    maxDurationMs: 10,
    signal: controller.signal,
  });
  await deadlineObserved.promise;
  controller.abort();
  releaseCollection.resolve();
  const summary = await run;

  assert.equal(summary.status, "partial");
  assert.equal(summary.connectors[0].status, "truncated");
  assert.equal(summary.connectors[0].truncationReason, "max-duration");
  assert.equal(summary.connectors[0].error, undefined);
});

test("requires a finite record cap for an executing replay", async () => {
  const { coordinator } = createHarness();

  await assert.rejects(
    () => coordinator.runOnce({ mode: "replay-full", confirmReplay: true }),
    /finite maxRecordsPerConnector/,
  );
});

test("requires an executing replay to target exactly one connector", async () => {
  const configuration = fixtureProductConfiguration();
  configuration.enabledPlugins = ["connector.github", "connector.jira"];
  configuration.plannedPlugins = ["connector.testrail"];
  configuration.sources.jira = {
    enabled: true,
    configurationStatus: "ready",
    baseUrl: "https://jira.example.test",
    allowedProjects: ["STT"],
    allowedJql: ["project = STT"],
    jql: "project = STT",
  };
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
  });
  const coordinator = createSyncCoordinator({
    configuration,
    store,
    connectors: [
      {
        pluginId: "connector.github",
        instance: new FixtureConnector({
          tenantId: TENANT_ID,
          productId: PRODUCT_ID,
          pages: [],
        }),
      },
      {
        pluginId: "connector.jira",
        instance: new FixtureConnector({
          tenantId: TENANT_ID,
          productId: PRODUCT_ID,
          pages: [],
        }),
      },
    ],
  });

  await assert.rejects(
    () => coordinator.runOnce({
      mode: "replay-full",
      confirmReplay: true,
      maxRecordsPerConnector: 100,
    }),
    /exactly one connector/,
  );
});

test("never leaves a scope locked when reading the stored checkpoint fails", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const failingStore = {
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    commit: (request) => store.commit(request),
    getCheckpoint() {
      const error = new Error("checkpoint unreadable at C:\\data\\evidence.enc");
      error.name = "StoreReadError";
      throw error;
    },
    getRecord: (key) => store.getRecord(key),
    listRecords: (filter) => store.listRecords(filter),
    history: (connectorId) => store.history(connectorId),
  };
  const { coordinator } = createHarness({ store: failingStore });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "failed");
  assert.equal(summary.connectors[0].error.stage, "start");
  assert.equal(summary.connectors[0].error.name, "StoreReadError");
  assert.equal(
    isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }),
    false,
    "the scope lock is released even when the run fails before collection starts",
  );

  // A later, healthy run for the same scope must not be refused as an overlap.
  const recovered = createHarness({ store });
  const recoveredSummary = await recovered.coordinator.runOnce();
  assert.equal(recoveredSummary.status, "succeeded");
  assert.equal(store.listRecords().length, 6);
});

test("completes a run whose external lock release fails, reporting a sanitized warning", async () => {
  const { coordinator, store } = createHarness({
    externalLock: {
      async acquire() {
        return {
          async release() {
            const error = new Error("lease release failed for https://lease.invalid/locks/1");
            error.name = "LeaseError";
            throw error;
          },
        };
      },
    },
  });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "succeeded", "a completed run is not discarded by a release failure");
  assert.deepEqual(summary.connectors[0].warnings, ["external-lock-release-failed"]);
  assert.equal(store.listRecords().length, 6);
  assert.equal(
    isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }),
    false,
  );
  assert.equal(JSON.stringify(summary).includes("lease.invalid"), false);
});

test("fails the batch closed when a connector proposes a checkpoint that cannot be persisted", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    now: createTestClock(),
  });
  const { coordinator } = createHarness({ store, connector: new UnserializableCheckpointConnector() });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "failed");
  assert.equal(summary.connectors[0].error.stage, "checkpoint");
  assert.equal(summary.connectors[0].error.name, "CheckpointValidationError");
  assert.equal(store.getCheckpoint(CONNECTOR_ID), undefined);
});

test("plans a run without contacting the source, committing, or taking a lock", async () => {
  const { coordinator, store, connector } = createHarness();

  const plan = coordinator.plan({ mode: "replay-full" });

  assert.equal(plan.status, "planned");
  assert.equal(plan.reportType, "sync.run.plan");
  assert.equal(plan.connectors[0].wouldStartFromBeginning, true);
  assert.equal(plan.connectors[0].wouldClearCheckpoint, false);
  assert.equal(plan.connectors[0].replayConfirmed, false);
  assert.deepEqual(connector.resumedFrom, [], "planning never calls collect()");
  assert.equal(store.listRecords().length, 0);
  assert.equal(isRunInProgress({ tenantId: TENANT_ID, productId: PRODUCT_ID, connectorId: CONNECTOR_ID }), false);

  const dryRun = await coordinator.runOnce({ dryRun: true, mode: "replay-full" });
  assert.equal(dryRun.status, "planned");
  assert.equal(store.listRecords().length, 0);
});

test("emits sanitized audit events and health without payloads, credentials, URLs, or paths", async () => {
  const auditEvents = [];
  const { coordinator, healthRegistry } = createHarness({ auditEvents, failAtPage: 2 });

  const summary = await coordinator.runOnce();
  const serialized = JSON.stringify({ summary, auditEvents, health: healthRegistry.report() });

  assert.ok(auditEvents.some((event) => event.eventType === "sync.run.started"));
  assert.ok(auditEvents.some((event) => event.eventType === "sync.connector.completed"));
  assert.ok(auditEvents.some((event) => event.eventType === "sync.run.completed"));
  assert.equal(serialized.includes("secret://"), false);
  assert.equal(serialized.includes("example.invalid"), false, "no raw error message leaks");
  assert.equal(serialized.includes("token=abc"), false);
  assert.equal(JSON.stringify(summary).includes("payload"), false);
  assert.equal(healthRegistry.report().components[0].credentialRef, "[REDACTED]");
  assert.equal(coordinator.health().status, "degraded");
});

test("rejects configuration that does not fail closed", async () => {
  const configuration = fixtureProductConfiguration();
  const store = new InMemoryRawEvidenceStore({ tenantId: TENANT_ID, productId: PRODUCT_ID });
  const connectors = [{ pluginId: CONNECTOR_ID, instance: new FixtureConnector({ tenantId: TENANT_ID, productId: PRODUCT_ID, pages: [] }) }];

  assert.throws(
    () =>
      createSyncCoordinator({
        configuration,
        store: new InMemoryRawEvidenceStore({ tenantId: "other", productId: PRODUCT_ID }),
        connectors,
      }),
    SyncConfigurationError,
  );
  assert.throws(
    () => createSyncCoordinator({ configuration, store, connectors: [] }),
    SyncConfigurationError,
  );
  assert.throws(
    () => createSyncCoordinator({ configuration, store, connectors, sync: { retention: { mode: "delete" } } }),
    SyncConfigurationError,
  );
  assert.throws(
    () => createSyncCoordinator({ configuration, store, connectors, sync: { batchSize: 0 } }),
    SyncConfigurationError,
  );

  const coordinator = createSyncCoordinator({ configuration, store, connectors });
  await assert.rejects(
    () => coordinator.runOnce({ connectorIds: ["connector.jira"] }),
    SyncConfigurationError,
  );
  assert.deepEqual(coordinator.listConnectors(), [CONNECTOR_ID]);
  assert.equal(coordinator.health().status, "unknown");
});

test("yields to the event loop after each committed batch", async () => {
  let yields = 0;
  const { coordinator, store } = createHarness({
    sync: { batchSize: 2 },
    yieldAfterCommit: () => {
      yields += 1;
      return new Promise((resolve) => setImmediate(resolve));
    },
  });

  const summary = await coordinator.runOnce();

  assert.equal(summary.status, "succeeded");
  assert.equal(store.listRecords().length, 6);
  // 6 records at batchSize 2 => three committed batches, each followed by a
  // cooperative yield so a tight collect->commit loop cannot starve I/O.
  assert.ok(yields >= 3, `expected a yield per committed batch, saw ${yields}`);
});

test("rejects a non-function yieldAfterCommit", () => {
  assert.throws(
    () => createHarness({ yieldAfterCommit: "nope" }),
    SyncConfigurationError,
  );
});
