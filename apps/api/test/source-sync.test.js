import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainPendingProjections,
  createSourceSyncRunner,
  SourceSyncError
} from "../src/source-sync.js";

function projectionRecord(sourceId) {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    source: "github",
    sourceId,
    sourceVersion: "1",
    observedAt: "2026-09-15T00:00:00.000Z",
    contentType: "github.item",
    contentHash: `hash-${sourceId}`,
    classification: "internal",
    idempotencyKey: `github:${sourceId}:1`,
    payload: { id: sourceId }
  };
}

function projectionStore(pending = []) {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    pending,
    countPendingProjectionRecords() {
      return this.pending.length;
    },
    listPendingProjectionRecords(limit) {
      return this.pending.slice(0, limit);
    },
    async acknowledgeProjected(keys) {
      this.pending = this.pending.filter((record) => !keys.includes(record.idempotencyKey));
    },
    async recordProjectionFailures(keys) {
      const failed = this.pending.filter((record) => keys.includes(record.idempotencyKey));
      this.pending = [
        ...this.pending.filter((record) => !keys.includes(record.idempotencyKey)),
        ...failed
      ];
    }
  };
}

function successfulCoordinator(summaryOverrides = {}) {
  return {
    async runOnce() {
      return {
        runId: "run-1",
        status: "succeeded",
        connectors: [{ status: "succeeded" }],
        totals: {
          recordCount: 1,
          committedCount: 1,
          duplicateCount: 0
        },
        ...summaryOverrides
      };
    }
  };
}

test("sync revalidates the configured host before resolving keys or source credentials", async () => {
  let keyResolutions = 0;
  let credentialResolutions = 0;
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: { async ingest() {} },
    dataDirectory: "unused",
    resolveRawEvidenceKey() {
      keyResolutions += 1;
      return Buffer.alloc(32);
    }
  });

  await assert.rejects(
    () => syncSource({
      productId: "fl-titling",
      source: "github",
      config: {
        apiUrl: "https://internal-admin.example",
        repositories: ["owner/repository"]
      },
      resolveCredential() {
        credentialResolutions += 1;
        return "synthetic-token";
      }
    }),
    (error) =>
      error instanceof SourceSyncError
      && error.code === "source_host_not_allowed"
  );

  assert.equal(keyResolutions, 0);
  assert.equal(credentialResolutions, 0);
});

test("passes repository-scoped checkpoint namespaces to the coordinator", async () => {
    const storageMappings = [];
    const store = {
      tenantId: "solera",
      productId: "fl-titling",
      countPendingProjectionRecords: () => 0
    };
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: { async ingest() {} },
      dataDirectory: "unused",
      rawStoreFactory: async () => store,
      composeConnectorsImpl: () => ({
        getPlugin() {
          return { async *collect() {} };
        }
      }),
      coordinatorFactory(options) {
        storageMappings.push(options.connectorStorageIds);
        return successfulCoordinator();
      }
    });

    await syncSource({
      productId: "fl-titling",
      source: "github",
      repositoryId: "application-repository",
      config: { repositories: ["owner/application"] },
      resolveCredential: async () => "synthetic-token"
    });
    await syncSource({
      productId: "fl-titling",
      source: "github",
      repositoryId: "automation_repository",
      config: { repositories: ["owner/automation"] },
      resolveCredential: async () => "synthetic-token"
    });

    const first = storageMappings[0]["connector.github"];
    const second = storageMappings[1]["connector.github"];
    assert.match(first, /^connector\.github\.repository\./);
    assert.match(second, /^connector\.github\.repository\./);
    assert.notEqual(first, second);
});

test("fans out on-demand GitHub search with aggregate budgets and partial outcomes", async () => {
    const commits = [];
    const calls = [];
    const projected = [];
    const store = {
      tenantId: "solera",
      productId: "fl-titling",
      async commit({ connectorId, records }) {
        commits.push({ connectorId, records });
        return {
          committedCount: records.length,
          duplicateCount: 0,
          committedIdempotencyKeys: records.map((record) => record.idempotencyKey)
        };
      },
      hasPendingProjection: () => false,
      async acknowledgeProjected() {}
    };
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: {
        async ingest(records) {
          projected.push(...records);
        }
      },
      dataDirectory: "unused",
      rawStoreFactory: async () => store,
      composeConnectorsImpl({ configuration }) {
        const repository = configuration.sources.github.repository;
        return {
          getPlugin() {
            return {
              async *collectPullRequestsByIssue(_issueKey, options) {
                calls.push({ repository, ...options });
                if (repository === "owner/unavailable") {
                  throw new Error("provider response synthetic-token");
                }
                yield {
                  ...projectionRecord(`${repository}#1`),
                  contentType: "github.pull_request"
                };
              }
            };
          }
        };
      }
    });

    const result = await syncSource.retrieveGitHubPullRequests({
      productId: "fl-titling",
      issueKey: "STT-1234",
      config: {
        repositories: ["owner/available", "owner/unavailable", "owner/second"]
      },
      resolveCredential: async () => "synthetic-token",
      maxPullRequests: 2,
      maxChangedFiles: 3
    });

    assert.equal(result.status, "partial");
    assert.equal(result.recordsCollected, 2);
    assert.equal(result.recordsCommitted, 2);
    assert.equal(result.repositories.length, 3);
    assert.equal(result.repositories[1].status, "unavailable");
    assert.ok(!JSON.stringify(result).includes("synthetic-token"));
    assert.equal(projected.length, 2);
    assert.equal(commits.length, 2);
    assert.notEqual(commits[0].connectorId, commits[1].connectorId);
    assert.ok(commits.every(
      (commit) => commit.connectorId.startsWith("connector.github.on-demand.repository.")
    ));
    assert.equal(calls[0].maxPullRequests, 2);
    assert.equal(calls[2].maxPullRequests, 1);
});

test("the explicit development option permits loopback before durable store initialization", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-source-sync-loopback-"));
  let fetchCalls = 0;
  try {
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: { async ingest() {} },
      dataDirectory,
      allowInsecureLoopback: true,
      resolveRawEvidenceKey: async () => Buffer.alloc(32, 1),
      async fetchImpl() {
        fetchCalls += 1;
        throw new Error("synthetic provider failure");
      }
    });

    await assert.rejects(
      () => syncSource({
        productId: "fl-titling",
        source: "github",
        config: {
          apiUrl: "http://127.0.0.1:8080",
          repositories: ["owner/repository"]
        },
        resolveCredential: async () => "synthetic-token"
      }),
      (error) => error instanceof SourceSyncError && error.code === "source_sync_failed"
    );
    assert.ok(fetchCalls > 0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("projection drain yields to the event loop so concurrent macrotasks run before it completes", async () => {
  // A backlog large enough to require several batches. Each batch does a slice
  // of synchronous CPU work, modelling normalization/SQLite projection.
  const pending = Array.from({ length: 8 }, (_, id) => ({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: `STT-${id}`,
    sourceVersion: "1",
    observedAt: "2026-09-14T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: `hash-${id}`,
    classification: "internal",
    idempotencyKey: `jira:STT-${id}:1`,
    payload: { key: `STT-${id}` }
  }));
  const store = {
    countPendingProjectionRecords: () => pending.length,
    listPendingProjectionRecords: (limit) => pending.slice(0, limit),
    async acknowledgeProjected(keys) {
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.splice(index, 1);
      }
    },
    async recordProjectionFailures() {}
  };

  let immediateRan = false;
  let immediateRanBeforeDrainCompleted = false;
  // Queued before the drain starts. If the drain never returned control to the
  // macrotask queue, this would only run *after* the whole drain finished.
  setImmediate(() => {
    immediateRan = true;
  });

  const projected = await drainPendingProjections({
    store,
    batchSize: 1,
    async projectRecords(records) {
      // Synchronous CPU work: without a cooperative yield this would starve the
      // event loop for the entire drain.
      const deadline = Date.now() + 2;
      while (Date.now() < deadline) {
        /* busy-wait to simulate synchronous projection cost */
      }
      if (immediateRan) immediateRanBeforeDrainCompleted = true;
      return { ingestedRecords: records.length };
    }
  });

  assert.equal(projected, 8);
  assert.equal(pending.length, 0);
  assert.ok(
    immediateRanBeforeDrainCompleted,
    "a setImmediate scheduled before the drain must run before the drain completes"
  );
});

test("projection drain reports slow batches without leaking record identifiers", async () => {
  const pending = [{
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-slow",
    sourceVersion: "1",
    observedAt: "2026-09-14T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: "hash-slow",
    classification: "internal",
    idempotencyKey: "jira:STT-slow:1",
    payload: { key: "STT-slow" }
  }];
  const store = {
    countPendingProjectionRecords: () => pending.length,
    listPendingProjectionRecords: (limit) => pending.slice(0, limit),
    async acknowledgeProjected(keys) {
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.splice(index, 1);
      }
    },
    async recordProjectionFailures() {}
  };
  const slowBatches = [];
  await drainPendingProjections({
    store,
    batchSize: 1,
    slowBatchThresholdMs: 5,
    onSlowBatch: (event) => slowBatches.push(event),
    async projectRecords(records) {
      const deadline = Date.now() + 10;
      while (Date.now() < deadline) {
        /* busy-wait past the slow-batch threshold */
      }
      return { ingestedRecords: records.length };
    }
  });

  assert.equal(slowBatches.length, 1);
  assert.equal(slowBatches[0].phase, "silver-projection-batch");
  assert.equal(slowBatches[0].batchSize, 1);
  assert.ok(slowBatches[0].durationMs >= 5);
  const serialized = JSON.stringify(slowBatches[0]);
  assert.ok(!serialized.includes("STT-slow"), "slow-batch signal must not leak source identifiers");
  assert.ok(!serialized.includes("payload"), "slow-batch signal must not leak payloads");
});

test("incremental projection drains a durable outbox in bounded retryable batches", async () => {
  const pending = Array.from({ length: 2501 }, (_, id) => ({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: `STT-${id}`,
    sourceVersion: "1",
    observedAt: "2026-09-14T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: `hash-${id}`,
    classification: "internal",
    idempotencyKey: `jira:STT-${id}:1`,
    payload: { key: `STT-${id}` }
  }));
  const projectedBatchSizes = [];
  const store = {
    countPendingProjectionRecords() {
      return pending.length;
    },
    listPendingProjectionRecords(limit) {
      return pending.slice(0, limit);
    },
    async acknowledgeProjected(keys) {
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.splice(index, 1);
      }
    },
    async recordProjectionFailures(keys) {
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.push(...pending.splice(index, 1));
      }
    }
  };
  const projected = await drainPendingProjections({
    store,
    batchSize: 100,
    async projectRecords(records) {
      projectedBatchSizes.push(records.length);
      return { ingestedRecords: records.length };
    }
  });

  assert.equal(projectedBatchSizes.length, 26);
  assert.equal(Math.max(...projectedBatchSizes), 100);
  assert.equal(projectedBatchSizes.at(-1), 1);
  assert.equal(projected, 2501);
  assert.equal(pending.length, 0);
});

test("projection drain isolates poison records and records one failure per pass", async () => {
  const pending = ["healthy-1", "poison", "healthy-2"].map((sourceId) => ({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId,
    sourceVersion: "1",
    observedAt: "2026-09-14T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: `hash-${sourceId}`,
    classification: "internal",
    idempotencyKey: `jira:${sourceId}:1`,
    payload: { key: sourceId }
  }));
  const failureCalls = [];
  const store = {
    countPendingProjectionRecords() {
      return pending.length;
    },
    listPendingProjectionRecords(limit) {
      return pending.slice(0, limit);
    },
    async acknowledgeProjected(keys) {
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.splice(index, 1);
      }
    },
    async recordProjectionFailures(keys) {
      failureCalls.push([...keys]);
      for (const key of keys) {
        const index = pending.findIndex((record) => record.idempotencyKey === key);
        if (index >= 0) pending.push(...pending.splice(index, 1));
      }
    }
  };

  const projected = await drainPendingProjections({
    store,
    batchSize: 3,
    async projectRecords(records) {
      if (records.some((record) => record.sourceId === "poison")) {
        throw new Error("raw provider response must never be persisted");
      }
      return { ingestedRecords: records.length };
    }
  });

  assert.equal(projected, 2);
  assert.deepEqual(failureCalls, [["jira:poison:1"]]);
  assert.deepEqual(pending.map((record) => record.sourceId), ["poison"]);
});

test("projection acknowledgement failures propagate without recording projection attempts", async () => {
  const pending = [{
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-1",
    sourceVersion: "1",
    observedAt: "2026-09-14T00:00:00.000Z",
    contentType: "jira.issue",
    contentHash: "hash-STT-1",
    classification: "internal",
    idempotencyKey: "jira:STT-1:1",
    payload: { key: "STT-1" }
  }];
  let projectionCalls = 0;
  let failureAttempts = 0;
  const store = {
    countPendingProjectionRecords: () => pending.length,
    listPendingProjectionRecords: () => [...pending],
    async acknowledgeProjected() {
      throw new Error("projection acknowledgement persistence failed");
    },
    async recordProjectionFailures() {
      failureAttempts += 1;
    }
  };

  await assert.rejects(
    drainPendingProjections({
      store,
      async projectRecords(records) {
        projectionCalls += 1;
        return { ingestedRecords: records.length };
      }
    }),
    /projection acknowledgement persistence failed/
  );

  assert.equal(projectionCalls, 1);
  assert.equal(failureAttempts, 0);
  assert.equal(pending.length, 1);
});

test("connector sync returns after raw collection without awaiting projection", async () => {
  const store = projectionStore([projectionRecord("preexisting-backlog")]);
  let coordinatorCompleted = false;
  let coordinatorStarted;
  const coordinatorStartedPromise = new Promise((resolve) => {
    coordinatorStarted = resolve;
  });
  let projectionStarted = false;
  let notifyProjectionStarted;
  const projectionStartedPromise = new Promise((resolve) => {
    notifyProjectionStarted = resolve;
  });
  let releaseProjection;
  const projectionGate = new Promise((resolve) => {
    releaseProjection = resolve;
  });
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest() {
        projectionStarted = true;
        notifyProjectionStarted();
        await projectionGate;
        return { ingestedRecords: 1 };
      }
    },
    dataDirectory: "unused",
    rawStoreFactory: () => store,
    composeConnectorsImpl: () => ({}),
    coordinatorFactory: () => ({
      async runOnce() {
        coordinatorStarted();
        store.pending.push(projectionRecord("after-raw-commit"));
        coordinatorCompleted = true;
        return successfulCoordinator().runOnce();
      }
    })
  });

  const syncPromise = syncSource({
    productId: "fl-titling",
    source: "github",
    config: { repositories: ["owner/repository"] },
    resolveCredential: async () => "synthetic-token"
  });
  const firstWork = await Promise.race([
    coordinatorStartedPromise.then(() => "coordinator"),
    projectionStartedPromise.then(() => "projection")
  ]);
  assert.equal(firstWork, "coordinator", "projection must not drain before connector collection");
  const result = await syncPromise;

  assert.equal(coordinatorCompleted, true);
  assert.equal(result.recordsCommitted, 1);
  assert.equal(result.knowledgeRecordsProcessed, 0);
  await projectionStartedPromise;
  assert.equal(projectionStarted, true);
  releaseProjection();
  await syncSource.resumePendingProjections({ productId: "fl-titling" });
});

test("one projector per product coalesces triggers without losing a wakeup", async () => {
  const store = projectionStore([projectionRecord("first")]);
  let activeProjectors = 0;
  let maxActiveProjectors = 0;
  let releaseFirstProjection;
  const firstProjectionGate = new Promise((resolve) => {
    releaseFirstProjection = resolve;
  });
  let notifyFirstProjectionStarted;
  const firstProjectionStarted = new Promise((resolve) => {
    notifyFirstProjectionStarted = resolve;
  });
  let projectionCalls = 0;
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        projectionCalls += 1;
        activeProjectors += 1;
        maxActiveProjectors = Math.max(maxActiveProjectors, activeProjectors);
        if (projectionCalls === 1) {
          notifyFirstProjectionStarted();
          await firstProjectionGate;
        }
        activeProjectors -= 1;
        return { ingestedRecords: records.length };
      }
    },
    dataDirectory: "unused",
    backgroundProjectionBatchSize: 1,
    rawStoreFactory: () => store,
    composeConnectorsImpl: () => ({}),
    coordinatorFactory: () => ({
      async runOnce() {
        store.pending.push(projectionRecord("arrived-during-projection"));
        return successfulCoordinator().runOnce();
      }
    })
  });

  const firstResume = syncSource.resumePendingProjections({ productId: "fl-titling" });
  await firstProjectionStarted;
  const syncResult = await syncSource({
    productId: "fl-titling",
    source: "github",
    config: { repositories: ["owner/repository"] },
    resolveCredential: async () => "synthetic-token"
  });
  assert.equal(syncResult.recordsCommitted, 1);

  releaseFirstProjection();
  await firstResume;
  const status = await syncSource.projectionStatus({ productId: "fl-titling" });
  assert.equal(maxActiveProjectors, 1);
  assert.equal(status.pendingRecords, 0);
  assert.equal(status.passes, 2);
  assert.equal(status.projectedRecords, 2);
});

test("background projection uses its own responsive default batch size", async () => {
  const store = projectionStore(
    Array.from({ length: 6 }, (_, index) => projectionRecord(`batch-${index}`))
  );
  const batchSizes = [];
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        batchSizes.push(records.length);
        return { ingestedRecords: records.length };
      }
    },
    dataDirectory: "unused",
    rawStoreFactory: () => store
  });

  await syncSource.resumePendingProjections({ productId: "fl-titling" });

  assert.deepEqual(batchSizes, [5, 1]);
});

test("a failed background projector is caught and can be restarted", async () => {
  const store = projectionStore([projectionRecord("retry")]);
  const acknowledge = store.acknowledgeProjected.bind(store);
  let failAcknowledgement = true;
  store.acknowledgeProjected = async (keys) => {
    if (failAcknowledgement) throw new Error("durable acknowledgement failed");
    await acknowledge(keys);
  };
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        return { ingestedRecords: records.length };
      }
    },
    dataDirectory: "unused",
    rawStoreFactory: () => store
  });

  const failed = await syncSource.resumePendingProjections({ productId: "fl-titling" });
  assert.equal(failed.running, false);
  assert.equal(failed.pendingRecords, 1);
  assert.equal(failed.lastErrorCode, "background_projection_failed");

  failAcknowledgement = false;
  const recovered = await syncSource.resumePendingProjections({ productId: "fl-titling" });
  assert.equal(recovered.running, false);
  assert.equal(recovered.pendingRecords, 0);
  assert.equal(recovered.lastErrorCode, null);
});

test("startup recovery resumes every persisted product scope", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "tkl-projection-recovery-"));
  try {
    await mkdir(join(dataDirectory, "solera", "fl-titling"), { recursive: true });
    await mkdir(join(dataDirectory, "solera", "other-product"), { recursive: true });
    const stores = new Map([
      ["fl-titling", projectionStore([projectionRecord("fl-record")])],
      ["other-product", projectionStore([{
        ...projectionRecord("other-record"),
        productId: "other-product"
      }])]
    ]);
    const syncSource = createSourceSyncRunner({
      tenantId: "solera",
      knowledgeService: {
        async ingest(records) {
          return { ingestedRecords: records.length };
        }
      },
      dataDirectory,
      rawStoreFactory: ({ productId }) => stores.get(productId)
    });

    const results = await syncSource.resumeAllPendingProjections();

    assert.deepEqual(
      results.map((result) => result.productId).sort(),
      ["fl-titling", "other-product"]
    );
    assert.equal(stores.get("fl-titling").countPendingProjectionRecords(), 0);
    assert.equal(stores.get("other-product").countPendingProjectionRecords(), 0);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("translates coordinator external cancellation without exposing abort reasons", async () => {
  const store = projectionStore([projectionRecord("salvaged-before-cancel")]);
  let projected = 0;
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        projected += records.length;
        return { ingestedRecords: records.length };
      }
    },
    dataDirectory: "unused",
    rawStoreFactory: () => store,
    composeConnectorsImpl: () => ({}),
    coordinatorFactory: () => successfulCoordinator({
      status: "failed",
      connectors: [{
        status: "failed",
        error: { stage: "collect", name: "SyncCancelledError", code: "sync_cancelled" }
      }]
    })
  });

  await assert.rejects(
    () => syncSource({
      productId: "fl-titling",
      source: "github",
      config: { repositories: ["owner/repository"] },
      resolveCredential: async () => "synthetic-token",
      signal: AbortSignal.abort(new Error("secret abort detail"))
    }),
    (error) =>
      error instanceof SourceSyncError
      && error.code === "sync_cancelled"
      && error.message === "The synchronization was cancelled."
      && !error.message.includes("secret abort detail")
  );
  const status = await syncSource.resumePendingProjections({ productId: "fl-titling" });
  assert.equal(projected, 1);
  assert.equal(status.pendingRecords, 0);
});

test("retrieves one Jira issue without advancing the full-sync checkpoint", async () => {
  const committed = [];
  const acknowledged = [];
  const ingested = [];
  const store = {
    async commit(request) {
      committed.push(request);
      return {
        committedCount: request.records.length,
        duplicateCount: 0,
        committedIdempotencyKeys: request.records.map((record) => record.idempotencyKey)
      };
    },
    async acknowledgeProjected(keys) {
      acknowledged.push(...keys);
    }
  };
  const jiraRecords = [
    {
      ...projectionRecord("STT-1234"),
      source: "jira",
      contentType: "jira.issue",
      idempotencyKey: "jira:STT-1234:1"
    },
    {
      ...projectionRecord("comment-1"),
      source: "jira",
      contentType: "jira.comment",
      idempotencyKey: "jira:STT-1234:comment-1"
    }
  ];
  let composedConfiguration;
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        ingested.push(...records);
      }
    },
    dataDirectory: "unused",
    allowedHosts: ["jira.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl({ configuration }) {
      composedConfiguration = configuration;
      return {
        getPlugin() {
          return {
            async *collect() {
              yield* jiraRecords;
            }
          };
        }
      };
    }
  });

  const result = await syncSource.retrieveJiraIssue({
    productId: "fl-titling",
    issueKey: "stt-1234",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    },
    resolveCredential: async () => "synthetic-token"
  });

  assert.equal(composedConfiguration.sources.jira.issueKey, "STT-1234");
  assert.equal(composedConfiguration.sources.jira.jql, "project = STT");
  assert.equal(committed[0].connectorId, "connector.jira.on-demand");
  assert.equal(committed[0].checkpoint, undefined);
  assert.deepEqual(ingested, jiraRecords);
  assert.deepEqual(acknowledged, jiraRecords.map((record) => record.idempotencyKey));
  assert.deepEqual(result, {
    productId: "fl-titling",
    issueKey: "STT-1234",
    status: "complete",
    recordsCollected: 2,
    recordsCommitted: 2,
    duplicateRecords: 0,
    truncated: false
  });
});

test("retrieves and projects one exact TestRail case", async () => {
  const committed = [];
  const ingested = [];
  const record = {
    ...projectionRecord("1201"),
    source: "testrail",
    contentType: "testrail.case",
    idempotencyKey: "testrail:1201:1",
    payload: { id: 1201, title: "Verify title", refs: "STT-3731" }
  };
  const store = {
    async commit(request) {
      committed.push(request);
      return {
        committedCount: 1,
        duplicateCount: 0,
        committedIdempotencyKeys: [record.idempotencyKey]
      };
    },
    async acknowledgeProjected() {}
  };
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest(records) {
        ingested.push(...records);
      }
    },
    dataDirectory: "unused",
    allowedHosts: ["testrail.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl() {
      return {
        getPlugin() {
          return {
            async *collectCase(caseId) {
              assert.equal(caseId, "1201");
              yield record;
            }
          };
        }
      };
    }
  });

  const result = await syncSource.retrieveTestRailCase({
    productId: "fl-titling",
    caseId: "C001201",
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.test",
      projectId: "128",
      suiteScope: "selected",
      suiteIds: ["12"]
    },
    resolveCredential: async () => "synthetic-token"
  });

  assert.equal(committed[0].connectorId, "connector.testrail.on-demand");
  assert.deepEqual(ingested, [record]);
  assert.equal(result.caseId, "1201");
  assert.equal(result.recordsCollected, 1);
});

test("targeted Jira retrieval stops before requesting beyond its record budget", async () => {
  let yieldedRecords = 0;
  const store = {
    async commit(request) {
      return {
        committedCount: request.records.length,
        duplicateCount: 0,
        committedIdempotencyKeys: request.records.map((record) => record.idempotencyKey)
      };
    },
    async acknowledgeProjected() {}
  };
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: { async ingest() {} },
    dataDirectory: "unused",
    allowedHosts: ["jira.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl() {
      return {
        getPlugin() {
          return {
            async *collect() {
              yieldedRecords += 1;
              yield {
                ...projectionRecord("STT-1234"),
                source: "jira",
                contentType: "jira.issue",
                idempotencyKey: "jira:STT-1234:1"
              };
              yieldedRecords += 1;
              yield {
                ...projectionRecord("comment-1"),
                source: "jira",
                contentType: "jira.comment",
                idempotencyKey: "jira:STT-1234:comment-1"
              };
            }
          };
        }
      };
    }
  });

  const result = await syncSource.retrieveJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    },
    resolveCredential: async () => "synthetic-token",
    maxRecords: 1
  });

  assert.equal(yieldedRecords, 1);
  assert.equal(result.recordsCollected, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.status, "partial");
});

test("targeted Jira retrieval does not reproject an acknowledged duplicate", async () => {
  let ingested = 0;
  const record = {
    ...projectionRecord("STT-1234"),
    source: "jira",
    contentType: "jira.issue",
    idempotencyKey: "jira:STT-1234:1"
  };
  const store = {
    async commit() {
      return {
        committedCount: 0,
        duplicateCount: 1,
        committedIdempotencyKeys: []
      };
    },
    hasPendingProjection() {
      return false;
    },
    async acknowledgeProjected() {}
  };
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest() {
        ingested += 1;
      }
    },
    dataDirectory: "unused",
    allowedHosts: ["jira.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl() {
      return {
        getPlugin() {
          return {
            async *collect() {
              yield record;
            }
          };
        }
      };
    }
  });

  const result = await syncSource.retrieveJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    },
    resolveCredential: async () => "synthetic-token"
  });

  assert.equal(result.duplicateRecords, 1);
  assert.equal(ingested, 0);
});

test("targeted Jira projection serializes behind the active product projector", async () => {
  const store = projectionStore([projectionRecord("background")]);
  store.commit = async ({ records }) => {
    store.pending.push(...records);
    return {
      committedCount: records.length,
      duplicateCount: 0,
      committedIdempotencyKeys: records.map((record) => record.idempotencyKey)
    };
  };
  let active = 0;
  let maxActive = 0;
  let releaseBackground;
  const backgroundGate = new Promise((resolve) => {
    releaseBackground = resolve;
  });
  let backgroundStarted;
  const started = new Promise((resolve) => {
    backgroundStarted = resolve;
  });
  let calls = 0;
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: {
      async ingest() {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          backgroundStarted();
          await backgroundGate;
        }
        active -= 1;
      }
    },
    dataDirectory: "unused",
    backgroundProjectionBatchSize: 1,
    allowedHosts: ["jira.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl() {
      return {
        getPlugin() {
          return {
            async *collect() {
              yield {
                ...projectionRecord("STT-1234"),
                source: "jira",
                contentType: "jira.issue",
                idempotencyKey: "jira:STT-1234:1"
              };
            }
          };
        }
      };
    }
  });

  const background = syncSource.resumePendingProjections({ productId: "fl-titling" });
  await started;
  const targeted = syncSource.retrieveJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    },
    resolveCredential: async () => "synthetic-token"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  releaseBackground();
  await Promise.all([background, targeted]);
  assert.equal(maxActive, 1);
});

test("targeted Jira retrieval enforces the remote collection deadline", async () => {
  const store = {
    async commit(request) {
      return {
        committedCount: request.records.length,
        duplicateCount: 0,
        committedIdempotencyKeys: request.records.map((record) => record.idempotencyKey)
      };
    },
    async acknowledgeProjected() {}
  };
  const syncSource = createSourceSyncRunner({
    tenantId: "solera",
    knowledgeService: { async ingest() {} },
    dataDirectory: "unused",
    allowedHosts: ["jira.example"],
    rawStoreFactory: () => store,
    composeConnectorsImpl() {
      return {
        getPlugin() {
          return {
            async *collect(_checkpoint, { signal }) {
              await new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            }
          };
        }
      };
    }
  });

  await assert.rejects(
    () => syncSource.retrieveJiraIssue({
      productId: "fl-titling",
      issueKey: "STT-1234",
      config: {
        baseUrl: "https://jira.example",
        allowedProjects: ["STT"],
        allowedJql: "project = STT"
      },
      resolveCredential: async () => "synthetic-token",
      timeoutMs: 20
    }),
    (error) =>
      error instanceof SourceSyncError
      && error.code === "retrieval_timeout"
  );
});
