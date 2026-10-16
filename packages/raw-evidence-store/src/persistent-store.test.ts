import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RawEvidenceRecord } from "@tkl/contracts";
import {
  createPersistentRawEvidenceStore,
  isUnsupportedDirectorySyncError,
  nodeFsOperations,
  PersistentRawEvidenceStore,
  type PersistFsOperations,
} from "./persistent-store.ts";
import { decryptEnvelope, encryptEnvelope, type KeyResolver } from "./crypto.ts";

const KEY_REF = "secret://raw-evidence/fl-titling";

function withTemporaryDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "tkl-raw-evidence-store-"));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

function fixedKeyResolver(material: Buffer = randomBytes(32)): KeyResolver {
  return () => material;
}

function record(overrides: Partial<RawEvidenceRecord> = {}): RawEvidenceRecord {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-1234",
    sourceVersion: "3",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "application/json",
    contentHash: "hash-abc",
    payload: { summary: "A sanitized fixture requirement" },
    classification: "internal",
    ...overrides,
  };
}

async function openStore(
  directory: string,
  resolveKey: KeyResolver,
  options: {
    projectionFailureThreshold?: number;
    now?: () => string;
    fsOperations?: PersistFsOperations;
  } = {},
) {
  return createPersistentRawEvidenceStore({
    dataDirectory: directory,
    tenantId: "solera",
    productId: "fl-titling",
    keyRef: KEY_REF,
    resolveKey,
    ...options,
  });
}

function persistencePaths(directory: string, sequence = 1) {
  const scopeDirectory = join(directory, "solera", "fl-titling");
  const storagePath = join(scopeDirectory, "raw-evidence-store.json");
  const transactionDirectory = join(scopeDirectory, "raw-evidence-store.chunks");
  const transactionTempPath = join(transactionDirectory, "pending.json.tmp");
  return {
    scopeDirectory,
    storagePath,
    legacyTempPath: `${storagePath}.tmp`,
    transactionDirectory,
    transactionTempPath,
    transactionRejectedMarkerPath: `${transactionTempPath}.rejected`,
    transactionPath: join(
      transactionDirectory,
      `${String(sequence).padStart(16, "0")}.json`,
    ),
  };
}

function writeLegacySnapshot(
  directory: string,
  key: Buffer,
  records: RawEvidenceRecord[] = [record()],
  checkpoint: Record<string, unknown> | null = { cursor: "STT-1234" },
): string {
  const paths = persistencePaths(directory);
  mkdirSync(paths.scopeDirectory, { recursive: true });
  const persistedRecords = records.map((item) => ({
    idempotencyKey:
      item.idempotencyKey ?? `${item.source}:${item.sourceId}:${item.sourceVersion}`,
    connectorId: "connector-jira",
    record: item,
  }));
  const envelope = encryptEnvelope(
    {
      records: persistedRecords,
      checkpoints: checkpoint ? { "connector-jira": checkpoint } : {},
      history: records.length === 0
        ? []
        : [{
            id: "history:1",
            connectorId: "connector-jira",
            operation: "commit",
            recordCount: records.length,
            committedCount: records.length,
            duplicateCount: 0,
            recordedAt: "2026-09-10T00:00:00.000Z",
          }],
    },
    key,
    {
      tenantId: "solera",
      productId: "fl-titling",
      schemaVersion: 1,
      keyRef: KEY_REF,
    },
  );
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  writeFileSync(paths.storagePath, serialized, "utf-8");
  return serialized;
}

function writeTransaction(
  directory: string,
  key: Buffer,
  transaction: Record<string, unknown> & { sequence: number },
): void {
  const paths = persistencePaths(directory, transaction.sequence);
  mkdirSync(paths.transactionDirectory, { recursive: true });
  const envelope = encryptEnvelope(transaction, key, {
    tenantId: "solera",
    productId: "fl-titling",
    schemaVersion: 1,
    keyRef: KEY_REF,
  });
  writeFileSync(paths.transactionPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
}

function readTransaction(
  directory: string,
  key: Buffer,
  sequence: number,
): Record<string, unknown> {
  const envelope = JSON.parse(
    readFileSync(persistencePaths(directory, sequence).transactionPath, "utf-8"),
  );
  return decryptEnvelope(envelope, key) as Record<string, unknown>;
}

/**
 * Asserts a rejected commit's temp snapshot is never resurrected by a
 * restart: either startup fails closed (refuses to start at all) or it
 * starts up with the rejected record never having been promoted. Both
 * outcomes are acceptable "no resurrection" results -- which one occurs can
 * legitimately depend on whether the rejected-temp marker happened to be
 * durable at the moment of the crash/failure being simulated, and this
 * helper intentionally does not assume either path.
 */
async function assertNeverResurrectsRejectedCommit(
  directory: string,
  resolveKey: KeyResolver,
  previouslyDurableRecordCount: number,
): Promise<void> {
  try {
    const restarted = await openStore(directory, resolveKey);
    assert.equal(restarted.listRecords().length, previouslyDurableRecordCount);
  } catch {
    // A closed (refused) startup is an acceptable, explicitly fail-closed
    // form of "never resurrects".
  }
}

test("commits durably, resumes after restart, and resumes the connector checkpoint", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    await first.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(restarted.listRecords()[0].payload, { summary: "A sanitized fixture requirement" });
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
    assert.equal(restarted.history("connector-jira").length, 1);
  }));

test("large durable replay yields cooperatively while reconstructing identical state", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const seed = await openStore(directory, fixedKeyResolver(key));
    const total = 25;
    for (let index = 0; index < total; index += 1) {
      await seed.commit({
        connectorId: "connector-jira",
        records: [record({
          sourceId: `STT-${index}`,
          contentHash: `hash-${index}`,
        })],
        checkpoint: { cursor: `STT-${index}` },
      });
    }

    // Control open reconstructs the canonical durable state (default yield).
    const control = await openStore(directory, fixedKeyResolver(key));
    const controlSourceIds = control.listRecords().map((item) => item.sourceId);

    // Instrumented open: small yield interval + injected counting yield proves
    // the replay returns control to the event loop while replaying many chunks.
    let yields = 0;
    const instrumented = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      replayYieldInterval: 5,
      replayYield: () => {
        yields += 1;
      },
    });

    assert.ok(
      yields >= Math.floor(total / 5) - 1,
      `expected several cooperative yields during replay, saw ${yields}`,
    );
    assert.deepEqual(instrumented.listRecords().map((item) => item.sourceId), controlSourceIds);
    assert.equal(instrumented.listRecords().length, total);
    assert.equal(
      instrumented.countPendingProjectionRecords(),
      control.countPendingProjectionRecords(),
    );
    assert.deepEqual(instrumented.getCheckpoint("connector-jira"), {
      cursor: `STT-${total - 1}`,
    });
  }));

test("replayYieldInterval must be a positive integer", () =>
  withTemporaryDirectory(async (directory) => {
    assert.throws(
      () =>
        new PersistentRawEvidenceStore({
          dataDirectory: directory,
          tenantId: "solera",
          productId: "fl-titling",
          keyRef: KEY_REF,
          resolveKey: fixedKeyResolver(),
          replayYieldInterval: 0,
        }),
      /replayYieldInterval must be a positive integer/,
    );
  }));

test("persists projection outbox entries and acknowledgements across restarts", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    const committed = await first.commit({
      connectorId: "connector-jira",
      records: [record({ idempotencyKey: "jira:STT-1234:3" })],
      checkpoint: { cursor: "STT-1234" },
    });
    assert.deepEqual(committed.committedIdempotencyKeys, ["jira:STT-1234:3"]);

    const pendingRestart = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(
      pendingRestart.listPendingProjectionRecords().map((item) => item.sourceId),
      ["STT-1234"],
    );
    await pendingRestart.acknowledgeProjected(["jira:STT-1234:3"]);

    const acknowledgedRestart = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(acknowledgedRestart.listPendingProjectionRecords(), []);
    assert.deepEqual(acknowledgedRestart.getCheckpoint("connector-jira"), {
      cursor: "STT-1234",
    });
  }));

test("persists sanitized projection failures, DLQ state, and requeue across restarts", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const clock = [
      "2026-09-14T10:00:00.000Z",
      "2026-09-14T10:01:00.000Z",
      "2026-09-14T10:02:00.000Z",
      "2026-09-14T10:03:00.000Z",
      "2026-09-14T10:04:00.000Z",
    ];
    const first = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 2,
      now: () => clock.shift() ?? "2026-09-14T10:05:00.000Z",
    });
    await first.commit({
      connectorId: "connector-jira",
      records: [record({ idempotencyKey: "jira:poison:3" })],
    });
    await first.recordProjectionFailures(["jira:poison:3"]);

    const pendingRestart = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 2,
      now: () => clock.shift() ?? "2026-09-14T10:05:00.000Z",
    });
    assert.equal(pendingRestart.countPendingProjectionRecords(), 1);
    await pendingRestart.recordProjectionFailures(["jira:poison:3"]);

    const deadLetterRestart = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 2,
    });
    assert.equal(deadLetterRestart.countPendingProjectionRecords(), 0);
    assert.equal(deadLetterRestart.countDeadLetterProjectionRecords(), 1);
    const [failure] = deadLetterRestart.listDeadLetterProjectionRecords();
    assert.equal(failure.failureCode, "projection-failed");
    assert.equal(failure.attemptCount, 2);
    assert.equal("message" in failure, false);
    assert.equal(await deadLetterRestart.requeueDeadLetterProjectionRecords(["jira:poison:3"]), 1);

    const requeuedRestart = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 2,
    });
    assert.equal(requeuedRestart.countDeadLetterProjectionRecords(), 0);
    assert.deepEqual(
      requeuedRestart.listPendingProjectionRecords().map((item) => item.sourceId),
      ["STT-1234"],
    );
  }));

test("reads legacy v1 commits and v2 projection acknowledgements", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const legacyRecord = record({ idempotencyKey: "jira:legacy:1" });
    writeTransaction(directory, key, {
      kind: "raw-evidence-transaction",
      transactionVersion: 1,
      sequence: 1,
      connectorId: "connector-jira",
      records: [{
        idempotencyKey: "jira:legacy:1",
        connectorId: "connector-jira",
        record: legacyRecord,
      }],
      checkpoint: { operation: "unchanged" },
      history: {
        id: "history:1",
        connectorId: "connector-jira",
        operation: "commit",
        recordCount: 1,
        committedCount: 1,
        duplicateCount: 0,
        recordedAt: "2026-09-10T00:00:00.000Z",
      },
    });

    const afterV1 = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(
      afterV1.listPendingProjectionRecords().map((item) => item.idempotencyKey),
      ["jira:legacy:1"],
    );

    writeTransaction(directory, key, {
      kind: "raw-evidence-projection-ack",
      transactionVersion: 2,
      sequence: 2,
      idempotencyKeys: ["jira:legacy:1"],
    });
    const afterV2 = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(afterV2.listRecords().map((item) => item.idempotencyKey), ["jira:legacy:1"]);
    assert.deepEqual(afterV2.listPendingProjectionRecords(), []);
  }));

test("emits legacy kinds at v2 and projection failure/requeue kinds at v3", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 1,
      now: () => "2026-09-14T10:00:00.000Z",
    });
    await store.commit({
      connectorId: "connector-jira",
      records: [record({ idempotencyKey: "jira:versioned:1" })],
    });
    await store.recordProjectionFailures(["jira:versioned:1"]);
    await store.requeueDeadLetterProjectionRecords(["jira:versioned:1"]);
    await store.acknowledgeProjected(["jira:versioned:1"]);

    assert.deepEqual(
      [1, 2, 3, 4].map((sequence) => {
        const transaction = readTransaction(directory, key, sequence);
        return [transaction.kind, transaction.transactionVersion];
      }),
      [
        ["raw-evidence-transaction", 2],
        ["raw-evidence-projection-failure", 3],
        ["raw-evidence-projection-requeue", 3],
        ["raw-evidence-projection-ack", 2],
      ],
    );
  }));

test("rejects transaction versions that are incompatible with their kind", async () => {
  for (const transaction of [
    {
      kind: "raw-evidence-projection-failure",
      transactionVersion: 2,
      sequence: 2,
      failures: [{
        idempotencyKey: "jira:versioned:1",
        connectorId: "connector-jira",
        failureCode: "projection-failed",
        attemptCount: 1,
        firstFailedAt: "2026-09-14T10:00:00.000Z",
        lastFailedAt: "2026-09-14T10:00:00.000Z",
        deadLettered: false,
      }],
    },
    {
      kind: "raw-evidence-projection-requeue",
      transactionVersion: 2,
      sequence: 2,
      idempotencyKeys: ["jira:versioned:1"],
    },
    {
      kind: "raw-evidence-projection-ack",
      transactionVersion: 3,
      sequence: 2,
      idempotencyKeys: ["jira:versioned:1"],
    },
  ]) {
    await withTemporaryDirectory(async (directory) => {
      const key = randomBytes(32);
      const seed = await openStore(directory, fixedKeyResolver(key));
      await seed.commit({
        connectorId: "connector-jira",
        records: [record({ idempotencyKey: "jira:versioned:1" })],
      });
      writeTransaction(directory, key, transaction);

      await assert.rejects(
        () => openStore(directory, fixedKeyResolver(key)),
        new RegExp(`kind "${transaction.kind}" is not supported at version `
          + `${transaction.transactionVersion}`),
      );
    });
  }
});

test("an acknowledgement persistence failure propagates without changing pending or DLQ state", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const seed = await openStore(directory, fixedKeyResolver(key));
    await seed.commit({
      connectorId: "connector-jira",
      records: [record({ idempotencyKey: "jira:ack-failure:1" })],
    });

    const store = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 1,
      fsOperations: {
        ...nodeFsOperations,
        async writeFileDurable() {
          throw new Error("acknowledgement write failed");
        },
      },
    });
    await assert.rejects(
      () => store.acknowledgeProjected(["jira:ack-failure:1"]),
      /acknowledgement write failed/,
    );

    assert.deepEqual(
      store.listPendingProjectionRecords().map((item) => item.idempotencyKey),
      ["jira:ack-failure:1"],
    );
    assert.equal(store.countDeadLetterProjectionRecords(), 0);
    assert.deepEqual(store.listDeadLetterProjectionRecords(), []);

    const restarted = await openStore(directory, fixedKeyResolver(key), {
      projectionFailureThreshold: 1,
    });
    assert.deepEqual(
      restarted.listPendingProjectionRecords().map((item) => item.idempotencyKey),
      ["jira:ack-failure:1"],
    );
    assert.equal(restarted.countDeadLetterProjectionRecords(), 0);
  }));

test("loads an existing legacy base snapshot, appends encrypted chunks, and never rewrites the base", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const legacyBytes = writeLegacySnapshot(directory, key);
    const store = await openStore(directory, fixedKeyResolver(key));

    assert.deepEqual(store.listRecords().map((item) => item.sourceId), ["STT-1234"]);
    await store.commit({
      connectorId: "connector-jira",
      records: [record({
        sourceId: "STT-5678",
        sourceVersion: "1",
        idempotencyKey: "jira:STT-5678:1",
      })],
      checkpoint: { cursor: "page-2" },
    });

    const paths = persistencePaths(directory);
    assert.equal(readFileSync(paths.storagePath, "utf-8"), legacyBytes);
    assert.equal(existsSync(paths.transactionPath), true);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(
      restarted.listRecords().map((item) => item.sourceId),
      ["STT-1234", "STT-5678"],
    );
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "page-2" });
    assert.equal(restarted.history().length, 2);
  }));

test("replays a valid pending encrypted transaction after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await store.commit({
      connectorId: "connector-jira",
      records: [record({ sourceId: "STT-1", idempotencyKey: "jira:STT-1" })],
      checkpoint: { cursor: "page-1" },
    });
    await store.commit({
      connectorId: "connector-jira",
      records: [record({ sourceId: "STT-2", idempotencyKey: "jira:STT-2" })],
      checkpoint: { cursor: "page-2" },
    });

    const paths = persistencePaths(directory, 2);
    renameSync(paths.transactionPath, paths.transactionTempPath);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(
      restarted.listRecords().map((item) => item.sourceId),
      ["STT-1", "STT-2"],
    );
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "page-2" });
    assert.equal(existsSync(paths.transactionTempPath), false);
    assert.equal(existsSync(paths.transactionPath), true);
  }));

test("many commits remain bounded independent chunks and never create a monolithic snapshot", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    const commitCount = 40;

    for (let index = 1; index <= commitCount; index += 1) {
      await store.commit({
        connectorId: "connector-jira",
        records: [record({
          sourceId: `STT-${index}`,
          sourceVersion: "1",
          idempotencyKey: `jira:STT-${index}:1`,
        })],
        checkpoint: { cursor: `page-${index}` },
      });
    }

    const paths = persistencePaths(directory);
    const chunkFiles = readdirSync(paths.transactionDirectory)
      .filter((name) => /^\d{16}\.json$/.test(name))
      .sort();
    assert.equal(existsSync(paths.storagePath), false);
    assert.equal(chunkFiles.length, commitCount);
    for (const fileName of chunkFiles) {
      assert.ok(readFileSync(join(paths.transactionDirectory, fileName)).byteLength < 10_000);
    }

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, commitCount);
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: `page-${commitCount}` });
    assert.equal(restarted.history().length, commitCount);
  }));

test("replaying an identical record after restart is a no-op counted as a duplicate", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    await first.commit({ connectorId: "connector-jira", records: [record()] });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    const result = await restarted.commit({ connectorId: "connector-jira", records: [record()] });

    assert.equal(result.committedCount, 0);
    assert.equal(result.duplicateCount, 1);
    assert.equal(restarted.listRecords().length, 1);
  }));

test("replaying the same key/content after restart with only a different observedAt is a duplicate, and the checkpoint still durably advances", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    await first.commit({
      connectorId: "connector-jira",
      records: [record({ observedAt: "2026-09-10T00:00:00.000Z" })],
      checkpoint: { cursor: "page-1" },
    });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    const result = await restarted.commit({
      connectorId: "connector-jira",
      records: [record({ observedAt: "2026-09-11T00:00:00.000Z" })],
      checkpoint: { cursor: "page-2" },
    });

    assert.equal(result.committedCount, 0);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.checkpointAdvanced, true);
    assert.deepEqual(result.checkpoint, { cursor: "page-2" });
    assert.equal(restarted.listRecords().length, 1);

    const restartedAgain = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restartedAgain.listRecords().length, 1);
    assert.deepEqual(restartedAgain.getCheckpoint("connector-jira"), { cursor: "page-2" });
  }));

test("the same idempotency key with different content fails explicitly after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    await first.commit({ connectorId: "connector-jira", records: [record()] });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    await assert.rejects(() => restarted.commit({
      connectorId: "connector-jira",
      records: [record({ payload: { summary: "Different sanitized content" } })],
    }));
    assert.equal(restarted.listRecords().length, 1);
  }));

test("physically isolates tenant and product snapshots on disk", () =>
  withTemporaryDirectory(async (directory) => {
    const resolveKey = fixedKeyResolver();
    const flStore = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
    });
    const otherStore = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "other-product",
      keyRef: KEY_REF,
      resolveKey,
    });

    await flStore.commit({ connectorId: "connector-jira", records: [record()] });

    assert.notEqual(flStore.storagePath, otherStore.storagePath);
    assert.equal(otherStore.listRecords().length, 0);
  }));

test("rolls back the entire commit, including the checkpoint, when durable persistence fails", () =>
  withTemporaryDirectory(async (directory) => {
    const store = await openStore(directory, fixedKeyResolver());
    await store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });
    const durablePath = persistencePaths(directory).transactionPath;
    const before = readFileSync(durablePath, "utf-8");

    // Simulate a durable-write failure (for example a full disk or a transient
    // secret-manager failure encountered while re-resolving the key to encrypt).
    (store as unknown as { persistTransaction: () => Promise<void> }).persistTransaction = async () => {
      throw new Error("simulated durable write failure");
    };

    await assert.rejects(() => store.commit({
      connectorId: "connector-jira",
      records: [record({ sourceId: "STT-9999" })],
      checkpoint: { cursor: "STT-9999" },
    }));

    assert.equal(store.listRecords().length, 1);
    assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
    assert.equal(readFileSync(durablePath, "utf-8"), before);
  }));

test("quarantines the temp file after a deterministic rename failure, so the rejected commit cannot promote after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;

    // Deterministically force the temp-write-then-rename boundary to fail at
    // the rename step: a pre-existing directory at the durable file's path
    // makes `renameSync` throw (this is the first-ever commit, so there is no
    // prior durable snapshot to protect — only the temp write must not leak).
    mkdirSync(paths.transactionPath, { recursive: true });

    await assert.rejects(() => store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    }));

    // The temp file must have been quarantined (removed), not left behind for
    // a future `initialize()` to authenticate and promote.
    assert.equal(existsSync(tempPath), false);
    assert.equal(store.listRecords().length, 0);
    assert.equal(store.getCheckpoint("connector-jira"), undefined);

    // Clear the blocking directory and restart: the rejected transaction must
    // not have been durably committed or promoted.
    rmSync(paths.transactionPath, { recursive: true, force: true });
    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 0);
    assert.equal(restarted.getCheckpoint("connector-jira"), undefined);
  }));

test("quarantines the temp file after a deterministic temp-write failure, so the rejected commit cannot promote after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;

    // Deterministically force the write step itself to fail: a pre-existing
    // directory at the temp file's path makes `writeFileSync` throw before
    // any rename is attempted.
    mkdirSync(tempPath, { recursive: true });

    await assert.rejects(() => store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    }));

    // The blocking directory must have been quarantined (removed) rather than
    // left behind.
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(paths.transactionPath), false);
    assert.equal(store.listRecords().length, 0);
    assert.equal(store.getCheckpoint("connector-jira"), undefined);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 0);
    assert.equal(restarted.getCheckpoint("connector-jira"), undefined);
  }));

test("when quarantine's temp-file removal itself fails after a rejected commit, the rejected temp cannot be promoted on restart even though it was never removed", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const resolveKey = fixedKeyResolver(key);

    // Seed one durable, successful commit -- this is the only state that
    // must survive.
    const seed = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
    });
    await seed.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "page-1" },
    });
    const paths = persistencePaths(directory);
    const durableAfterFirstCommit = readFileSync(paths.transactionPath, "utf-8");
    const tempPath = paths.transactionTempPath;
    const rejectedMarkerPath = paths.transactionRejectedMarkerPath;

    // A second store instance whose rename always fails (simulating, for
    // example, a full disk encountered mid-promotion) *and* whose temp-file
    // removal always fails too (simulating a file a locked/AV-scanned file on
    // Windows, or a permissions error) -- so quarantine's best-effort cleanup
    // cannot remove the leftover temp file, and it survives on disk exactly
    // like a genuine crash-before-rename leftover would.
    const lockedFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        throw new Error("simulated rename failure (disk full)");
      },
      syncDirectory: async (path) => {
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async () => {
        throw Object.assign(new Error("simulated EBUSY: temp file is locked"), { code: "EBUSY" });
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
      fsOperations: lockedFsOperations,
    });

    await assert.rejects(
      () => store.commit({
        connectorId: "connector-jira",
        records: [record({ sourceId: "STT-9999" })],
        checkpoint: { cursor: "page-2" },
      }),
      /simulated rename failure/,
    );

    // The commit was rejected: in-memory state must reflect only the first,
    // durable commit.
    assert.equal(store.listRecords().length, 1);
    assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "page-1" });
    assert.equal(readFileSync(paths.transactionPath, "utf-8"), durableAfterFirstCommit);

    // Quarantine's removal failed (as configured), so the rejected temp file
    // -- and the tombstone marker recording that it belongs to an explicitly
    // rejected commit -- both survive on disk. Without the marker, this is
    // indistinguishable from a genuine crash-before-rename leftover, which
    // `recoverTemporarySnapshot` would otherwise authenticate and promote.
    assert.equal(existsSync(tempPath), true);
    assert.equal(existsSync(rejectedMarkerPath), true);

    // Restart (a new store instance, as a real process restart would be) with
    // ordinary filesystem operations -- the transient lock/full-disk
    // condition that blocked cleanup the first time is no longer present.
    // Startup recovery must still refuse to promote the leftover temp file
    // because of the marker, not merely because this particular retry of
    // cleanup happens to succeed: the rejected transaction must never be
    // resurrected.
    const restarted = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
    });

    assert.equal(restarted.listRecords().length, 1);
    assert.deepEqual(restarted.listRecords()[0].sourceId, "STT-1234");
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "page-1" });
    assert.equal(readFileSync(paths.transactionPath, "utf-8"), durableAfterFirstCommit);

    // Recovery's own cleanup succeeded this time (the lock is gone), so both
    // the leftover temp file and its tombstone marker are gone afterward.
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(rejectedMarkerPath), false);
  }));

test("when both the rejected temp file and its cleanup keep failing, startup fails closed rather than guessing", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const resolveKey = fixedKeyResolver(key);
    const seed = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
    });
    await seed.commit({ connectorId: "connector-jira", records: [record()] });

    const paths = persistencePaths(directory, 2);
    const tempPath = paths.transactionTempPath;
    const rejectedMarkerPath = paths.transactionRejectedMarkerPath;
    const alwaysLockedFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        throw new Error("simulated rename failure (disk full)");
      },
      syncDirectory: async (path) => {
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async () => {
        throw Object.assign(new Error("simulated EBUSY: temp file is locked"), { code: "EBUSY" });
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey,
      fsOperations: alwaysLockedFsOperations,
    });
    await assert.rejects(() => store.commit({
      connectorId: "connector-jira",
      records: [record({ sourceId: "STT-9999" })],
    }));
    assert.equal(existsSync(tempPath), true);
    assert.equal(existsSync(rejectedMarkerPath), true);

    // The lock never clears: restarting with filesystem operations that
    // still cannot remove the temp file must fail closed (refuse to start)
    // instead of silently promoting the rejected temp file or silently
    // discarding the marker and pretending nothing happened.
    await assert.rejects(
      () => createPersistentRawEvidenceStore({
        dataDirectory: directory,
        tenantId: "solera",
        productId: "fl-titling",
        keyRef: KEY_REF,
        resolveKey,
        fsOperations: alwaysLockedFsOperations,
      }),
      /rejected commit|could not be removed/,
    );

    // Both the temp file and the marker are still present: nothing was
    // silently promoted or silently discarded.
    assert.equal(existsSync(tempPath), true);
    assert.equal(existsSync(rejectedMarkerPath), true);
  }));

test("quarantine durably establishes the rejected marker -- write, flush, then directory sync -- before attempting temp removal, and both are gone once cleanup succeeds", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const calls: Array<{ op: string; path: string }> = [];
    const spyFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        calls.push({ op: "writeFileDurable", path });
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        calls.push({ op: "rename", path: oldPath });
        void newPath;
        throw new Error("simulated rename failure");
      },
      syncDirectory: async (path) => {
        calls.push({ op: "syncDirectory", path });
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        calls.push({ op: "removeTempFile", path });
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations: spyFsOperations,
    });
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;
    const markerPath = paths.transactionRejectedMarkerPath;
    const scopeDirectory = paths.transactionDirectory;

    await assert.rejects(
      () => store.commit({ connectorId: "connector-jira", records: [record()] }),
      /simulated rename failure/,
    );

    // The temp write and the (failing) rename happen first, then quarantine
    // durably establishes the rejected marker -- write, flush, then
    // directory sync, strictly in that order -- and only then attempts to
    // remove and directory-sync the temp file, then remove and sync the
    // marker so neither deletion can be reordered across a crash.
    assert.deepEqual(
      calls.map((call) => call.op),
      [
        "writeFileDurable",
        "rename",
        "writeFileDurable",
        "syncDirectory",
        "removeTempFile",
        "syncDirectory",
        "syncDirectory",
      ],
    );
    assert.equal(calls[0].path, tempPath);
    assert.equal(calls[2].path, markerPath);
    assert.equal(calls[3].path, scopeDirectory);
    assert.equal(calls[4].path, tempPath);

    // Cleanup succeeded, so the marker no longer guards anything and both
    // files are gone afterward.
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(markerPath), false);
  }));

test("when the marker's flush fails and temp removal also fails, quarantine falls back to durably poisoning the temp file so a restart never resurrects the rejected commit", () =>
  withTemporaryDirectory(async (directory) => {
    const paths = persistencePaths(directory);
    const storagePath = paths.storagePath;
    const tempPath = paths.transactionTempPath;
    const markerPath = paths.transactionRejectedMarkerPath;
    const key = randomBytes(32);
    const fsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        if (path === markerPath) {
          throw Object.assign(new Error("simulated marker flush failure (EIO)"), { code: "EIO" });
        }
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        throw new Error("simulated rename failure (disk full)");
      },
      syncDirectory: async (path) => {
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async () => {
        throw Object.assign(new Error("simulated EBUSY: temp file is locked"), { code: "EBUSY" });
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations,
    });

    await assert.rejects(
      () => store.commit({ connectorId: "connector-jira", records: [record()] }),
      /simulated rename failure/,
    );

    // The marker could never be made durable (its flush always throws), and
    // cleanup never removed the temp file either: no marker exists, but the
    // temp file's own content has been durably overwritten so it can never
    // again pass envelope validation.
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(tempPath), true);
    assert.ok(readFileSync(tempPath, "utf-8").includes("REJECTED-COMMIT-TOMBSTONE"));

    // A restart with ordinary filesystem operations must not silently
    // resurrect the rejected transaction just because no marker survived:
    // the poisoned temp file fails envelope validation, so the store fails
    // closed instead of ever exposing the rejected record.
    await assertNeverResurrectsRejectedCommit(directory, fixedKeyResolver(key), 0);
    assert.equal(existsSync(storagePath), false);
  }));

test("when the marker write succeeds but its directory sync fails, and temp removal also fails, quarantine still durably poisons the temp file so a restart never resurrects the rejected commit", () =>
  withTemporaryDirectory(async (directory) => {
    const paths = persistencePaths(directory);
    const storagePath = paths.storagePath;
    const tempPath = paths.transactionTempPath;
    const markerPath = paths.transactionRejectedMarkerPath;
    const scopeDirectory = paths.transactionDirectory;
    const key = randomBytes(32);
    const calls: string[] = [];
    const fsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        calls.push(
          path === tempPath ? "writeFileDurable:temp"
            : path === markerPath ? "writeFileDurable:marker"
              : "writeFileDurable:other",
        );
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        calls.push("rename");
        throw new Error("simulated rename failure (disk full)");
      },
      syncDirectory: async (path) => {
        calls.push("syncDirectory");
        if (path === scopeDirectory) {
          throw Object.assign(new Error("simulated unexpected directory-sync failure"), { code: "EIO" });
        }
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async () => {
        calls.push("removeTempFile");
        throw Object.assign(new Error("simulated EBUSY: temp file is locked"), { code: "EBUSY" });
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations,
    });

    await assert.rejects(
      () => store.commit({ connectorId: "connector-jira", records: [record()] }),
      /simulated rename failure/,
    );

    // The marker's write succeeded but its directory sync failed, so its
    // existence is not confirmed crash-durable; temp-file removal failed
    // too, so quarantine must still fall back to durably poisoning the temp
    // file's own content as a marker-independent safety net.
    assert.deepEqual(calls, [
      "writeFileDurable:temp",
      "rename",
      "writeFileDurable:marker",
      "syncDirectory",
      "removeTempFile",
      "writeFileDurable:temp",
    ]);
    assert.ok(readFileSync(tempPath, "utf-8").includes("REJECTED-COMMIT-TOMBSTONE"));

    // A restart with ordinary filesystem operations must not resurrect the
    // rejected transaction, whether it is recognized via the (physically
    // present, if not directory-synced) marker or via the poisoned temp
    // content -- either is an acceptable fail-safe outcome.
    await assertNeverResurrectsRejectedCommit(directory, fixedKeyResolver(key), 0);
    assert.equal(existsSync(storagePath), false);
  }));

test("promotes a valid temp snapshot left by a crash between write and rename", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);

    // Simulate a crash after the temp file was written but before the durable
    // rename completed: remove the durable file and put the last known-good
    // temp content back in place.
    renameSync(paths.storagePath, paths.legacyTempPath);

    const recovered = await openStore(directory, fixedKeyResolver(key));
    assert.equal(recovered.listRecords().length, 1);
    assert.equal(existsSync(paths.storagePath), true);
  }));

test("discards a stale temp file when the durable snapshot exists (durable wins)", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);
    writeFileSync(paths.legacyTempPath, "not valid json at all", "utf-8");

    const recovered = await openStore(directory, fixedKeyResolver(key));
    assert.equal(recovered.listRecords().length, 1);
    assert.equal(existsSync(paths.legacyTempPath), false);
  }));

test("preserves both the durable snapshot and a valid temp file, and fails closed, when the durable snapshot is corrupt", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const validContent = writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);

    // Simulate a durable file that was corrupted/truncated on disk (for
    // example a partial write from a different fault) while a valid temp
    // snapshot from a prior successful write is still present. The durable
    // snapshot must be authenticated *before* the temp file is ever touched;
    // since it fails authentication here, both files must be preserved
    // untouched and the store must fail closed rather than discard the only
    // valid snapshot (the temp file) or silently promote it.
    writeFileSync(paths.legacyTempPath, validContent, "utf-8");
    writeFileSync(paths.storagePath, "not valid json at all", "utf-8");

    await assert.rejects(() => openStore(directory, fixedKeyResolver(key)));

    assert.equal(readFileSync(paths.storagePath, "utf-8"), "not valid json at all");
    assert.equal(readFileSync(paths.legacyTempPath, "utf-8"), validContent);
  }));

test("preserves both the durable snapshot and a valid temp file, and fails closed, when the durable snapshot was tampered", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const validContent = writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);

    writeFileSync(paths.legacyTempPath, validContent, "utf-8");

    const envelope = JSON.parse(validContent);
    const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64");
    ciphertextBytes[0] ^= 0xff;
    envelope.ciphertext = ciphertextBytes.toString("base64");
    const tamperedDurable = JSON.stringify(envelope);
    writeFileSync(paths.storagePath, tamperedDurable, "utf-8");

    await assert.rejects(() => openStore(directory, fixedKeyResolver(key)));

    assert.equal(readFileSync(paths.storagePath, "utf-8"), tamperedDurable);
    assert.equal(readFileSync(paths.legacyTempPath, "utf-8"), validContent);
  }));

test("fails closed on a corrupt durable snapshot without rewriting it", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);
    writeFileSync(paths.storagePath, "not valid json at all", "utf-8");
    const before = readFileSync(paths.storagePath, "utf-8");

    await assert.rejects(() => openStore(directory, fixedKeyResolver(key)));
    assert.equal(readFileSync(paths.storagePath, "utf-8"), before);
  }));

test("fails closed when an encrypted transaction chunk was tampered", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const seed = await openStore(directory, fixedKeyResolver(key));
    await seed.commit({ connectorId: "connector-jira", records: [record()] });
    const paths = persistencePaths(directory);
    const envelope = JSON.parse(readFileSync(paths.transactionPath, "utf-8"));
    const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64");
    ciphertextBytes[0] ^= 0xff;
    envelope.ciphertext = ciphertextBytes.toString("base64");
    writeFileSync(paths.transactionPath, JSON.stringify(envelope), "utf-8");
    const before = readFileSync(paths.transactionPath, "utf-8");

    await assert.rejects(() => openStore(directory, fixedKeyResolver(key)));
    assert.equal(readFileSync(paths.transactionPath, "utf-8"), before);
  }));

test("fails closed when opened with the wrong key", () =>
  withTemporaryDirectory(async (directory) => {
    const seed = await openStore(directory, fixedKeyResolver(randomBytes(32)));
    await seed.commit({ connectorId: "connector-jira", records: [record()] });

    await assert.rejects(() => openStore(directory, fixedKeyResolver(randomBytes(32))));
  }));

test("fails closed on a future envelope schema version instead of silently discarding data", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);
    const envelope = JSON.parse(readFileSync(paths.storagePath, "utf-8"));
    envelope.schemaVersion = 99;
    writeFileSync(paths.storagePath, JSON.stringify(envelope), "utf-8");

    await assert.rejects(
      () => openStore(directory, fixedKeyResolver(key)),
      /newer than supported/,
    );
  }));

test("fails closed on a scope mismatch between the durable snapshot and the requested store", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    writeLegacySnapshot(directory, key);
    const paths = persistencePaths(directory);

    // Move the fl-titling snapshot into the other-product scope directory to
    // simulate a cross-scope file placement/copy error.
    const otherScopeDirectory = join(directory, "solera", "other-product");
    mkdirSync(otherScopeDirectory, { recursive: true });
    renameSync(paths.storagePath, join(otherScopeDirectory, "raw-evidence-store.json"));

    await assert.rejects(
      () => createPersistentRawEvidenceStore({
        dataDirectory: directory,
        tenantId: "solera",
        productId: "other-product",
        keyRef: KEY_REF,
        resolveKey: fixedKeyResolver(key),
      }),
      /does not match/,
    );
  }));

test("rejects a missing key resolver result and never falls back to plaintext", () =>
  withTemporaryDirectory(async (directory) => {
    await assert.rejects(() => createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: () => { throw new Error("vault unreachable"); },
    }).then((store) => store.commit({ connectorId: "connector-jira", records: [record()] })));
  }));

test("rejects an invalid keyRef that is not a secret:// or env:// reference", () =>
  withTemporaryDirectory(async (directory) => {
    assert.throws(() => new PersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: "plaintext-key-value",
      resolveKey: fixedKeyResolver(),
    }));
  }));

test("the durable file on disk never contains the raw payload or credential-like content", () =>
  withTemporaryDirectory(async (directory) => {
    const store = await openStore(directory, fixedKeyResolver());
    await store.commit({
      connectorId: "connector-jira",
      records: [record({
        payload: { summary: "SECRET-PAYLOAD-MARKER", apiToken: "token-should-never-be-stored-in-clear" },
      })],
    });

    const raw = readFileSync(persistencePaths(directory).transactionPath, "utf-8");
    assert.doesNotMatch(raw, /SECRET-PAYLOAD-MARKER/);
    assert.doesNotMatch(raw, /token-should-never-be-stored-in-clear/);
  }));

test("listRecords and getCheckpoint return immutable copies after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const seed = await openStore(directory, fixedKeyResolver(key));
    await seed.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    const records = restarted.listRecords();
    (records[0].payload as Record<string, unknown>).summary = "tampered";
    assert.notDeepEqual(restarted.listRecords()[0].payload, records[0].payload);

    const checkpoint = restarted.getCheckpoint("connector-jira")!;
    (checkpoint as Record<string, unknown>).cursor = "tampered";
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
  }));

test("throws when used before initialize() completes", () =>
  withTemporaryDirectory(async (directory) => {
    const store = new PersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
    });
    assert.throws(() => store.listRecords(), /not initialized/);
    await assert.rejects(() => store.commit({ connectorId: "connector-jira", records: [record()] }));
  }));

test("rolls back the entire commit, without ever attempting to persist, when the checkpoint is not structured-cloneable (DataCloneError)", () =>
  withTemporaryDirectory(async (directory) => {
    const persistCalls: string[] = [];
    const spyFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        persistCalls.push("writeFileDurable");
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        persistCalls.push("rename");
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async (path) => {
        persistCalls.push("syncDirectory");
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        persistCalls.push("removeTempFile");
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: spyFsOperations,
    });

    const uncloneable: Record<string, unknown> = { cursor: "STT-1234", notCloneable: () => {} };
    await assert.rejects(
      () => store.commit({
        connectorId: "connector-jira",
        records: [record()],
        checkpoint: uncloneable as never,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error).name, "DataCloneError");
        return true;
      },
    );

    // commitInMemory must fail before mutating and before persist() is ever
    // reached: no fs operation should have been attempted, and the data
    // directory must be untouched.
    assert.deepEqual(persistCalls, []);
    assert.equal(store.listRecords().length, 0);
    assert.equal(store.getCheckpoint("connector-jira"), undefined);
    assert.equal(existsSync(store.storagePath), false);
  }));

test("rolls back the entire commit, without ever attempting to persist, when the clock throws", () =>
  withTemporaryDirectory(async (directory) => {
    const persistCalls: string[] = [];
    const spyFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        persistCalls.push("writeFileDurable");
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        persistCalls.push("rename");
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async (path) => {
        persistCalls.push("syncDirectory");
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        persistCalls.push("removeTempFile");
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: spyFsOperations,
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    await assert.rejects(
      () => store.commit({
        connectorId: "connector-jira",
        records: [record()],
        checkpoint: { cursor: "STT-1234" },
      }),
      /clock unavailable/,
    );

    assert.deepEqual(persistCalls, []);
    assert.equal(store.listRecords().length, 0);
    assert.equal(store.getCheckpoint("connector-jira"), undefined);
    assert.equal(existsSync(store.storagePath), false);
  }));

test("persist() flushes the temp file, then renames, then syncs the containing directory, in that order", () =>
  withTemporaryDirectory(async (directory) => {
    const calls: Array<{ op: string; path: string; extra?: string }> = [];
    const spyFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        calls.push({ op: "writeFileDurable", path });
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        calls.push({ op: "rename", path: oldPath, extra: newPath });
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async (path) => {
        calls.push({ op: "syncDirectory", path });
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        calls.push({ op: "removeTempFile", path });
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const key = randomBytes(32);
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations: spyFsOperations,
    });

    await store.commit({ connectorId: "connector-jira", records: [record()] });

    const paths = persistencePaths(directory);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].op, "writeFileDurable");
    assert.equal(calls[0].path, paths.transactionTempPath);
    assert.equal(calls[1].op, "rename");
    assert.equal(calls[1].path, paths.transactionTempPath);
    assert.equal(calls[1].extra, paths.transactionPath);
    assert.equal(calls[2].op, "syncDirectory");
    assert.equal(calls[2].path, paths.transactionDirectory);

    // The real filesystem calls were delegated through, so the commit is
    // genuinely durable.
    const restarted = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
    });
    assert.equal(restarted.listRecords().length, 1);
  }));

test("a failing temp-file flush quarantines the temp file, still durably tombstones the rejected marker (flush then directory sync) before cleanup, and rolls back the commit without renaming", () =>
  withTemporaryDirectory(async (directory) => {
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;
    const markerPath = paths.transactionRejectedMarkerPath;
    const calls: string[] = [];
    const failingFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        if (path === tempPath) {
          calls.push("writeFileDurable:temp");
          // Simulate a real partial write reaching disk before the flush itself
          // fails, so the quarantine behavior (removing the leftover file) is
          // exercised for real.
          writeFileSync(path, "partial-write-before-flush-failure", "utf-8");
          throw new Error("simulated flush failure");
        }
        // Any other path is the rejected-temp tombstone marker: it must
        // durably succeed (write + flush) independently of the original
        // temp-write failure above.
        calls.push("writeFileDurable:marker");
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        calls.push("rename");
      },
      syncDirectory: async (path) => {
        calls.push("syncDirectory");
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        calls.push("removeTempFile");
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: failingFsOperations,
    });

    await assert.rejects(
      () => store.commit({ connectorId: "connector-jira", records: [record()] }),
      /simulated flush failure/,
    );

    // The temp write/flush fails immediately (before any rename is
    // attempted), but quarantine still durably establishes the rejected
    // marker -- write, flush, then directory sync, in that order -- before
    // it ever removes the temp file. Both deletions are directory-synced.
    assert.deepEqual(calls, [
      "writeFileDurable:temp",
      "writeFileDurable:marker",
      "syncDirectory",
      "removeTempFile",
      "syncDirectory",
      "syncDirectory",
    ]);
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(store.storagePath), false);
    assert.equal(store.listRecords().length, 0);
  }));

test("a failing rename quarantines the temp file, durably tombstones the rejected marker (flush then directory sync), and rolls back the commit", () =>
  withTemporaryDirectory(async (directory) => {
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;
    const markerPath = paths.transactionRejectedMarkerPath;
    const calls: string[] = [];
    const failingFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        calls.push(path === tempPath ? "writeFileDurable:temp" : "writeFileDurable:marker");
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async () => {
        calls.push("rename");
        throw new Error("simulated rename failure");
      },
      syncDirectory: async (path) => {
        calls.push("syncDirectory");
        await nodeFsOperations.syncDirectory(path);
      },
      removeTempFile: async (path) => {
        calls.push("removeTempFile");
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: failingFsOperations,
    });

    await assert.rejects(
      () => store.commit({ connectorId: "connector-jira", records: [record()] }),
      /simulated rename failure/,
    );

    // The rename fails after a successful temp write/flush; quarantine then
    // durably establishes the rejected marker (write, flush, then directory
    // sync) before removing the temp file. Both deletions are directory-synced.
    assert.deepEqual(calls, [
      "writeFileDurable:temp",
      "rename",
      "writeFileDurable:marker",
      "syncDirectory",
      "removeTempFile",
      "syncDirectory",
      "syncDirectory",
    ]);
    assert.equal(existsSync(tempPath), false);
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(store.storagePath), false);
    assert.equal(store.listRecords().length, 0);
  }));

test("an unexpected (non-swallowed) directory-sync failure after a successful rename is a committed result, not a rollback: memory, restart, callback, result, and state all reflect the commit plus a sanitized warning", () =>
  withTemporaryDirectory(async (directory) => {
    const calls: string[] = [];
    const reportedWarnings: unknown[] = [];
    const directorySyncError = Object.assign(new Error("simulated unexpected directory-sync failure"), {
      code: "EIO",
    });
    const failingFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        calls.push("writeFileDurable");
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        calls.push("rename");
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async () => {
        calls.push("syncDirectory");
        throw directorySyncError;
      },
      removeTempFile: async (path) => {
        calls.push("removeTempFile");
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const key = randomBytes(32);
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations: failingFsOperations,
      onDurabilityWarning: (warning) => reportedWarnings.push(warning),
    });

    // The rename is the commit point: it succeeded on disk, so this must
    // resolve as a committed result, never reject/rollback, even though the
    // best-effort post-rename directory fsync failed.
    const result = await store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });

    assert.deepEqual(calls, ["writeFileDurable", "rename", "syncDirectory"]);
    assert.equal(result.committedCount, 1);
    assert.equal(result.checkpointAdvanced, true);

    // The sanitized warning is available via the commit result...
    assert.ok(result.durabilityWarning);
    assert.equal(result.durabilityWarning?.stage, "directory-sync");
    assert.equal(result.durabilityWarning?.connectorId, "connector-jira");
    assert.equal(result.durabilityWarning?.errorCode, "EIO");
    assert.equal(typeof result.durabilityWarning?.occurredAt, "string");
    assert.equal(typeof result.durabilityWarning?.message, "string");
    // ...must never leak payload, checkpoint, or key material...
    const serializedWarning = JSON.stringify(result.durabilityWarning);
    assert.equal(serializedWarning.includes("STT-1234"), false);
    assert.equal(serializedWarning.includes("A sanitized fixture requirement"), false);
    assert.equal(serializedWarning.includes(KEY_REF), false);
    // ...via the injected callback...
    assert.equal(reportedWarnings.length, 1);
    assert.deepEqual(reportedWarnings[0], result.durabilityWarning);
    // ...and via polled state.
    assert.deepEqual(store.lastDurabilityWarning, result.durabilityWarning);

    // The in-memory view already reflects the commit (the rename landed).
    assert.equal(store.listRecords().length, 1);
    assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });

    // A restart loads the same durable snapshot: the new record/checkpoint
    // survive, confirming the rename -- not the directory sync -- is what
    // made this commit durable.
    const restarted = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
    });
    assert.equal(restarted.listRecords().length, 1);
    assert.deepEqual(restarted.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
  }));

test("a clock that throws only on calls made after the rename never turns a committed transaction into a rollback", () =>
  withTemporaryDirectory(async (directory) => {
    // Regression test: `commit()`'s rollback must never fire for a
    // transaction whose rename already succeeded. The pre-fix bug was that
    // building the post-rename `DurabilityWarning` called `this.now()`
    // *again*, after the durability point; if that second call threw (a
    // clock that becomes unavailable, or one that is only flaky), the throw
    // escaped `persist()` uncaught and was caught by `commit()`'s `catch`,
    // which incorrectly rolled back memory for an already-durable commit.
    // This clock allows exactly the two pre-rename calls the fixed code
    // makes (`commitInMemory`'s `recordedAt`, then `persist()`'s
    // pre-rename-captured warning timestamp) and throws on any further
    // call, so this test fails again if a post-rename call to `now()` is
    // ever reintroduced.
    let calls = 0;
    const directorySyncError = Object.assign(new Error("simulated unexpected directory-sync failure"), {
      code: "EIO",
    });
    const failingFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async () => {
        throw directorySyncError;
      },
      removeTempFile: async (path) => {
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: failingFsOperations,
      now: () => {
        calls += 1;
        if (calls > 2) {
          throw new Error("clock unavailable after rename -- must never be called at this point");
        }
        return `2026-09-11T00:00:0${calls}.000Z`;
      },
    });

    const result = await store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });

    // The rename succeeded (only the best-effort directory-sync failed), so
    // this must resolve as a committed result with a warning, never reject.
    assert.equal(result.committedCount, 1);
    assert.ok(result.durabilityWarning);
    assert.equal(result.durabilityWarning?.stage, "directory-sync");
    assert.equal(typeof result.durabilityWarning?.occurredAt, "string");
    assert.equal(store.listRecords().length, 1);
    assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
    assert.equal(calls, 2);
  }));

test("onDurabilityWarning is optional and its own failure never turns a committed transaction into a rejection", () =>
  withTemporaryDirectory(async (directory) => {
    const failingFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: async () => {
        throw Object.assign(new Error("simulated unexpected directory-sync failure"), { code: "EIO" });
      },
      removeTempFile: async (path) => {
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
      fsOperations: failingFsOperations,
      onDurabilityWarning: () => {
        throw new Error("simulated callback failure");
      },
    });

    const result = await store.commit({ connectorId: "connector-jira", records: [record()] });
    assert.equal(result.committedCount, 1);
    assert.ok(result.durabilityWarning);
    assert.equal(store.listRecords().length, 1);
  }));

test("a commit with no durability warning leaves lastDurabilityWarning null and the result field absent", () =>
  withTemporaryDirectory(async (directory) => {
    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(),
    });

    const result = await store.commit({ connectorId: "connector-jira", records: [record()] });
    assert.equal(result.durabilityWarning, undefined);
    assert.equal(store.lastDurabilityWarning, null);
  }));


/**
 * Minimal externally-resolvable promise, used by the concurrency tests below
 * to hold a commit deterministically *inside* its critical section (its
 * temp-file write) while a second `commit()` is started, with no timers or
 * wall-clock sleeps involved.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/**
 * Drains the microtask queue (and one macrotask turn) repeatedly, giving a
 * concurrently-started commit every opportunity it would ever get to
 * interleave. Deterministic: it never depends on how long any real I/O takes.
 */
async function drainPendingWork(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("overlapping commits on one instance are serialized: both callers' outcomes match memory and a restart, each persist writes its own transaction's snapshot, and both checkpoints are preserved", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;
    const firstTempWriteStarted = deferred();
    const releaseFirstTempWrite = deferred();
    let tempWrites = 0;
    let tempWritesInFlight = 0;
    let maxTempWritesInFlight = 0;
    // What the store's in-memory state contained at the moment each
    // transaction temp file was written.
    const persistedSourceIds: string[][] = [];
    let store!: PersistentRawEvidenceStore;

    const gatedFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        if (path !== tempPath) {
          await nodeFsOperations.writeFileDurable(path, contents);
          return;
        }
        tempWrites += 1;
        tempWritesInFlight += 1;
        maxTempWritesInFlight = Math.max(maxTempWritesInFlight, tempWritesInFlight);
        persistedSourceIds.push(store.listRecords().map((item) => item.sourceId));
        try {
          if (tempWrites === 1) {
            firstTempWriteStarted.resolve();
            await releaseFirstTempWrite.promise;
          }
          await nodeFsOperations.writeFileDurable(path, contents);
        } finally {
          tempWritesInFlight -= 1;
        }
      },
      rename: nodeFsOperations.rename,
      syncDirectory: nodeFsOperations.syncDirectory,
      removeTempFile: nodeFsOperations.removeTempFile,
    };

    store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations: gatedFsOperations,
    });

    const firstCommit = store.commit({
      connectorId: "connector.jira",
      records: [record({ sourceId: "STT-1", idempotencyKey: "jira:STT-1" })],
      checkpoint: { cursor: "jira-page-1" },
    });
    const secondCommit = store.commit({
      connectorId: "connector.testrail",
      records: [record({ source: "testrail", sourceId: "C-9", idempotencyKey: "testrail:C-9" })],
      checkpoint: { cursor: "testrail-page-1" },
    });

    await firstTempWriteStarted.promise;
    await drainPendingWork();

    // The second commit is still queued: it has neither started its own temp
    // write nor mutated memory, so the first commit's snapshot/rollback view
    // is transaction-specific.
    assert.equal(tempWrites, 1);
    assert.equal(store.getRecord("testrail:C-9"), undefined);
    assert.equal(store.getCheckpoint("connector.testrail"), undefined);

    releaseFirstTempWrite.resolve();
    const [firstResult, secondResult] = await Promise.all([firstCommit, secondCommit]);

    // No shared temp-file race: the two transactions never wrote the shared
    // temp path at the same time, and each write carried exactly its own
    // transaction's in-memory state.
    assert.equal(maxTempWritesInFlight, 1);
    assert.equal(tempWrites, 2);
    assert.deepEqual(persistedSourceIds, [["STT-1"], ["STT-1", "C-9"]]);

    // Both callers' reported outcomes match memory.
    assert.equal(firstResult.committedCount, 1);
    assert.equal(secondResult.committedCount, 1);
    assert.deepEqual(firstResult.checkpoint, { cursor: "jira-page-1" });
    assert.deepEqual(secondResult.checkpoint, { cursor: "testrail-page-1" });
    assert.deepEqual(store.listRecords().map((item) => item.sourceId), ["STT-1", "C-9"]);
    assert.deepEqual(store.getCheckpoint("connector.jira"), firstResult.checkpoint);
    assert.deepEqual(store.getCheckpoint("connector.testrail"), secondResult.checkpoint);

    // ...and a restart reloads exactly the same records, both checkpoints,
    // and both history entries.
    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(restarted.listRecords().map((item) => item.sourceId), ["STT-1", "C-9"]);
    assert.deepEqual(restarted.getCheckpoint("connector.jira"), { cursor: "jira-page-1" });
    assert.deepEqual(restarted.getCheckpoint("connector.testrail"), { cursor: "testrail-page-1" });
    assert.equal(restarted.history().length, 2);
    assert.equal(existsSync(tempPath), false);
  }));

test("a failing commit that overlaps a queued one rolls back only its own transaction: the queued commit still lands in memory and after a restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const paths = persistencePaths(directory);
    const tempPath = paths.transactionTempPath;
    const firstTempWriteStarted = deferred();
    const releaseFirstTempWrite = deferred();
    let tempWrites = 0;
    let store!: PersistentRawEvidenceStore;

    const failFirstRenameFsOperations: PersistFsOperations = {
      writeFileDurable: async (path, contents) => {
        if (path !== tempPath) {
          await nodeFsOperations.writeFileDurable(path, contents);
          return;
        }
        tempWrites += 1;
        if (tempWrites === 1) {
          firstTempWriteStarted.resolve();
          await releaseFirstTempWrite.promise;
        }
        await nodeFsOperations.writeFileDurable(path, contents);
      },
      rename: async (oldPath, newPath) => {
        if (tempWrites === 1) throw new Error("simulated rename failure");
        await nodeFsOperations.rename(oldPath, newPath);
      },
      syncDirectory: nodeFsOperations.syncDirectory,
      removeTempFile: nodeFsOperations.removeTempFile,
    };

    store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: KEY_REF,
      resolveKey: fixedKeyResolver(key),
      fsOperations: failFirstRenameFsOperations,
    });

    const failingCommit = store.commit({
      connectorId: "connector.jira",
      records: [record({ sourceId: "STT-1", idempotencyKey: "jira:STT-1" })],
      checkpoint: { cursor: "jira-page-1" },
    });
    const queuedCommit = store.commit({
      connectorId: "connector.testrail",
      records: [record({ source: "testrail", sourceId: "C-9", idempotencyKey: "testrail:C-9" })],
      checkpoint: { cursor: "testrail-page-1" },
    });

    await firstTempWriteStarted.promise;
    await drainPendingWork();
    assert.equal(tempWrites, 1);

    releaseFirstTempWrite.resolve();
    await assert.rejects(() => failingCommit, /simulated rename failure/);
    const queuedResult = await queuedCommit;

    // The rejected transaction was rolled back in full; the queued one was
    // neither discarded by that rollback nor merged into it.
    assert.equal(queuedResult.committedCount, 1);
    assert.deepEqual(store.listRecords().map((item) => item.sourceId), ["C-9"]);
    assert.equal(store.getRecord("jira:STT-1"), undefined);
    assert.equal(store.getCheckpoint("connector.jira"), undefined);
    assert.deepEqual(store.getCheckpoint("connector.testrail"), { cursor: "testrail-page-1" });

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.deepEqual(restarted.listRecords().map((item) => item.sourceId), ["C-9"]);
    assert.equal(restarted.getCheckpoint("connector.jira"), undefined);
    assert.deepEqual(restarted.getCheckpoint("connector.testrail"), { cursor: "testrail-page-1" });
    assert.equal(existsSync(tempPath), false);
  }));

test("the default nodeFsOperations.syncDirectory resolves without throwing for a real directory on this platform", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tkl-raw-evidence-syncdir-"));
  try {
    await assert.doesNotReject(() => nodeFsOperations.syncDirectory(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default nodeFsOperations.syncDirectory still propagates errors unrelated to the known Windows unsupported case", async () => {
  const missingDirectory = join(tmpdir(), "tkl-raw-evidence-syncdir-missing", "does-not-exist");
  await assert.rejects(() => nodeFsOperations.syncDirectory(missingDirectory));
});

test("isUnsupportedDirectorySyncError treats EPERM as unsupported only on win32, and only for EPERM", () => {
  const originalPlatform = process.platform;
  const eperm = Object.assign(new Error("eperm"), { code: "EPERM" });
  const eacces = Object.assign(new Error("eacces"), { code: "EACCES" });
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(isUnsupportedDirectorySyncError(eperm), true);
    assert.equal(isUnsupportedDirectorySyncError(eacces), false);
    assert.equal(isUnsupportedDirectorySyncError(new Error("no code")), false);
    assert.equal(isUnsupportedDirectorySyncError(null), false);
    assert.equal(isUnsupportedDirectorySyncError("not-an-object"), false);

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    // A genuine EPERM on a non-Windows platform is a real failure, not the
    // known-unsupported Windows directory-fsync case, so it must not be
    // swallowed.
    assert.equal(isUnsupportedDirectorySyncError(eperm), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});
