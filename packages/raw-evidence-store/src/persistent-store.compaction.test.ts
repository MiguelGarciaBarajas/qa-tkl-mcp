import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RawEvidenceRecord } from "@tkl/contracts";
import {
  createPersistentRawEvidenceStore,
  nodeFsOperations,
  type PersistFsOperations,
} from "./persistent-store.ts";
import { decryptEnvelope, encryptEnvelope, type KeyResolver } from "./crypto.ts";

const KEY_REF = "secret://raw-evidence/fl-titling";
const TRANSACTION_FILE_PATTERN = /^\d{16}\.json$/;
const RECORD_SEGMENT_PATTERN = /^segment-\d{8}\.json$/;
const GENERATION_DIR_PATTERN = /^gen-\d{16}$/;

function withTemporaryDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "tkl-raw-evidence-compaction-"));
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
    sourceId: "STT-1000",
    sourceVersion: "1",
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
  options: { fsOperations?: PersistFsOperations; now?: () => string } = {},
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

function scopeDirectory(directory: string): string {
  return join(directory, "solera", "fl-titling");
}

function chunkDirectory(directory: string): string {
  return join(scopeDirectory(directory), "raw-evidence-store.chunks");
}

function compactedDirectory(directory: string): string {
  return join(scopeDirectory(directory), "raw-evidence-store.compacted");
}

function manifestPath(directory: string): string {
  return join(compactedDirectory(directory), "manifest.json");
}

function monolithicBasePath(directory: string): string {
  return join(scopeDirectory(directory), "raw-evidence-store.base.json");
}

function countChunkFiles(directory: string): number {
  const chunks = chunkDirectory(directory);
  if (!existsSync(chunks)) return 0;
  return readdirSync(chunks).filter((name) => TRANSACTION_FILE_PATTERN.test(name)).length;
}

function listGenerationDirs(directory: string): string[] {
  const compacted = compactedDirectory(directory);
  if (!existsSync(compacted)) return [];
  return readdirSync(compacted, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && GENERATION_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readManifest(directory: string, key: Buffer): Record<string, unknown> {
  const envelope = JSON.parse(readFileSync(manifestPath(directory), "utf-8"));
  return decryptEnvelope(envelope, key) as Record<string, unknown>;
}

function countSegments(directory: string, generationDir: string, pattern: RegExp): number {
  const dir = join(compactedDirectory(directory), generationDir);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => pattern.test(name)).length;
}

async function commitRecords(
  store: Awaited<ReturnType<typeof openStore>>,
  count: number,
  startIndex = 0,
): Promise<string[]> {
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const sourceId = `STT-${1000 + startIndex + index}`;
    const result = await store.commit({
      connectorId: "connector.jira",
      records: [record({ sourceId, sourceVersion: "1", contentHash: `hash-${sourceId}` })],
      checkpoint: { cursor: sourceId },
    });
    keys.push(...result.committedIdempotencyKeys);
  }
  return keys;
}

test("compaction folds chunk files into encrypted segments published by an atomic manifest", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    const keys = await commitRecords(store, 5);
    assert.equal(countChunkFiles(directory), 5);

    const result = await store.compact();
    assert.equal(result.status, "compacted");
    assert.equal(result.chunkFilesBefore, 5);
    assert.equal(result.chunkFilesFolded, 5);
    assert.equal(result.chunkFilesRemaining, 0);
    assert.equal(result.recordsRetained, 5);
    assert.equal(result.throughSequence, 5);
    assert.equal(result.generation, 1);
    assert.ok(result.recordSegmentsWritten >= 1);
    assert.equal(countChunkFiles(directory), 0);

    // No monolithic base is ever written; the manifest is the published pointer.
    assert.ok(!existsSync(monolithicBasePath(directory)));
    assert.ok(existsSync(manifestPath(directory)));

    // The manifest is an authenticated envelope carrying only a small pointer.
    const manifestEnvelope = JSON.parse(readFileSync(manifestPath(directory), "utf-8"));
    assert.equal(typeof manifestEnvelope.ciphertext, "string");
    assert.ok(!("records" in manifestEnvelope));
    const manifest = readManifest(directory, key);
    assert.equal(manifest.kind, "raw-evidence-compacted-manifest");
    assert.equal(manifest.recordCount, 5);
    assert.equal(manifest.recordSegmentCount, result.recordSegmentsWritten);
    assert.ok(!("records" in manifest));

    // The bulk records live in independently encrypted segment files.
    const generationDir = manifest.generationDir as string;
    assert.match(generationDir, GENERATION_DIR_PATTERN);
    assert.equal(
      countSegments(directory, generationDir, RECORD_SEGMENT_PATTERN),
      manifest.recordSegmentCount,
    );
    const firstSegmentPath = join(compactedDirectory(directory), generationDir, "segment-00000000.json");
    const segmentEnvelope = JSON.parse(readFileSync(firstSegmentPath, "utf-8"));
    assert.equal(typeof segmentEnvelope.ciphertext, "string");
    const segment = decryptEnvelope(segmentEnvelope, key) as { kind: string; entries: unknown[] };
    assert.equal(segment.kind, "raw-evidence-compacted-segment");
    assert.ok(segment.entries.length >= 1);

    // Records, checkpoint, history, and pending projection work all survive.
    assert.equal(store.listRecords().length, 5);
    assert.deepEqual(store.getCheckpoint("connector.jira"), { cursor: "STT-1004" });
    assert.equal(store.history().length, 5);
    assert.equal(store.countPendingProjectionRecords(), 5);
    assert.deepEqual(
      store.listPendingProjectionRecords().map((item) => item.sourceId).sort(),
      keys.map((k) => k.split(":")[1]).sort(),
    );
  });
});

test("compaction splits a large record set into multiple bounded segment files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 5);

    // A small per-segment record cap forces several segment files.
    const result = await store.compact({ maxRecordsPerSegment: 2 });
    assert.equal(result.status, "compacted");
    assert.equal(result.recordSegmentsWritten, 3); // ceil(5 / 2)

    const manifest = readManifest(directory, key);
    const generationDir = manifest.generationDir as string;
    assert.equal(manifest.recordSegmentCount, 3);
    assert.equal(countSegments(directory, generationDir, RECORD_SEGMENT_PATTERN), 3);

    // Every record loads back in commit order across the multiple segments.
    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 5);
    assert.deepEqual(
      restarted.listRecords().map((item) => item.sourceId),
      ["STT-1000", "STT-1001", "STT-1002", "STT-1003", "STT-1004"],
    );
    assert.equal(restarted.history().length, 5);
    assert.equal(restarted.countPendingProjectionRecords(), 5);
    assert.equal(restarted.maintenanceStatus().compactedThroughSequence, 5);
  });
});

test("compacted state survives restart and continues appending contiguously", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const first = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(first, 4);
    await first.compact();

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 4);
    assert.equal(restarted.history().length, 4);
    assert.deepEqual(restarted.getCheckpoint("connector.jira"), { cursor: "STT-1003" });
    assert.equal(restarted.maintenanceStatus().compactedThroughSequence, 4);

    // New commits after a compaction pick up at the next sequence.
    await commitRecords(restarted, 2, 4);
    assert.equal(restarted.listRecords().length, 6);
    assert.equal(countChunkFiles(directory), 2);

    const reopened = await openStore(directory, fixedKeyResolver(key));
    assert.equal(reopened.listRecords().length, 6);
    assert.equal(reopened.history().length, 6);
  });
});

test("a second compaction supersedes the prior generation and removes its directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);
    const first = await store.compact();
    assert.equal(first.generation, 1);

    await commitRecords(store, 2, 3);
    const second = await store.compact();
    assert.equal(second.generation, 2);
    assert.equal(second.throughSequence, 5);

    // Only the newest generation directory remains; the prior one is deleted.
    const generations = listGenerationDirs(directory);
    assert.equal(generations.length, 1);
    const manifest = readManifest(directory, key);
    assert.equal(manifest.generation, 2);
    assert.equal(generations[0], manifest.generationDir);
    assert.equal(countChunkFiles(directory), 0);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 5);
    assert.equal(restarted.history().length, 5);
  });
});

test("dry-run compaction reports the plan without writing or deleting anything", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);

    const plan = await store.compact({ dryRun: true });
    assert.equal(plan.status, "planned");
    assert.equal(plan.dryRun, true);
    assert.equal(plan.chunkFilesFolded, 3);
    assert.equal(plan.throughSequence, 3);
    assert.equal(plan.generation, 1);
    assert.equal(plan.recordSegmentsWritten, 0);

    assert.equal(countChunkFiles(directory), 3);
    assert.ok(!existsSync(manifestPath(directory)));
    assert.equal(listGenerationDirs(directory).length, 0);
    assert.equal(store.maintenanceStatus().generation, 0);
  });
});

test("compaction is bounded by min and max chunk-file limits", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);

    const skipped = await store.compact({ minChunkFiles: 10 });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "below-threshold");
    assert.equal(countChunkFiles(directory), 3);

    const aborted = await store.compact({ maxChunkFiles: 2 });
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.reason, "exceeds-max-chunk-files");
    assert.equal(countChunkFiles(directory), 3);
    assert.ok(!existsSync(manifestPath(directory)));
  });
});

test("repeated compaction with no new chunks is a no-op skip", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);
    const first = await store.compact();
    assert.equal(first.status, "compacted");

    const second = await store.compact();
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "below-threshold");
    assert.equal(second.generation, 1);
  });
});

test("pending projection failures and dead-letter state survive compaction and restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);
    const poison = "jira:STT-1001:1";

    // Ack one, drive one to the dead-letter queue (threshold is 3 attempts).
    await store.acknowledgeProjected(["jira:STT-1000:1"]);
    await store.recordProjectionFailures([poison]);
    await store.recordProjectionFailures([poison]);
    await store.recordProjectionFailures([poison]);
    assert.equal(store.countDeadLetterProjectionRecords(), 1);
    assert.equal(store.countPendingProjectionRecords(), 1);

    await store.compact();
    assert.equal(store.countDeadLetterProjectionRecords(), 1);
    assert.equal(store.countPendingProjectionRecords(), 1);

    const manifest = readManifest(directory, key);
    assert.equal(manifest.pendingProjectionCount, 1);
    assert.equal(manifest.deadLetterCount, 1);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.countDeadLetterProjectionRecords(), 1);
    assert.equal(restarted.countPendingProjectionRecords(), 1);
    const dead = restarted.listDeadLetterProjectionRecords();
    assert.equal(dead.length, 1);
    assert.equal(dead[0].idempotencyKey, poison);
    assert.equal(dead[0].attemptCount, 3);

    // Requeue still works against a compacted-then-restarted store.
    assert.equal(await restarted.requeueDeadLetterProjectionRecords([poison]), 1);
    assert.equal(restarted.countDeadLetterProjectionRecords(), 0);
    assert.equal(restarted.countPendingProjectionRecords(), 2);
  });
});

test("a crash between publishing the manifest and cleaning chunks is idempotent on restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    // fsOperations that refuse to unlink chunk files, simulating a crash right
    // after the manifest publish but before old-generation chunk cleanup.
    const noChunkDelete: PersistFsOperations = {
      ...nodeFsOperations,
      async removeTempFile(path) {
        if (TRANSACTION_FILE_PATTERN.test(path.split(/[\\/]/).pop() ?? "")) {
          throw new Error("simulated crash before chunk cleanup");
        }
        await nodeFsOperations.removeTempFile(path);
      },
    };
    const store = await openStore(directory, fixedKeyResolver(key), { fsOperations: noChunkDelete });
    await commitRecords(store, 4);
    const result = await store.compact({ maxRecordsPerSegment: 2 });
    assert.equal(result.status, "compacted");
    // The manifest is live but stale chunks remain because cleanup "crashed".
    assert.ok(existsSync(manifestPath(directory)));
    assert.equal(countChunkFiles(directory), 4);

    // A normal restart must ignore the folded chunks (no double-apply) and
    // remove them, leaving exactly the compacted state.
    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 4);
    assert.equal(restarted.history().length, 4);
    assert.equal(restarted.countPendingProjectionRecords(), 4);
    assert.equal(countChunkFiles(directory), 0);
  });
});

test("a crash during the manifest publish preserves the pre-compaction generation", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const failingRename: PersistFsOperations = {
      ...nodeFsOperations,
      async rename(oldPath, newPath) {
        if (newPath.endsWith("manifest.json")) {
          throw new Error("simulated crash during manifest publish");
        }
        await nodeFsOperations.rename(oldPath, newPath);
      },
    };
    const store = await openStore(directory, fixedKeyResolver(key), { fsOperations: failingRename });
    await commitRecords(store, 3);
    await assert.rejects(() => store.compact(), /simulated crash during manifest publish/);

    // No manifest was published; the chunks are intact and authoritative.
    assert.ok(!existsSync(manifestPath(directory)));
    assert.equal(countChunkFiles(directory), 3);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 3);
    assert.equal(restarted.history().length, 3);
    assert.equal(restarted.maintenanceStatus().generation, 0);
    // Any orphan generation directory is cleaned up on restart.
    assert.equal(listGenerationDirs(directory).length, 0);
  });
});

test("an unpublished generation left by a crash before publish is ignored and cleaned on restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 3);
    assert.equal(countChunkFiles(directory), 3);

    // Simulate a crash after segment files were written but before the manifest
    // pointer was published: an orphan generation directory plus a manifest
    // temp, with no live manifest.json.
    const compacted = compactedDirectory(directory);
    const orphanGeneration = join(compacted, "gen-0000000000000001");
    mkdirSync(orphanGeneration, { recursive: true });
    writeFileSync(join(orphanGeneration, "segment-00000000.json"), "{\"unfinished\":true}\n");
    writeFileSync(join(compacted, "manifest.json.tmp"), "{\"unfinished\":true}\n");

    // Startup must ignore the unpublished generation, load from the durable
    // chunks, and clean up the orphan directory and manifest temp.
    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 3);
    assert.equal(restarted.history().length, 3);
    assert.equal(restarted.maintenanceStatus().generation, 0);
    assert.equal(listGenerationDirs(directory).length, 0);
    assert.ok(!existsSync(join(compacted, "manifest.json.tmp")));
    assert.ok(!existsSync(manifestPath(directory)));

    // The store is still fully usable and can now compact cleanly.
    const result = await restarted.compact();
    assert.equal(result.status, "compacted");
    assert.equal(result.generation, 1);
    assert.equal(restarted.listRecords().length, 3);
  });
});

test("a legacy monolithic compacted base is still loaded for backward compatibility", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const scope = scopeDirectory(directory);
    mkdirSync(scope, { recursive: true });

    // Two records, folded as if by a prior release's monolithic compaction.
    const recordA = record({ sourceId: "STT-2000", sourceVersion: "1", contentHash: "hash-2000" });
    const recordB = record({ sourceId: "STT-2001", sourceVersion: "1", contentHash: "hash-2001" });
    const snapshot = {
      kind: "raw-evidence-compacted-base",
      version: 1,
      throughSequence: 2,
      generation: 1,
      createdAt: "2026-09-10T00:00:00.000Z",
      records: [
        { idempotencyKey: "jira:STT-2000:1", connectorId: "connector.jira", record: recordA },
        { idempotencyKey: "jira:STT-2001:1", connectorId: "connector.jira", record: recordB },
      ],
      checkpoints: { "connector.jira": { cursor: "STT-2001" } },
      history: [],
      pendingProjectionKeys: ["jira:STT-2000:1", "jira:STT-2001:1"],
      projectionFailures: [],
    };
    const envelope = encryptEnvelope(snapshot, key, {
      tenantId: "solera",
      productId: "fl-titling",
      schemaVersion: 1,
      keyRef: KEY_REF,
    });
    writeFileSync(monolithicBasePath(directory), `${JSON.stringify(envelope, null, 2)}\n`);

    const store = await openStore(directory, fixedKeyResolver(key));
    assert.equal(store.listRecords().length, 2);
    assert.deepEqual(store.getCheckpoint("connector.jira"), { cursor: "STT-2001" });
    assert.equal(store.countPendingProjectionRecords(), 2);
    assert.equal(store.maintenanceStatus().compactedThroughSequence, 2);

    // New commits continue after the folded sequence and never rewrite the base.
    await commitRecords(store, 1, 2);
    assert.equal(store.listRecords().length, 3);

    // A fresh segmented compaction supersedes and removes the monolithic base.
    await commitRecords(store, 1, 3);
    const result = await store.compact();
    assert.equal(result.status, "compacted");
    assert.ok(existsSync(manifestPath(directory)));
    assert.ok(!existsSync(monolithicBasePath(directory)));

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 4);
  });
});

test("compaction serializes with an interleaved commit under the in-process lock", async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const store = await openStore(directory, fixedKeyResolver(key));
    await commitRecords(store, 2);

    // Kick off a compaction and a commit without awaiting between them; the
    // per-instance lock must serialize them so both succeed and stay consistent.
    const compaction = store.compact();
    const commit = store.commit({
      connectorId: "connector.jira",
      records: [record({ sourceId: "STT-2000", contentHash: "hash-2000" })],
      checkpoint: { cursor: "STT-2000" },
    });
    const [compactionResult, commitResult] = await Promise.all([compaction, commit]);
    assert.equal(compactionResult.status, "compacted");
    assert.equal(commitResult.committedCount, 1);
    assert.equal(store.listRecords().length, 3);

    const restarted = await openStore(directory, fixedKeyResolver(key));
    assert.equal(restarted.listRecords().length, 3);
    assert.equal(restarted.history().length, 3);
  });
});
