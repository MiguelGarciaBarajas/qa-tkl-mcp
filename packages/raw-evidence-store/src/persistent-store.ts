import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { open as openFileHandle, rename as renameFile, rm as removeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawEvidenceRecord, SyncCheckpoint } from "@tkl/contracts";
import { assertRawEvidenceRecord, CREDENTIAL_REF_PATTERN } from "@tkl/contracts";
import {
  InMemoryRawEvidenceStore,
  type DurabilityWarning,
  type RawEvidenceCommitRequest,
  type RawEvidenceCommitResult,
  type RawEvidenceHistoryEntry,
  type RawEvidenceListFilter,
  type RawEvidencePage,
  type RawEvidencePageRequest,
  type RawEvidenceSourceInventoryEntry,
  type ProjectionFailureMetadata,
  type ProjectionFailureResult,
  type RawEvidenceStoreOptions,
} from "./store.ts";
import {
  assertEnvelopeScope,
  assertEnvelopeShape,
  assertSupportedEnvelopeVersion,
  assertSupportedSchemaVersion,
  decryptEnvelope,
  encryptEnvelope,
  resolveKeyMaterial,
  type EncryptedEnvelope,
  type KeyResolver,
} from "./crypto.ts";

/**
 * Durable, encrypted raw-evidence persistence.
 *
 * `raw-evidence-store.json` remains a read-only base snapshot for backward
 * compatibility. New commits are appended as independently encrypted,
 * ordered transaction files under `raw-evidence-store.chunks/`. A transaction
 * contains only the records newly accepted by that commit, its checkpoint
 * mutation, and its history entry, so commit cost and serialized string size
 * no longer grow with the complete evidence history.
 *
 * Each transaction uses write+fsync followed by an atomic rename. The rename
 * is the durability point. Record, checkpoint, and history changes share one
 * encrypted transaction file and therefore retain their atomic semantics.
 */

const SCHEMA_VERSION = 1;
const LATEST_TRANSACTION_VERSION = 3;
const COMMIT_TRANSACTION_VERSION = 2;
const PROJECTION_ACK_TRANSACTION_VERSION = 2;
const PROJECTION_FAILURE_TRANSACTION_VERSION = 3;
const PROJECTION_REQUEUE_TRANSACTION_VERSION = 3;
const FILE_NAME = "raw-evidence-store.json";
const LEGACY_TEMP_FILE_NAME = `${FILE_NAME}.tmp`;
const TRANSACTION_DIRECTORY_NAME = "raw-evidence-store.chunks";
const TRANSACTION_TEMP_FILE_NAME = "pending.json.tmp";
const TRANSACTION_FILE_DIGITS = 16;
const TRANSACTION_FILE_PATTERN = /^(\d{16})\.json$/;
const COMPACTED_BASE_FILE_NAME = "raw-evidence-store.base.json";
const COMPACTED_BASE_TEMP_FILE_NAME = `${COMPACTED_BASE_FILE_NAME}.tmp`;
const COMPACTED_BASE_KIND = "raw-evidence-compacted-base";
const COMPACTED_BASE_VERSION = 1;
const DEFAULT_MIN_CHUNK_FILES_TO_COMPACT = 2;
const DEFAULT_MAX_CHUNK_FILES_TO_COMPACT = 1_000;
/**
 * How many transaction files / compacted segments are replayed during
 * `loadDurableState` before the store cooperatively yields the event loop. A
 * large durable base (thousands of encrypted transaction files) would
 * otherwise monopolise the loop for the whole replay, starving unrelated HTTP
 * requests, because each `decryptUsableEnvelope` await only drains the
 * microtask queue and never returns to the macrotask/I-O queue. Yielding with
 * `setImmediate` at a bounded interval keeps the process responsive without
 * changing integrity validation, ordering, encryption, or crash semantics.
 */
const DEFAULT_REPLAY_YIELD_INTERVAL = 100;

/** Default cooperative yield: a Promise that resolves on the next macrotask. */
function defaultReplayYield(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Segmented compacted-generation format. A generation is a directory of
 * independently encrypted, bounded segment files plus an atomic manifest
 * pointer. The manifest is written last (temp + rename) and only after every
 * segment file and the generation directory entry are durable, so a generation
 * is "published" iff its manifest is live. Because each segment is capped by
 * record count and serialized bytes, no single `JSON.stringify` ever
 * approaches Node's `MAX_STRING_LENGTH`, and load streams one bounded segment
 * at a time without a second whole-dataset snapshot in memory.
 */
const COMPACTED_DIRECTORY_NAME = "raw-evidence-store.compacted";
const COMPACTED_MANIFEST_FILE_NAME = "manifest.json";
const COMPACTED_MANIFEST_TEMP_FILE_NAME = `${COMPACTED_MANIFEST_FILE_NAME}.tmp`;
const COMPACTED_MANIFEST_KIND = "raw-evidence-compacted-manifest";
const COMPACTED_RECORD_SEGMENT_KIND = "raw-evidence-compacted-segment";
const COMPACTED_HISTORY_SEGMENT_KIND = "raw-evidence-compacted-history-segment";
const COMPACTED_GENERATION_VERSION = 1;
const GENERATION_DIRECTORY_DIGITS = 16;
const GENERATION_DIRECTORY_PREFIX = "gen-";
const GENERATION_DIRECTORY_PATTERN = /^gen-(\d{16})$/;
const SEGMENT_FILE_DIGITS = 8;
const RECORD_SEGMENT_FILE_PREFIX = "segment-";
const HISTORY_SEGMENT_FILE_PREFIX = "history-";
const DEFAULT_MAX_RECORDS_PER_SEGMENT = 10_000;
const DEFAULT_MAX_HISTORY_PER_SEGMENT = 50_000;
/**
 * Serialized-bytes cap per segment. Kept well under Node's ~512MB
 * `MAX_STRING_LENGTH` so a single segment's `JSON.stringify` (plaintext, then
 * its encrypted envelope) can never approach the limit even with large
 * payloads and base64 ciphertext expansion.
 */
const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

interface PersistedRecordEntry {
  idempotencyKey: string;
  connectorId: string;
  record: RawEvidenceRecord;
}

interface PersistedContent {
  records: PersistedRecordEntry[];
  checkpoints: Record<string, SyncCheckpoint>;
  history: RawEvidenceHistoryEntry[];
}

interface PersistedProjectionFailureEntry extends ProjectionFailureMetadata {
  deadLettered: boolean;
}

/**
 * A compacted base snapshot folds the read-only legacy base snapshot plus a
 * contiguous run of transaction chunks (`1..throughSequence`) into one
 * authenticated envelope. Unlike the legacy base snapshot, it carries the full
 * projection outbox, dead-letter, and per-record failure state so compaction
 * never loses pending projection work, DLQ entries, idempotency behavior,
 * checkpoints, audit history, or provenance. Records are stored in commit
 * order so replay/audit ordering is preserved exactly.
 */
interface CompactedBaseSnapshot {
  kind: typeof COMPACTED_BASE_KIND;
  version: number;
  /** Highest transaction sequence folded into this base (inclusive). */
  throughSequence: number;
  /** Monotonic generation counter, incremented once per successful compaction. */
  generation: number;
  createdAt: string;
  records: PersistedRecordEntry[];
  checkpoints: Record<string, SyncCheckpoint>;
  history: RawEvidenceHistoryEntry[];
  pendingProjectionKeys: string[];
  projectionFailures: PersistedProjectionFailureEntry[];
}

/** Per-record projection state carried inline in a segment entry. */
interface PersistedSegmentFailure {
  failureCode: "projection-failed";
  attemptCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
  deadLettered: boolean;
}

/**
 * One record inside a compacted segment. Projection outbox membership
 * (`pending`) and per-record failure/dead-letter state travel with the record
 * itself, so no separate whole-dataset list of pending keys or failures is
 * ever serialized.
 */
interface PersistedSegmentRecordEntry extends PersistedRecordEntry {
  pending: boolean;
  failure?: PersistedSegmentFailure;
}

/** A bounded, independently encrypted slice of the record set, in commit order. */
interface CompactedRecordSegment {
  kind: typeof COMPACTED_RECORD_SEGMENT_KIND;
  version: number;
  generation: number;
  segmentIndex: number;
  entries: PersistedSegmentRecordEntry[];
}

/** A bounded, independently encrypted slice of the append-only history. */
interface CompactedHistorySegment {
  kind: typeof COMPACTED_HISTORY_SEGMENT_KIND;
  version: number;
  generation: number;
  segmentIndex: number;
  history: RawEvidenceHistoryEntry[];
}

/**
 * The small atomic pointer for a compacted generation. It names the generation
 * directory and the exact number of record/history segments plus expected
 * counts, so load can verify completeness and never applies a partially
 * written generation. Only checkpoints (bounded by connector count) travel in
 * the manifest; all bulk data lives in the segment files.
 */
interface CompactedManifest {
  kind: typeof COMPACTED_MANIFEST_KIND;
  version: number;
  generation: number;
  /** Highest transaction sequence folded into this generation (inclusive). */
  throughSequence: number;
  createdAt: string;
  generationDir: string;
  recordCount: number;
  recordSegmentCount: number;
  historyCount: number;
  historySegmentCount: number;
  pendingProjectionCount: number;
  deadLetterCount: number;
  checkpoints: Record<string, SyncCheckpoint>;
}

/** Options controlling a bounded, non-destructive raw-evidence compaction. */
export interface RawEvidenceCompactionOptions {
  /** Plan only: report what would be folded without writing or deleting anything. */
  dryRun?: boolean;
  /** Skip (no-op) unless at least this many chunk files exist. Default 2. */
  minChunkFiles?: number;
  /**
   * Refuse to compact when more than this many chunk files exist, so a routine
   * maintenance run can never trigger an unbounded rewrite of a very large
   * evidence directory. Default 1000; raise it explicitly to compact a bigger
   * generation.
   */
  maxChunkFiles?: number;
  /**
   * Maximum records per encrypted segment file. Bounds each segment's
   * serialized size so a single `JSON.stringify` never approaches
   * `MAX_STRING_LENGTH`. Default 10000.
   */
  maxRecordsPerSegment?: number;
  /**
   * Approximate serialized-bytes cap per segment. A segment is flushed early
   * once its accumulated records reach this many bytes, so very large payloads
   * still produce bounded segment files. Default 64 MiB.
   */
  maxSegmentBytes?: number;
}

export type RawEvidenceCompactionStatus =
  | "compacted"
  | "planned"
  | "skipped"
  | "aborted";

/** Sanitized result of a compaction attempt: counts, sequences, and status only. */
export interface RawEvidenceCompactionResult {
  status: RawEvidenceCompactionStatus;
  dryRun: boolean;
  reason?: string;
  generation: number;
  throughSequence: number;
  chunkFilesBefore: number;
  chunkFilesFolded: number;
  chunkFilesRemaining: number;
  recordsRetained: number;
  pendingProjectionRetained: number;
  deadLetteredRetained: number;
  historyEntriesRetained: number;
  /** Encrypted record segment files written for the published generation. */
  recordSegmentsWritten: number;
  /** Encrypted history segment files written for the published generation. */
  historySegmentsWritten: number;
  occurredAt: string;
}

/** Sanitized snapshot of the store's compaction posture for status reporting. */
export interface RawEvidenceMaintenanceStatus {
  tenantId: string;
  productId: string;
  generation: number;
  lastCompactedAt: string | null;
  compactedThroughSequence: number;
  nextTransactionSequence: number;
  chunkFileCount: number;
  recordCount: number;
  pendingProjectionCount: number;
  deadLetterCount: number;
  historyEntryCount: number;
}

type PersistedCheckpointMutation =
  | { operation: "unchanged" }
  | { operation: "clear" }
  | { operation: "set"; value: SyncCheckpoint };

interface PersistedCommitTransaction {
  kind: "raw-evidence-transaction";
  transactionVersion: number;
  sequence: number;
  connectorId: string;
  records: PersistedRecordEntry[];
  projectionKeys: string[];
  checkpoint: PersistedCheckpointMutation;
  history: RawEvidenceHistoryEntry;
}

interface PersistedProjectionAckTransaction {
  kind: "raw-evidence-projection-ack";
  transactionVersion: number;
  sequence: number;
  idempotencyKeys: string[];
}

interface PersistedProjectionFailureTransaction {
  kind: "raw-evidence-projection-failure";
  transactionVersion: number;
  sequence: number;
  failures: Array<ProjectionFailureMetadata & { deadLettered: boolean }>;
}

interface PersistedProjectionRequeueTransaction {
  kind: "raw-evidence-projection-requeue";
  transactionVersion: number;
  sequence: number;
  idempotencyKeys: string[];
}

type PersistedTransaction =
  | PersistedCommitTransaction
  | PersistedProjectionAckTransaction
  | PersistedProjectionFailureTransaction
  | PersistedProjectionRequeueTransaction;

interface MemorySnapshot {
  connectorId: string;
  recordOrderLength: number;
  historyLength: number;
  hadCheckpoint: boolean;
  checkpoint?: SyncCheckpoint;
}

/**
 * Injectable low-level durable operations. Production callers should use the
 * default implementation; the option exists to test crash boundaries.
 */
export interface PersistFsOperations {
  /** Writes and fsyncs `contents` before resolving. */
  writeFileDurable(path: string, contents: string): Promise<void>;
  /** Atomically renames `oldPath` to `newPath`. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Best-effort directory fsync, except that unexpected errors propagate. */
  syncDirectory(path: string): Promise<void>;
  /** Removes a temp file, without failing when it is already absent. */
  removeTempFile(path: string): Promise<void>;
}

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    process.platform === "win32"
    && typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "EPERM"
  );
}

export const nodeFsOperations: PersistFsOperations = {
  async writeFileDurable(path, contents) {
    const handle = await openFileHandle(path, "w");
    try {
      await handle.writeFile(contents, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },

  async rename(oldPath, newPath) {
    await renameFile(oldPath, newPath);
  },

  async syncDirectory(path) {
    const handle = await openFileHandle(path, "r");
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    } finally {
      await handle.close();
    }
  },

  async removeTempFile(path) {
    await removeFile(path, { recursive: true, force: true });
  },
};

export interface PersistentRawEvidenceStoreOptions extends RawEvidenceStoreOptions {
  dataDirectory: string;
  keyRef: string;
  resolveKey: KeyResolver;
  fsOperations?: PersistFsOperations;
  onDurabilityWarning?: (warning: DurabilityWarning) => void;
  /**
   * Cooperative event-loop yield invoked during durable-state replay. Defaults
   * to a `setImmediate`-backed Promise. Injectable so tests can observe (and
   * count) yields; production callers should not override it.
   */
  replayYield?: () => void | Promise<void>;
  /**
   * Number of transaction files / compacted segments applied between
   * cooperative yields during replay. Must be a positive integer. Default 100.
   */
  replayYieldInterval?: number;
}

export class PersistentRawEvidenceStore extends InMemoryRawEvidenceStore {
  /** Backward-compatible base-snapshot path. New commits never rewrite it. */
  readonly storagePath: string;
  readonly keyRef: string;
  private readonly dataDirectory: string;
  private readonly resolveKey: KeyResolver;
  private readonly legacyTempPath: string;
  private readonly legacyRejectedTempMarkerPath: string;
  private readonly transactionDirectory: string;
  private readonly transactionTempPath: string;
  private readonly transactionRejectedTempMarkerPath: string;
  private readonly scopeDirectory: string;
  private readonly compactedBasePath: string;
  private readonly compactedBaseTempPath: string;
  private readonly compactedDirectory: string;
  private readonly compactedManifestPath: string;
  private readonly compactedManifestTempPath: string;
  private readonly fsOperations: PersistFsOperations;
  private readonly onDurabilityWarning?: (warning: DurabilityWarning) => void;
  private readonly replayYield: () => void | Promise<void>;
  private readonly replayYieldInterval: number;
  private initialized = false;
  private nextTransactionSequence = 1;
  private compactionBaselineSequence = 0;
  private compactionGeneration = 0;
  private lastCompactedAt: string | null = null;
  private activeGenerationDir: string | null = null;
  private _lastDurabilityWarning: DurabilityWarning | null = null;
  private commitChain: Promise<void> = Promise.resolve();

  constructor(options: PersistentRawEvidenceStoreOptions) {
    super(options);
    if (!options.dataDirectory || !options.dataDirectory.trim()) {
      throw new TypeError("dataDirectory must not be empty");
    }
    if (typeof options.keyRef !== "string" || !CREDENTIAL_REF_PATTERN.test(options.keyRef)) {
      throw new TypeError('keyRef must match "secret://..." or "env://..."');
    }
    if (typeof options.resolveKey !== "function") {
      throw new TypeError("resolveKey must be a function");
    }

    this.dataDirectory = options.dataDirectory;
    this.keyRef = options.keyRef;
    this.resolveKey = options.resolveKey;
    this.fsOperations = options.fsOperations ?? nodeFsOperations;
    this.onDurabilityWarning = options.onDurabilityWarning;
    this.replayYield = options.replayYield ?? defaultReplayYield;
    if (
      options.replayYieldInterval !== undefined
      && (!Number.isSafeInteger(options.replayYieldInterval) || options.replayYieldInterval < 1)
    ) {
      throw new TypeError("replayYieldInterval must be a positive integer");
    }
    this.replayYieldInterval = options.replayYieldInterval ?? DEFAULT_REPLAY_YIELD_INTERVAL;
    this.scopeDirectory = join(this.dataDirectory, this.tenantId, this.productId);
    this.storagePath = join(this.scopeDirectory, FILE_NAME);
    this.legacyTempPath = join(this.scopeDirectory, LEGACY_TEMP_FILE_NAME);
    this.legacyRejectedTempMarkerPath = `${this.legacyTempPath}.rejected`;
    this.transactionDirectory = join(this.scopeDirectory, TRANSACTION_DIRECTORY_NAME);
    this.transactionTempPath = join(this.transactionDirectory, TRANSACTION_TEMP_FILE_NAME);
    this.transactionRejectedTempMarkerPath = `${this.transactionTempPath}.rejected`;
    this.compactedBasePath = join(this.scopeDirectory, COMPACTED_BASE_FILE_NAME);
    this.compactedBaseTempPath = join(this.scopeDirectory, COMPACTED_BASE_TEMP_FILE_NAME);
    this.compactedDirectory = join(this.scopeDirectory, COMPACTED_DIRECTORY_NAME);
    this.compactedManifestPath = join(this.compactedDirectory, COMPACTED_MANIFEST_FILE_NAME);
    this.compactedManifestTempPath = join(
      this.compactedDirectory,
      COMPACTED_MANIFEST_TEMP_FILE_NAME,
    );
    mkdirSync(this.scopeDirectory, { recursive: true });
  }

  async initialize(): Promise<this> {
    if (this.initialized) return this;
    await this.recoverRejectedTemp(
      this.legacyTempPath,
      this.legacyRejectedTempMarkerPath,
      "snapshot",
    );
    await this.recoverLegacyTemporarySnapshot();
    await this.recoverRejectedTemp(
      this.transactionTempPath,
      this.transactionRejectedTempMarkerPath,
      "transaction",
    );
    await this.discardCompactedBaseTemp();
    await this.discardCompactedManifestTemp();
    await this.loadDurableState();
    await this.recoverPendingTransaction();
    await this.cleanupSupersededGenerations();
    await this.cleanupFoldedTransactions();
    this.initialized = true;
    return this;
  }

  override async commit(request: RawEvidenceCommitRequest): Promise<RawEvidenceCommitResult> {
    this.assertInitialized();
    return this.runExclusively(() => this.commitExclusively(request));
  }

  private runExclusively<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commitChain.then(operation, operation);
    this.commitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async commitExclusively(
    request: RawEvidenceCommitRequest,
  ): Promise<RawEvidenceCommitResult> {
    const before = this.captureMemory(request.connectorId);
    try {
      const result = this.commitInMemory(request);
      const durabilityWarning = await this.persistTransaction(request, before);
      if (!durabilityWarning) {
        this._lastDurabilityWarning = null;
        return result;
      }
      this._lastDurabilityWarning = durabilityWarning;
      this.reportDurabilityWarning(durabilityWarning);
      return { ...result, durabilityWarning };
    } catch (error) {
      this.restoreMemory(before);
      throw error;
    }
  }

  get lastDurabilityWarning(): DurabilityWarning | null {
    return this._lastDurabilityWarning;
  }

  private reportDurabilityWarning(warning: DurabilityWarning): void {
    if (!this.onDurabilityWarning) return;
    try {
      this.onDurabilityWarning(warning);
    } catch {
      // A warning sink cannot change an already-committed result.
    }
  }

  override getCheckpoint(connectorId: string): SyncCheckpoint | undefined {
    this.assertInitialized();
    return super.getCheckpoint(connectorId);
  }

  override getRecord(idempotencyKey: string): RawEvidenceRecord | undefined {
    this.assertInitialized();
    return super.getRecord(idempotencyKey);
  }

  override listPendingProjectionRecords(limit?: number): RawEvidenceRecord[] {
    this.assertInitialized();
    return super.listPendingProjectionRecords(limit);
  }

  override countPendingProjectionRecords(): number {
    this.assertInitialized();
    return super.countPendingProjectionRecords();
  }

  override async acknowledgeProjected(idempotencyKeys: string[]): Promise<void> {
    this.assertInitialized();
    await this.runExclusively(async () => {
      const acknowledged = this.selectPendingProjectionKeys(idempotencyKeys);
      if (acknowledged.length === 0) return;
      await this.persistProjectionAcknowledgement(acknowledged);
      this.acknowledgeProjectedInMemory(acknowledged);
    });
  }

  override async recordProjectionFailures(
    idempotencyKeys: string[],
  ): Promise<ProjectionFailureResult> {
    this.assertInitialized();
    return this.runExclusively(async () => {
      const updates = this.buildProjectionFailureUpdates(idempotencyKeys);
      if (updates.length === 0) return { failedCount: 0, deadLetteredCount: 0 };
      await this.persistProjectionFailures(updates.map(({ idempotencyKey, state, deadLettered }) => ({
        idempotencyKey,
        connectorId: this.entries.get(idempotencyKey)!.connectorId,
        ...state,
        deadLettered,
      })));
      return this.applyProjectionFailureUpdates(updates);
    });
  }

  override countDeadLetterProjectionRecords(): number {
    this.assertInitialized();
    return super.countDeadLetterProjectionRecords();
  }

  override listDeadLetterProjectionRecords(limit?: number): ProjectionFailureMetadata[] {
    this.assertInitialized();
    return super.listDeadLetterProjectionRecords(limit);
  }

  override async requeueDeadLetterProjectionRecords(idempotencyKeys: string[]): Promise<number> {
    this.assertInitialized();
    return this.runExclusively(async () => {
      const keys = this.selectDeadLetterKeysForRequeue(idempotencyKeys);
      if (keys.length === 0) return 0;
      await this.persistProjectionRequeue(keys);
      return this.applyDeadLetterRequeue(keys);
    });
  }

  override listRecords(filter?: RawEvidenceListFilter): RawEvidenceRecord[] {
    this.assertInitialized();
    return super.listRecords(filter);
  }

  override countRecords(filter?: RawEvidenceListFilter): number {
    this.assertInitialized();
    return super.countRecords(filter);
  }

  override sourceInventory(): RawEvidenceSourceInventoryEntry[] {
    this.assertInitialized();
    return super.sourceInventory();
  }

  override pageRecords(request?: RawEvidencePageRequest): RawEvidencePage {
    this.assertInitialized();
    return super.pageRecords(request);
  }

  override history(connectorId?: string): RawEvidenceHistoryEntry[] {
    this.assertInitialized();
    return super.history(connectorId);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "PersistentRawEvidenceStore was not initialized; use createPersistentRawEvidenceStore "
          + "or call initialize() before use",
      );
    }
  }

  private get scope(): { tenantId: string; productId: string } {
    return { tenantId: this.tenantId, productId: this.productId };
  }

  private captureMemory(connectorId: string): MemorySnapshot {
    return {
      connectorId,
      recordOrderLength: this.recordOrder.length,
      historyLength: this.historyEntries.length,
      hadCheckpoint: this.checkpoints.has(connectorId),
      checkpoint: this.checkpoints.get(connectorId),
    };
  }

  private restoreMemory(snapshot: MemorySnapshot): void {
    const appendedKeys = this.recordOrder.slice(snapshot.recordOrderLength);
    for (const key of appendedKeys) {
      this.entries.delete(key);
      this.pendingProjectionKeys.delete(key);
    }
    this.recordOrder.splice(snapshot.recordOrderLength);
    if (snapshot.hadCheckpoint) {
      this.checkpoints.set(snapshot.connectorId, snapshot.checkpoint!);
    } else {
      this.checkpoints.delete(snapshot.connectorId);
    }
    this.historyEntries.splice(snapshot.historyLength);
  }

  private buildTransaction(
    request: RawEvidenceCommitRequest,
    before: MemorySnapshot,
  ): PersistedCommitTransaction {
    const records = this.recordOrder.slice(before.recordOrderLength).map((idempotencyKey) => {
      const entry = this.entries.get(idempotencyKey)!;
      return { idempotencyKey, connectorId: entry.connectorId, record: entry.record };
    });
    let checkpoint: PersistedCheckpointMutation;
    if (request.checkpoint === undefined) {
      checkpoint = { operation: "unchanged" };
    } else if (request.checkpoint === null) {
      checkpoint = { operation: "clear" };
    } else {
      checkpoint = {
        operation: "set",
        value: this.checkpoints.get(request.connectorId)!,
      };
    }
    return {
      kind: "raw-evidence-transaction",
      transactionVersion: COMMIT_TRANSACTION_VERSION,
      sequence: this.nextTransactionSequence,
      connectorId: request.connectorId,
      records,
      projectionKeys: records.map(({ idempotencyKey }) => idempotencyKey),
      checkpoint,
      history: this.historyEntries.at(-1)!,
    };
  }

  private async persistTransaction(
    request: RawEvidenceCommitRequest,
    before: MemorySnapshot,
  ): Promise<DurabilityWarning | null> {
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const transaction = this.buildTransaction(request, before);
    return this.persistEncryptedTransaction(transaction, request.connectorId, key);
  }

  private async persistProjectionAcknowledgement(
    idempotencyKeys: string[],
  ): Promise<void> {
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const transaction: PersistedProjectionAckTransaction = {
      kind: "raw-evidence-projection-ack",
      transactionVersion: PROJECTION_ACK_TRANSACTION_VERSION,
      sequence: this.nextTransactionSequence,
      idempotencyKeys,
    };
    const warning = await this.persistEncryptedTransaction(transaction, "projection", key);
    if (warning) {
      this._lastDurabilityWarning = warning;
      this.reportDurabilityWarning(warning);
    }
  }

  private async persistProjectionFailures(
    failures: Array<ProjectionFailureMetadata & { deadLettered: boolean }>,
  ): Promise<void> {
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const transaction: PersistedProjectionFailureTransaction = {
      kind: "raw-evidence-projection-failure",
      transactionVersion: PROJECTION_FAILURE_TRANSACTION_VERSION,
      sequence: this.nextTransactionSequence,
      failures,
    };
    const warning = await this.persistEncryptedTransaction(transaction, "projection", key);
    if (warning) {
      this._lastDurabilityWarning = warning;
      this.reportDurabilityWarning(warning);
    }
  }

  private async persistProjectionRequeue(idempotencyKeys: string[]): Promise<void> {
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const transaction: PersistedProjectionRequeueTransaction = {
      kind: "raw-evidence-projection-requeue",
      transactionVersion: PROJECTION_REQUEUE_TRANSACTION_VERSION,
      sequence: this.nextTransactionSequence,
      idempotencyKeys,
    };
    const warning = await this.persistEncryptedTransaction(transaction, "projection", key);
    if (warning) {
      this._lastDurabilityWarning = warning;
      this.reportDurabilityWarning(warning);
    }
  }

  private async persistEncryptedTransaction(
    transaction: PersistedTransaction,
    connectorId: string,
    key: Buffer,
  ): Promise<DurabilityWarning | null> {
    const envelope = encryptEnvelope(transaction, key, {
      tenantId: this.tenantId,
      productId: this.productId,
      schemaVersion: SCHEMA_VERSION,
      keyRef: this.keyRef,
    });
    const contents = `${JSON.stringify(envelope, null, 2)}\n`;
    const targetPath = this.transactionPath(transaction.sequence);
    const warningTimestamp = this.now();

    mkdirSync(this.transactionDirectory, { recursive: true });
    if (existsSync(targetPath)) {
      throw new Error(
        `Raw evidence transaction ${transaction.sequence} already exists for `
          + `${this.tenantId}/${this.productId}`,
      );
    }

    try {
      await this.fsOperations.writeFileDurable(this.transactionTempPath, contents);
      await this.fsOperations.rename(this.transactionTempPath, targetPath);
    } catch (error) {
      await this.quarantineFailedTempWrite(
        this.transactionTempPath,
        this.transactionRejectedTempMarkerPath,
        this.transactionDirectory,
      );
      throw error;
    }

    this.nextTransactionSequence += 1;
    try {
      await this.fsOperations.syncDirectory(this.transactionDirectory);
      return null;
    } catch (error) {
      return this.buildDurabilityWarning(connectorId, error, warningTimestamp);
    }
  }

  private transactionPath(sequence: number): string {
    return join(
      this.transactionDirectory,
      `${String(sequence).padStart(TRANSACTION_FILE_DIGITS, "0")}.json`,
    );
  }

  private buildDurabilityWarning(
    connectorId: string,
    error: unknown,
    occurredAt: string,
  ): DurabilityWarning {
    const errorCode =
      typeof error === "object"
      && error !== null
      && typeof (error as { code?: unknown }).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    return {
      stage: "directory-sync",
      connectorId,
      occurredAt,
      message:
        "Commit succeeded and its encrypted transaction is durable, but the containing "
        + "directory entry update could not be confirmed synced (best-effort directory "
        + "fsync failed after the commit point).",
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private async quarantineFailedTempWrite(
    tempPath: string,
    markerPath: string,
    directory: string,
  ): Promise<void> {
    const markerEstablished = await this.establishRejectedTempMarkerDurably(markerPath, directory);
    try {
      await this.fsOperations.removeTempFile(tempPath);
      await this.fsOperations.syncDirectory(directory);
      if (markerEstablished) {
        this.removeRejectedTempMarker(markerPath);
        await this.fsOperations.syncDirectory(directory);
      }
      return;
    } catch {
      // The marker or poison fallback below prevents later promotion.
    }
    if (!markerEstablished) await this.poisonRejectedTempFile(tempPath);
  }

  private async establishRejectedTempMarkerDurably(
    markerPath: string,
    directory: string,
  ): Promise<boolean> {
    try {
      await this.fsOperations.writeFileDurable(markerPath, "");
      await this.fsOperations.syncDirectory(directory);
      return true;
    } catch {
      return false;
    }
  }

  private async poisonRejectedTempFile(tempPath: string): Promise<void> {
    try {
      await this.fsOperations.writeFileDurable(
        tempPath,
        "REJECTED-COMMIT-TOMBSTONE: this temp file belongs to an explicitly rejected "
          + "commit and must never be authenticated or promoted.\n",
      );
    } catch {
      // Best effort after both durable marking and removal failed.
    }
  }

  private removeRejectedTempMarker(markerPath: string): void {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      // Best effort; a marker without its temp file is harmless.
    }
  }

  private async recoverRejectedTemp(
    tempPath: string,
    markerPath: string,
    description: string,
  ): Promise<void> {
    if (!existsSync(markerPath)) return;
    if (existsSync(tempPath)) {
      try {
        await this.fsOperations.removeTempFile(tempPath);
      } catch (error) {
        throw new Error(
          `Raw evidence store found a temp ${description} from an explicitly rejected commit `
            + `for ${this.tenantId}/${this.productId} that could not be removed on startup; `
            + "refusing to start rather than risk resurrecting a rejected transaction",
          { cause: error },
        );
      }
    }
    this.removeRejectedTempMarker(markerPath);
  }

  /**
   * Preserves recovery for pre-chunk releases that could leave a full
   * `raw-evidence-store.json.tmp` snapshot behind.
   */
  private async recoverLegacyTemporarySnapshot(): Promise<void> {
    if (!existsSync(this.legacyTempPath)) return;

    if (existsSync(this.storagePath)) {
      const durableEnvelope = readEnvelopeFile(this.storagePath);
      const durable = await this.decryptUsableEnvelope(durableEnvelope);
      assertPersistedContentShape(durable);
      rmSync(this.legacyTempPath);
      return;
    }

    const envelope = readEnvelopeFile(this.legacyTempPath);
    const content = await this.decryptUsableEnvelope(envelope);
    assertPersistedContentShape(content);
    renameSync(this.legacyTempPath, this.storagePath);
  }

  private async loadDurableState(): Promise<void> {
    const key = await this.resolveLoadKeyIfNeeded();

    // A published segmented generation is authoritative: its manifest is only
    // live once every segment file is durable, and it folds the legacy base,
    // any monolithic compacted base, and every transaction through
    // `throughSequence`, together with the full projection/dead-letter state.
    const manifest = existsSync(this.compactedManifestPath)
      ? await this.readManifest(key ?? undefined)
      : null;
    if (manifest) {
      await this.applyCompactedGeneration(manifest, key ?? undefined);
      this.compactionBaselineSequence = manifest.throughSequence;
      this.compactionGeneration = manifest.generation;
      this.lastCompactedAt = manifest.createdAt;
      this.activeGenerationDir = manifest.generationDir;
    } else if (existsSync(this.compactedBasePath)) {
      // Backward compatibility: a monolithic compacted base written by an
      // earlier release. Read it, but never write a new one.
      const envelope = readEnvelopeFile(this.compactedBasePath);
      const snapshot = assertCompactedBaseShape(
        await this.decryptUsableEnvelope(envelope, key ?? undefined),
      );
      this.applyCompactedBase(snapshot);
      this.compactionBaselineSequence = snapshot.throughSequence;
      this.compactionGeneration = snapshot.generation;
      this.lastCompactedAt = snapshot.createdAt;
    } else if (existsSync(this.storagePath)) {
      const envelope = readEnvelopeFile(this.storagePath);
      const content = assertPersistedContentShape(
        await this.decryptUsableEnvelope(envelope, key ?? undefined),
      );
      this.applyBaseSnapshot(content);
    }

    this.nextTransactionSequence = this.compactionBaselineSequence + 1;
    if (!existsSync(this.transactionDirectory)) return;
    const transactionFiles = readdirSync(this.transactionDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TRANSACTION_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    let expectedSequence = this.compactionBaselineSequence + 1;
    let replayedSinceYield = 0;
    for (const fileName of transactionFiles) {
      const match = TRANSACTION_FILE_PATTERN.exec(fileName)!;
      const fileSequence = Number(match[1]);
      // Transactions at or below the compaction baseline are a folded (stale)
      // generation left behind by a crash between publishing the compacted
      // base and deleting the old chunks. They are already represented in the
      // base; skip them here and let `cleanupFoldedTransactions` remove them.
      if (fileSequence <= this.compactionBaselineSequence) continue;
      if (fileSequence !== expectedSequence) {
        throw new TypeError(
          `Raw evidence transaction sequence is not contiguous: expected ${expectedSequence}, `
            + `found ${fileSequence}`,
        );
      }
      const envelope = readEnvelopeFile(join(this.transactionDirectory, fileName));
      const transaction = assertPersistedTransactionShape(
        await this.decryptUsableEnvelope(envelope, key ?? undefined),
      );
      if (transaction.sequence !== fileSequence) {
        throw new TypeError("Raw evidence transaction sequence does not match its file name");
      }
      this.applyTransaction(transaction, expectedSequence);
      expectedSequence += 1;
      // Cooperative yield: return to the macrotask/I-O queue at a bounded
      // interval so a very large replay cannot starve unrelated requests. This
      // is purely a scheduling boundary; ordering and integrity are unchanged.
      replayedSinceYield += 1;
      if (replayedSinceYield >= this.replayYieldInterval) {
        replayedSinceYield = 0;
        await this.replayYield();
      }
    }
    this.nextTransactionSequence = expectedSequence;
  }

  private async resolveLoadKeyIfNeeded(): Promise<Buffer | null> {
    if (
      !existsSync(this.storagePath)
      && !existsSync(this.compactedBasePath)
      && !existsSync(this.compactedManifestPath)
      && !this.hasTransactionFiles()
    ) {
      return null;
    }
    return resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
  }

  private hasTransactionFiles(): boolean {
    if (!existsSync(this.transactionDirectory)) return false;
    return readdirSync(this.transactionDirectory, { withFileTypes: true })
      .some((entry) => entry.isFile() && TRANSACTION_FILE_PATTERN.test(entry.name));
  }

  private applyBaseSnapshot(content: PersistedContent): void {
    for (const item of content.records) {
      this.entries.set(item.idempotencyKey, {
        connectorId: item.connectorId,
        record: item.record,
      });
      this.recordOrder.push(item.idempotencyKey);
      this.pendingProjectionKeys.add(item.idempotencyKey);
    }
    for (const [connectorId, checkpoint] of Object.entries(content.checkpoints)) {
      this.checkpoints.set(connectorId, checkpoint);
    }
    this.historyEntries.push(...content.history);
  }

  private applyCompactedBase(snapshot: CompactedBaseSnapshot): void {
    for (const item of snapshot.records) {
      assertRawEvidenceRecord(item.record);
      if (item.record.tenantId !== this.tenantId || item.record.productId !== this.productId) {
        throw new TypeError("Raw evidence compacted base record does not match the store scope");
      }
      if (this.entries.has(item.idempotencyKey)) {
        throw new TypeError("Raw evidence compacted base contains a duplicate record");
      }
      this.entries.set(item.idempotencyKey, {
        connectorId: item.connectorId,
        record: item.record,
      });
      this.recordOrder.push(item.idempotencyKey);
    }
    for (const key of snapshot.pendingProjectionKeys) {
      if (!this.entries.has(key)) {
        throw new TypeError("Raw evidence compacted base pending key does not reference a record");
      }
      this.pendingProjectionKeys.add(key);
    }
    for (const [connectorId, checkpoint] of Object.entries(snapshot.checkpoints)) {
      this.checkpoints.set(connectorId, checkpoint);
    }
    this.historyEntries.push(...snapshot.history);
    for (const failure of snapshot.projectionFailures) {
      const entry = this.entries.get(failure.idempotencyKey);
      if (!entry || entry.connectorId !== failure.connectorId) {
        throw new TypeError(
          "Raw evidence compacted base failure does not reference the expected record",
        );
      }
      this.projectionFailures.set(failure.idempotencyKey, {
        failureCode: failure.failureCode,
        attemptCount: failure.attemptCount,
        firstFailedAt: failure.firstFailedAt,
        lastFailedAt: failure.lastFailedAt,
      });
      if (failure.deadLettered) {
        this.deadLetterProjectionKeys.add(failure.idempotencyKey);
      }
    }
  }

  /** Reads, decrypts, and validates the live segmented manifest, if present. */
  private async readManifest(key?: Buffer): Promise<CompactedManifest> {
    const envelope = readEnvelopeFile(this.compactedManifestPath);
    return assertCompactedManifestShape(await this.decryptUsableEnvelope(envelope, key));
  }

  private generationDirectory(generationDir: string): string {
    return join(this.compactedDirectory, generationDir);
  }

  private recordSegmentPath(generationDir: string, segmentIndex: number): string {
    return join(
      this.generationDirectory(generationDir),
      `${RECORD_SEGMENT_FILE_PREFIX}${String(segmentIndex).padStart(SEGMENT_FILE_DIGITS, "0")}.json`,
    );
  }

  private historySegmentPath(generationDir: string, segmentIndex: number): string {
    return join(
      this.generationDirectory(generationDir),
      `${HISTORY_SEGMENT_FILE_PREFIX}${String(segmentIndex).padStart(SEGMENT_FILE_DIGITS, "0")}.json`,
    );
  }

  /**
   * Loads a published segmented generation incrementally: one bounded segment
   * file is decrypted and applied at a time, so peak memory is one segment plus
   * the store's own resident state -- never a second whole-dataset snapshot.
   * Every record's pending/failure/dead-letter state travels inline, and the
   * manifest's declared counts are checked so a truncated or tampered
   * generation is rejected rather than silently under-applied.
   */
  private async applyCompactedGeneration(manifest: CompactedManifest, key?: Buffer): Promise<void> {
    let appliedRecords = 0;
    let appliedPending = 0;
    let appliedDeadLettered = 0;
    for (let segmentIndex = 0; segmentIndex < manifest.recordSegmentCount; segmentIndex += 1) {
      const path = this.recordSegmentPath(manifest.generationDir, segmentIndex);
      const segment = assertCompactedRecordSegmentShape(
        await this.decryptUsableEnvelope(readEnvelopeFile(path), key),
      );
      if (segment.segmentIndex !== segmentIndex) {
        throw new TypeError("Raw evidence compacted segment index does not match its file name");
      }
      if (segment.generation !== manifest.generation) {
        throw new TypeError("Raw evidence compacted segment belongs to a different generation");
      }
      for (const item of segment.entries) {
        assertRawEvidenceRecord(item.record);
        if (item.record.tenantId !== this.tenantId || item.record.productId !== this.productId) {
          throw new TypeError("Raw evidence compacted segment record does not match the store scope");
        }
        if (this.entries.has(item.idempotencyKey)) {
          throw new TypeError("Raw evidence compacted generation contains a duplicate record");
        }
        this.entries.set(item.idempotencyKey, {
          connectorId: item.connectorId,
          record: item.record,
        });
        this.recordOrder.push(item.idempotencyKey);
        if (item.pending) {
          this.pendingProjectionKeys.add(item.idempotencyKey);
          appliedPending += 1;
        }
        if (item.failure) {
          this.projectionFailures.set(item.idempotencyKey, {
            failureCode: item.failure.failureCode,
            attemptCount: item.failure.attemptCount,
            firstFailedAt: item.failure.firstFailedAt,
            lastFailedAt: item.failure.lastFailedAt,
          });
          if (item.failure.deadLettered) {
            this.deadLetterProjectionKeys.add(item.idempotencyKey);
            appliedDeadLettered += 1;
          }
        }
        appliedRecords += 1;
      }
      // Yield after each bounded record segment so a large segmented
      // generation replay does not monopolise the event loop.
      await this.replayYield();
    }
    if (appliedRecords !== manifest.recordCount) {
      throw new TypeError("Raw evidence compacted generation record count does not match its manifest");
    }
    if (appliedPending !== manifest.pendingProjectionCount) {
      throw new TypeError("Raw evidence compacted generation pending count does not match its manifest");
    }
    if (appliedDeadLettered !== manifest.deadLetterCount) {
      throw new TypeError("Raw evidence compacted generation dead-letter count does not match its manifest");
    }

    let appliedHistory = 0;
    for (let segmentIndex = 0; segmentIndex < manifest.historySegmentCount; segmentIndex += 1) {
      const path = this.historySegmentPath(manifest.generationDir, segmentIndex);
      const segment = assertCompactedHistorySegmentShape(
        await this.decryptUsableEnvelope(readEnvelopeFile(path), key),
      );
      if (segment.segmentIndex !== segmentIndex) {
        throw new TypeError("Raw evidence compacted history segment index does not match its file name");
      }
      if (segment.generation !== manifest.generation) {
        throw new TypeError("Raw evidence compacted history segment belongs to a different generation");
      }
      for (const entry of segment.history) {
        this.historyEntries.push(entry);
        appliedHistory += 1;
      }
      // Yield after each bounded history segment for the same reason.
      await this.replayYield();
    }
    if (appliedHistory !== manifest.historyCount) {
      throw new TypeError("Raw evidence compacted generation history count does not match its manifest");
    }

    for (const [connectorId, checkpoint] of Object.entries(manifest.checkpoints)) {
      this.checkpoints.set(connectorId, checkpoint);
    }
  }


  /**
   * Atomically folds the current durable generation (legacy base / prior
   * generation + chunks `1..throughSequence`) into a new **segmented**
   * compacted generation: bounded, independently encrypted record and history
   * segment files, published by a small atomic manifest written last. Only
   * after the manifest is durable are the folded chunks and any superseded
   * prior generation or monolithic base removed. Non-destructive: no raw
   * evidence, pending projection work, dead-letter entry, checkpoint, history
   * entry, idempotency behavior, or provenance is dropped. Serialized with
   * commits/acks/failures/requeues on this instance via the same in-process
   * lock, and safe to re-run after a crash (see `initialize`).
   */
  async compact(options: RawEvidenceCompactionOptions = {}): Promise<RawEvidenceCompactionResult> {
    this.assertInitialized();
    const minChunkFiles = options.minChunkFiles ?? DEFAULT_MIN_CHUNK_FILES_TO_COMPACT;
    const maxChunkFiles = options.maxChunkFiles ?? DEFAULT_MAX_CHUNK_FILES_TO_COMPACT;
    const maxRecordsPerSegment = options.maxRecordsPerSegment ?? DEFAULT_MAX_RECORDS_PER_SEGMENT;
    const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    if (!Number.isSafeInteger(minChunkFiles) || minChunkFiles < 1) {
      throw new TypeError("minChunkFiles must be a positive integer");
    }
    if (!Number.isSafeInteger(maxChunkFiles) || maxChunkFiles < 1) {
      throw new TypeError("maxChunkFiles must be a positive integer");
    }
    if (maxChunkFiles < minChunkFiles) {
      throw new TypeError("maxChunkFiles must be greater than or equal to minChunkFiles");
    }
    if (!Number.isSafeInteger(maxRecordsPerSegment) || maxRecordsPerSegment < 1) {
      throw new TypeError("maxRecordsPerSegment must be a positive integer");
    }
    if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1) {
      throw new TypeError("maxSegmentBytes must be a positive integer");
    }
    const dryRun = options.dryRun === true;
    return this.runExclusively(() =>
      this.compactExclusively({ dryRun, minChunkFiles, maxChunkFiles, maxRecordsPerSegment, maxSegmentBytes }),
    );
  }

  private async compactExclusively(
    { dryRun, minChunkFiles, maxChunkFiles, maxRecordsPerSegment, maxSegmentBytes }: {
      dryRun: boolean;
      minChunkFiles: number;
      maxChunkFiles: number;
      maxRecordsPerSegment: number;
      maxSegmentBytes: number;
    },
  ): Promise<RawEvidenceCompactionResult> {
    const occurredAt = this.now();
    const chunkSequences = this.listChunkFileSequences();
    const chunkFilesBefore = chunkSequences.length;
    const base = (status: RawEvidenceCompactionStatus, reason?: string): RawEvidenceCompactionResult => ({
      status,
      dryRun,
      ...(reason ? { reason } : {}),
      generation: this.compactionGeneration,
      throughSequence: this.compactionBaselineSequence,
      chunkFilesBefore,
      chunkFilesFolded: 0,
      chunkFilesRemaining: chunkFilesBefore,
      recordsRetained: this.recordOrder.length,
      pendingProjectionRetained: this.pendingProjectionKeys.size,
      deadLetteredRetained: this.deadLetterProjectionKeys.size,
      historyEntriesRetained: this.historyEntries.length,
      recordSegmentsWritten: 0,
      historySegmentsWritten: 0,
      occurredAt,
    });

    if (chunkFilesBefore < minChunkFiles) {
      return base("skipped", "below-threshold");
    }
    if (chunkFilesBefore > maxChunkFiles) {
      return base("aborted", "exceeds-max-chunk-files");
    }

    const throughSequence = this.nextTransactionSequence - 1;
    const generation = this.compactionGeneration + 1;
    if (dryRun) {
      return {
        ...base("planned"),
        generation,
        throughSequence,
        chunkFilesFolded: chunkFilesBefore,
        chunkFilesRemaining: 0,
      };
    }

    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const { recordSegments, historySegments } = await this.publishCompactedGeneration(
      throughSequence,
      generation,
      occurredAt,
      key,
      maxRecordsPerSegment,
      maxSegmentBytes,
    );

    // Durability point reached: the manifest is live and every segment it
    // names is durable. From here the operation is idempotent -- a crash
    // before cleanup leaves superseded chunks/generations that `initialize`
    // ignores (never double-applied) and re-deletes.
    this.compactionBaselineSequence = throughSequence;
    this.compactionGeneration = generation;
    this.lastCompactedAt = occurredAt;
    this.activeGenerationDir = generationDirectoryName(generation);

    await this.cleanupSupersededGenerations();
    const removed = await this.deleteFoldedChunkFiles(throughSequence);

    return {
      status: "compacted",
      dryRun: false,
      generation,
      throughSequence,
      chunkFilesBefore,
      chunkFilesFolded: removed,
      chunkFilesRemaining: this.listChunkFileSequences().length,
      recordsRetained: this.recordOrder.length,
      pendingProjectionRetained: this.pendingProjectionKeys.size,
      deadLetteredRetained: this.deadLetterProjectionKeys.size,
      historyEntriesRetained: this.historyEntries.length,
      recordSegmentsWritten: recordSegments,
      historySegmentsWritten: historySegments,
      occurredAt,
    };
  }

  /**
   * Streams the resident state into bounded, encrypted segment files and then
   * publishes the atomic manifest. Records are written one bounded segment at a
   * time directly from `recordOrder`, so no second whole-dataset array or
   * whole-dataset `JSON.stringify` is ever created. The manifest is renamed
   * into place only after every segment file and the generation directory entry
   * are fsynced.
   */
  private async publishCompactedGeneration(
    throughSequence: number,
    generation: number,
    createdAt: string,
    key: Buffer,
    maxRecordsPerSegment: number,
    maxSegmentBytes: number,
  ): Promise<{ recordSegments: number; historySegments: number }> {
    const generationDir = generationDirectoryName(generation);
    const generationPath = this.generationDirectory(generationDir);
    mkdirSync(this.compactedDirectory, { recursive: true });
    // Discard any orphan directory from a prior failed attempt at this same
    // generation number, so stale segment files can never be mistaken for the
    // new generation.
    try {
      await this.fsOperations.removeTempFile(generationPath);
    } catch {
      // Best effort; the manifest's segment counts bound what load reads.
    }
    mkdirSync(generationPath, { recursive: true });

    let recordSegments = 0;
    let historySegments = 0;
    try {
      let pendingProjectionCount = 0;
      let deadLetterCount = 0;
      let batch: PersistedSegmentRecordEntry[] = [];
      let batchBytes = 0;
      const flushRecords = async (): Promise<void> => {
        if (batch.length === 0) return;
        await this.writeSegmentFile(
          this.recordSegmentPath(generationDir, recordSegments),
          {
            kind: COMPACTED_RECORD_SEGMENT_KIND,
            version: COMPACTED_GENERATION_VERSION,
            generation,
            segmentIndex: recordSegments,
            entries: batch,
          },
          key,
        );
        recordSegments += 1;
        batch = [];
        batchBytes = 0;
      };
      for (const idempotencyKey of this.recordOrder) {
        const entry = this.buildSegmentRecordEntry(idempotencyKey);
        if (entry.pending) pendingProjectionCount += 1;
        if (entry.failure?.deadLettered) deadLetterCount += 1;
        batch.push(entry);
        batchBytes += estimateSerializedBytes(entry);
        if (batch.length >= maxRecordsPerSegment || batchBytes >= maxSegmentBytes) {
          await flushRecords();
        }
      }
      await flushRecords();

      let historyBatch: RawEvidenceHistoryEntry[] = [];
      let historyBytes = 0;
      const flushHistory = async (): Promise<void> => {
        if (historyBatch.length === 0) return;
        await this.writeSegmentFile(
          this.historySegmentPath(generationDir, historySegments),
          {
            kind: COMPACTED_HISTORY_SEGMENT_KIND,
            version: COMPACTED_GENERATION_VERSION,
            generation,
            segmentIndex: historySegments,
            history: historyBatch,
          },
          key,
        );
        historySegments += 1;
        historyBatch = [];
        historyBytes = 0;
      };
      for (const historyEntry of this.historyEntries) {
        historyBatch.push(historyEntry);
        historyBytes += estimateSerializedBytes(historyEntry);
        if (historyBatch.length >= DEFAULT_MAX_HISTORY_PER_SEGMENT || historyBytes >= maxSegmentBytes) {
          await flushHistory();
        }
      }
      await flushHistory();

      // Make the segment files and the generation directory entry durable
      // before the manifest can point at them.
      await this.fsOperations.syncDirectory(generationPath);
      await this.fsOperations.syncDirectory(this.compactedDirectory);

      const manifest: CompactedManifest = {
        kind: COMPACTED_MANIFEST_KIND,
        version: COMPACTED_GENERATION_VERSION,
        generation,
        throughSequence,
        createdAt,
        generationDir,
        recordCount: this.recordOrder.length,
        recordSegmentCount: recordSegments,
        historyCount: this.historyEntries.length,
        historySegmentCount: historySegments,
        pendingProjectionCount,
        deadLetterCount,
        checkpoints: Object.fromEntries(this.checkpoints),
      };
      await this.writeSegmentFile(this.compactedManifestTempPath, manifest, key);
      await this.fsOperations.rename(this.compactedManifestTempPath, this.compactedManifestPath);
    } catch (error) {
      // Nothing was published (no live manifest names this generation), so the
      // pre-compaction generation and its chunks remain fully intact. Discard
      // the orphan temp/dir best-effort; `initialize` also re-cleans them.
      await this.fsOperations.removeTempFile(this.compactedManifestTempPath).catch(() => {});
      await this.fsOperations.removeTempFile(generationPath).catch(() => {});
      throw error;
    }
    await this.fsOperations.syncDirectory(this.compactedDirectory);
    return { recordSegments, historySegments };
  }

  private buildSegmentRecordEntry(idempotencyKey: string): PersistedSegmentRecordEntry {
    const entry = this.entries.get(idempotencyKey)!;
    const segmentEntry: PersistedSegmentRecordEntry = {
      idempotencyKey,
      connectorId: entry.connectorId,
      record: entry.record,
      pending: this.pendingProjectionKeys.has(idempotencyKey),
    };
    const failureState = this.projectionFailures.get(idempotencyKey);
    if (failureState) {
      segmentEntry.failure = {
        failureCode: failureState.failureCode,
        attemptCount: failureState.attemptCount,
        firstFailedAt: failureState.firstFailedAt,
        lastFailedAt: failureState.lastFailedAt,
        deadLettered: this.deadLetterProjectionKeys.has(idempotencyKey),
      };
    }
    return segmentEntry;
  }

  private async writeSegmentFile(path: string, payload: unknown, key: Buffer): Promise<void> {
    const envelope = encryptEnvelope(payload, key, {
      tenantId: this.tenantId,
      productId: this.productId,
      schemaVersion: SCHEMA_VERSION,
      keyRef: this.keyRef,
    });
    await this.fsOperations.writeFileDurable(path, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  /**
   * Removes compacted generations that the live manifest has superseded, plus
   * any monolithic base a segmented generation now subsumes. When no manifest
   * is live every generation directory is an unpublished orphan (a crash before
   * publish) and is removed. Called both at end of a successful compaction and
   * on startup, so incomplete/unpublished generations are always cleaned up and
   * never loaded.
   */
  private async cleanupSupersededGenerations(): Promise<void> {
    if (!existsSync(this.compactedDirectory)) return;
    const generationDirs = readdirSync(this.compactedDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && GENERATION_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    let removedAny = false;
    for (const name of generationDirs) {
      if (this.activeGenerationDir !== null && name === this.activeGenerationDir) continue;
      try {
        await this.fsOperations.removeTempFile(this.generationDirectory(name));
        removedAny = true;
      } catch {
        // Leaving a superseded/orphan generation behind is safe: it is never
        // named by the live manifest, so it is never loaded, and a later
        // restart or compaction removes it.
      }
    }
    // A live segmented generation supersedes any monolithic compacted base.
    if (this.activeGenerationDir !== null && existsSync(this.compactedBasePath)) {
      try {
        await this.fsOperations.removeTempFile(this.compactedBasePath);
        removedAny = true;
      } catch {
        // Safe to leave: load prefers the segmented manifest over a monolithic base.
      }
    }
    if (removedAny) {
      try {
        await this.fsOperations.syncDirectory(this.compactedDirectory);
      } catch {
        // Directory fsync is best-effort; the removals are already durable enough.
      }
    }
  }

  private async discardCompactedManifestTemp(): Promise<void> {
    if (!existsSync(this.compactedManifestTempPath)) return;
    // A manifest temp that was never atomically renamed is, by definition, not
    // the live pointer and may be incomplete. Its generation directory (if any)
    // is an unpublished orphan cleaned by `cleanupSupersededGenerations`.
    await this.fsOperations.removeTempFile(this.compactedManifestTempPath);
    try {
      await this.fsOperations.syncDirectory(this.compactedDirectory);
    } catch {
      // Best-effort: the temp path is never read as a live manifest regardless.
    }
  }

  /** Sanitized compaction posture for status/progress reporting. */
  maintenanceStatus(): RawEvidenceMaintenanceStatus {
    this.assertInitialized();
    return {
      tenantId: this.tenantId,
      productId: this.productId,
      generation: this.compactionGeneration,
      lastCompactedAt: this.lastCompactedAt,
      compactedThroughSequence: this.compactionBaselineSequence,
      nextTransactionSequence: this.nextTransactionSequence,
      chunkFileCount: this.listChunkFileSequences().length,
      recordCount: this.recordOrder.length,
      pendingProjectionCount: this.pendingProjectionKeys.size,
      deadLetterCount: this.deadLetterProjectionKeys.size,
      historyEntryCount: this.historyEntries.length,
    };
  }

  private listChunkFileSequences(): number[] {
    if (!existsSync(this.transactionDirectory)) return [];
    return readdirSync(this.transactionDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TRANSACTION_FILE_PATTERN.test(entry.name))
      .map((entry) => Number(TRANSACTION_FILE_PATTERN.exec(entry.name)![1]))
      .sort((left, right) => left - right);
  }

  private async deleteFoldedChunkFiles(throughSequence: number): Promise<number> {
    let removed = 0;
    for (const sequence of this.listChunkFileSequences()) {
      if (sequence > throughSequence) continue;
      try {
        await this.fsOperations.removeTempFile(this.transactionPath(sequence));
        removed += 1;
      } catch {
        // Leaving a folded chunk behind is safe: it is subsumed by the
        // compacted base and a later restart or compaction removes it.
      }
    }
    if (removed > 0) {
      try {
        await this.fsOperations.syncDirectory(this.transactionDirectory);
      } catch {
        // Directory fsync is best-effort; the unlink is already durable enough
        // that the folded chunk is never re-applied (it is at/below baseline).
      }
    }
    return removed;
  }

  private async cleanupFoldedTransactions(): Promise<void> {
    if (this.compactionBaselineSequence === 0) return;
    await this.deleteFoldedChunkFiles(this.compactionBaselineSequence);
  }

  private async discardCompactedBaseTemp(): Promise<void> {
    if (!existsSync(this.compactedBaseTempPath)) return;
    // A compacted base temp that was never atomically renamed is, by
    // definition, not the live base and may be incomplete. The pre-compaction
    // generation (legacy base + chunks) is fully intact, so discarding the
    // temp loses nothing and avoids ever promoting an unverified snapshot.
    await this.fsOperations.removeTempFile(this.compactedBaseTempPath);
    try {
      await this.fsOperations.syncDirectory(this.scopeDirectory);
    } catch {
      // Best-effort: the temp path is never read as a live base regardless.
    }
  }

  private applyTransaction(transaction: PersistedTransaction, expectedSequence: number): void {
    if (transaction.sequence !== expectedSequence) {
      throw new TypeError(
        `Raw evidence transaction sequence is not contiguous: expected ${expectedSequence}, `
          + `found ${transaction.sequence}`,
      );
    }
    if (transaction.kind === "raw-evidence-projection-ack") {
      this.acknowledgeProjectedInMemory(transaction.idempotencyKeys);
      return;
    }
    if (transaction.kind === "raw-evidence-projection-failure") {
      for (const failure of transaction.failures) {
        const entry = this.entries.get(failure.idempotencyKey);
        if (!entry || entry.connectorId !== failure.connectorId) {
          throw new TypeError(
            "Raw evidence projection failure does not reference the expected record",
          );
        }
        const previous = this.projectionFailures.get(failure.idempotencyKey);
        if (
          failure.attemptCount !== (previous?.attemptCount ?? 0) + 1
          || failure.firstFailedAt !== (previous?.firstFailedAt ?? failure.lastFailedAt)
        ) {
          throw new TypeError("Raw evidence projection failure attempts are not contiguous");
        }
      }
      this.applyProjectionFailureUpdates(transaction.failures.map((failure) => ({
        idempotencyKey: failure.idempotencyKey,
        state: {
          failureCode: failure.failureCode,
          attemptCount: failure.attemptCount,
          firstFailedAt: failure.firstFailedAt,
          lastFailedAt: failure.lastFailedAt,
        },
        deadLettered: failure.deadLettered,
      })));
      return;
    }
    if (transaction.kind === "raw-evidence-projection-requeue") {
      if (
        transaction.idempotencyKeys.some(
          (key) => !this.entries.has(key) || !this.deadLetterProjectionKeys.has(key),
        )
      ) {
        throw new TypeError("Raw evidence projection requeue does not reference a dead-letter record");
      }
      this.applyDeadLetterRequeue(transaction.idempotencyKeys);
      return;
    }
    if (transaction.history.connectorId !== transaction.connectorId) {
      throw new TypeError("Raw evidence transaction history connector does not match transaction");
    }
    if (transaction.history.committedCount !== transaction.records.length) {
      throw new TypeError("Raw evidence transaction record count does not match its history");
    }
    if (transaction.history.id !== `history:${this.historyEntries.length + 1}`) {
      throw new TypeError("Raw evidence transaction history is not contiguous with durable state");
    }

    for (const item of transaction.records) {
      assertRawEvidenceRecord(item.record);
      if (item.connectorId !== transaction.connectorId) {
        throw new TypeError("Raw evidence transaction record connector does not match transaction");
      }
      if (
        item.record.tenantId !== this.tenantId
        || item.record.productId !== this.productId
      ) {
        throw new TypeError("Raw evidence transaction record does not match the store scope");
      }
      if (this.entries.has(item.idempotencyKey)) {
        throw new TypeError("Raw evidence transaction attempts to append an existing record");
      }
      this.entries.set(item.idempotencyKey, {
        connectorId: item.connectorId,
        record: item.record,
      });
      this.recordOrder.push(item.idempotencyKey);
    }
    const projectionKeys = transaction.transactionVersion < 2
      ? transaction.records.map(({ idempotencyKey }) => idempotencyKey)
      : transaction.projectionKeys;
    for (const key of projectionKeys) {
      if (!this.entries.has(key)) {
        throw new TypeError("Raw evidence transaction projection key does not reference a record");
      }
      this.pendingProjectionKeys.add(key);
    }

    if (transaction.checkpoint.operation === "clear") {
      this.checkpoints.delete(transaction.connectorId);
    } else if (transaction.checkpoint.operation === "set") {
      this.checkpoints.set(transaction.connectorId, transaction.checkpoint.value);
    }
    this.historyEntries.push(transaction.history);
  }

  private async recoverPendingTransaction(): Promise<void> {
    if (!existsSync(this.transactionTempPath)) return;
    const envelope = readEnvelopeFile(this.transactionTempPath);
    const transaction = assertPersistedTransactionShape(
      await this.decryptUsableEnvelope(envelope),
    );
    const targetPath = this.transactionPath(transaction.sequence);

    if (transaction.sequence < this.nextTransactionSequence) {
      if (!existsSync(targetPath)) {
        throw new TypeError("Raw evidence temp transaction refers to a missing durable transaction");
      }
      await this.fsOperations.removeTempFile(this.transactionTempPath);
      return;
    }
    if (transaction.sequence > this.nextTransactionSequence) {
      throw new TypeError(
        `Raw evidence temp transaction sequence ${transaction.sequence} is ahead of expected `
          + `${this.nextTransactionSequence}`,
      );
    }

    await this.fsOperations.rename(this.transactionTempPath, targetPath);
    this.applyTransaction(transaction, this.nextTransactionSequence);
    this.nextTransactionSequence += 1;
  }

  private async decryptUsableEnvelope(
    envelope: EncryptedEnvelope,
    resolvedKey?: Buffer,
  ): Promise<unknown> {
    assertEnvelopeScope(envelope, this.tenantId, this.productId);
    assertSupportedEnvelopeVersion(envelope);
    assertSupportedSchemaVersion(envelope, SCHEMA_VERSION);
    if (envelope.keyRef !== this.keyRef) {
      throw new TypeError(
        `Raw evidence snapshot key reference does not match configured keyRef for `
          + `${this.tenantId}/${this.productId}`,
      );
    }
    const key =
      resolvedKey ?? await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    return decryptEnvelope(envelope, key);
  }
}

function readEnvelopeFile(path: string): EncryptedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new TypeError("Raw evidence snapshot envelope is not valid JSON");
  }
  assertEnvelopeShape(parsed);
  return parsed;
}

function assertPersistedContentShape(value: unknown): PersistedContent {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence snapshot content must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.records) || !Array.isArray(candidate.history)) {
    throw new TypeError("Raw evidence snapshot content has an invalid shape");
  }
  if (typeof candidate.checkpoints !== "object" || candidate.checkpoints === null) {
    throw new TypeError("Raw evidence snapshot content has an invalid shape");
  }
  return candidate as unknown as PersistedContent;
}

function assertCompactedBaseShape(value: unknown): CompactedBaseSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence compacted base must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== COMPACTED_BASE_KIND) {
    throw new TypeError("Raw evidence compacted base has an invalid kind");
  }
  if (
    typeof candidate.version !== "number"
    || !Number.isSafeInteger(candidate.version)
    || candidate.version < 1
  ) {
    throw new TypeError("Raw evidence compacted base has an invalid version");
  }
  if (candidate.version > COMPACTED_BASE_VERSION) {
    throw new TypeError(
      `Raw evidence compacted base version ${candidate.version} is newer than supported `
        + `version ${COMPACTED_BASE_VERSION}`,
    );
  }
  if (
    !Number.isSafeInteger(candidate.throughSequence)
    || (candidate.throughSequence as number) < 0
    || !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) < 1
    || typeof candidate.createdAt !== "string"
    || !Array.isArray(candidate.records)
    || !Array.isArray(candidate.history)
    || typeof candidate.checkpoints !== "object"
    || candidate.checkpoints === null
    || !Array.isArray(candidate.pendingProjectionKeys)
    || !candidate.pendingProjectionKeys.every((key) => typeof key === "string" && key.length > 0)
    || !Array.isArray(candidate.projectionFailures)
    || !candidate.projectionFailures.every(isPersistedProjectionFailure)
  ) {
    throw new TypeError("Raw evidence compacted base has an invalid shape");
  }
  return candidate as unknown as CompactedBaseSnapshot;
}

function generationDirectoryName(generation: number): string {
  return `${GENERATION_DIRECTORY_PREFIX}${String(generation).padStart(GENERATION_DIRECTORY_DIGITS, "0")}`;
}

function estimateSerializedBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function assertCompactedManifestShape(value: unknown): CompactedManifest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence compacted manifest must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== COMPACTED_MANIFEST_KIND) {
    throw new TypeError("Raw evidence compacted manifest has an invalid kind");
  }
  assertGenerationVersion(candidate.version, "manifest");
  if (
    !Number.isSafeInteger(candidate.throughSequence)
    || (candidate.throughSequence as number) < 0
    || !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) < 1
    || typeof candidate.createdAt !== "string"
    || typeof candidate.generationDir !== "string"
    || !GENERATION_DIRECTORY_PATTERN.test(candidate.generationDir)
    || !isNonNegativeInteger(candidate.recordCount)
    || !isNonNegativeInteger(candidate.recordSegmentCount)
    || !isNonNegativeInteger(candidate.historyCount)
    || !isNonNegativeInteger(candidate.historySegmentCount)
    || !isNonNegativeInteger(candidate.pendingProjectionCount)
    || !isNonNegativeInteger(candidate.deadLetterCount)
    || typeof candidate.checkpoints !== "object"
    || candidate.checkpoints === null
    || Array.isArray(candidate.checkpoints)
  ) {
    throw new TypeError("Raw evidence compacted manifest has an invalid shape");
  }
  if (
    generationDirectoryName(candidate.generation as number) !== candidate.generationDir
  ) {
    throw new TypeError("Raw evidence compacted manifest generation does not match its directory");
  }
  if ((candidate.recordCount as number) > 0 && (candidate.recordSegmentCount as number) < 1) {
    throw new TypeError("Raw evidence compacted manifest is missing record segments");
  }
  if ((candidate.historyCount as number) > 0 && (candidate.historySegmentCount as number) < 1) {
    throw new TypeError("Raw evidence compacted manifest is missing history segments");
  }
  return candidate as unknown as CompactedManifest;
}

function assertCompactedRecordSegmentShape(value: unknown): CompactedRecordSegment {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence compacted segment must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== COMPACTED_RECORD_SEGMENT_KIND) {
    throw new TypeError("Raw evidence compacted segment has an invalid kind");
  }
  assertGenerationVersion(candidate.version, "segment");
  if (
    !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) < 1
    || !isNonNegativeInteger(candidate.segmentIndex)
    || !Array.isArray(candidate.entries)
    || !candidate.entries.every(isPersistedSegmentRecordEntry)
  ) {
    throw new TypeError("Raw evidence compacted segment has an invalid shape");
  }
  return candidate as unknown as CompactedRecordSegment;
}

function assertCompactedHistorySegmentShape(value: unknown): CompactedHistorySegment {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence compacted history segment must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== COMPACTED_HISTORY_SEGMENT_KIND) {
    throw new TypeError("Raw evidence compacted history segment has an invalid kind");
  }
  assertGenerationVersion(candidate.version, "history segment");
  if (
    !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) < 1
    || !isNonNegativeInteger(candidate.segmentIndex)
    || !Array.isArray(candidate.history)
    || !candidate.history.every((entry) => typeof entry === "object" && entry !== null)
  ) {
    throw new TypeError("Raw evidence compacted history segment has an invalid shape");
  }
  return candidate as unknown as CompactedHistorySegment;
}

function assertGenerationVersion(version: unknown, label: string): void {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`Raw evidence compacted ${label} has an invalid version`);
  }
  if (version > COMPACTED_GENERATION_VERSION) {
    throw new TypeError(
      `Raw evidence compacted ${label} version ${version} is newer than supported `
        + `version ${COMPACTED_GENERATION_VERSION}`,
    );
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPersistedSegmentRecordEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.idempotencyKey !== "string"
    || entry.idempotencyKey.length === 0
    || typeof entry.connectorId !== "string"
    || entry.connectorId.length === 0
    || typeof entry.record !== "object"
    || entry.record === null
    || typeof entry.pending !== "boolean"
  ) {
    return false;
  }
  if (entry.failure === undefined) return true;
  if (typeof entry.failure !== "object" || entry.failure === null) return false;
  const failure = entry.failure as Record<string, unknown>;
  return (
    failure.failureCode === "projection-failed"
    && Number.isSafeInteger(failure.attemptCount)
    && (failure.attemptCount as number) >= 1
    && typeof failure.firstFailedAt === "string"
    && Number.isFinite(Date.parse(failure.firstFailedAt))
    && typeof failure.lastFailedAt === "string"
    && Number.isFinite(Date.parse(failure.lastFailedAt))
    && typeof failure.deadLettered === "boolean"
  );
}

function assertPersistedTransactionShape(value: unknown): PersistedTransaction {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Raw evidence transaction content must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!isSupportedTransactionHeader(candidate) || typeof candidate.kind !== "string") {
    throw new TypeError("Raw evidence transaction content has an invalid shape");
  }
  const transactionVersion = candidate.transactionVersion as number;
  assertSupportedTransactionVersion(transactionVersion);

  if (candidate.kind === "raw-evidence-projection-ack") {
    assertTransactionVersionForKind(candidate.kind, transactionVersion, [1, 2]);
    if (
      !Array.isArray(candidate.idempotencyKeys)
      || !candidate.idempotencyKeys.every(
        (key) => typeof key === "string" && key.length > 0,
      )
    ) {
      throw new TypeError("Raw evidence projection acknowledgement has an invalid shape");
    }
    return candidate as unknown as PersistedProjectionAckTransaction;
  }

  if (candidate.kind === "raw-evidence-projection-failure") {
    assertTransactionVersionForKind(candidate.kind, transactionVersion, [3]);
    if (
      !Array.isArray(candidate.failures)
      || !candidate.failures.every(isPersistedProjectionFailure)
    ) {
      throw new TypeError("Raw evidence projection failure has an invalid shape");
    }
    return candidate as unknown as PersistedProjectionFailureTransaction;
  }

  if (candidate.kind === "raw-evidence-projection-requeue") {
    assertTransactionVersionForKind(candidate.kind, transactionVersion, [3]);
    if (
      !Array.isArray(candidate.idempotencyKeys)
      || !candidate.idempotencyKeys.every(
        (key) => typeof key === "string" && key.length > 0,
      )
    ) {
      throw new TypeError("Raw evidence projection requeue has an invalid shape");
    }
    return candidate as unknown as PersistedProjectionRequeueTransaction;
  }

  if (candidate.kind !== "raw-evidence-transaction") {
    throw new TypeError(`Raw evidence transaction kind "${candidate.kind}" is not supported`);
  }
  assertTransactionVersionForKind(candidate.kind, transactionVersion, [1, 2]);
  if (
    typeof candidate.connectorId !== "string"
    || !Array.isArray(candidate.records)
    || typeof candidate.checkpoint !== "object"
    || candidate.checkpoint === null
    || typeof candidate.history !== "object"
    || candidate.history === null
  ) {
    throw new TypeError("Raw evidence transaction content has an invalid shape");
  }
  const checkpoint = candidate.checkpoint as Record<string, unknown>;
  if (
    checkpoint.operation !== "unchanged"
    && checkpoint.operation !== "clear"
    && checkpoint.operation !== "set"
  ) {
    throw new TypeError("Raw evidence transaction checkpoint mutation is invalid");
  }
  if (
    checkpoint.operation === "set"
    && (
      typeof checkpoint.value !== "object"
      || checkpoint.value === null
      || Array.isArray(checkpoint.value)
    )
  ) {
    throw new TypeError("Raw evidence transaction checkpoint value is invalid");
  }
  if (
    (transactionVersion >= 2 && candidate.projectionKeys === undefined)
    || (
      candidate.projectionKeys !== undefined
      && (
        !Array.isArray(candidate.projectionKeys)
        || !candidate.projectionKeys.every((key) => typeof key === "string" && key.length > 0)
      )
    )
  ) {
    throw new TypeError("Raw evidence transaction projection keys are invalid");
  }
  return {
    ...candidate,
    projectionKeys: candidate.projectionKeys ?? [],
  } as unknown as PersistedCommitTransaction;
}

function isSupportedTransactionHeader(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.transactionVersion === "number"
    && Number.isSafeInteger(candidate.transactionVersion)
    && candidate.transactionVersion >= 1
    && typeof candidate.sequence === "number"
    && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence >= 1
  );
}

function assertSupportedTransactionVersion(transactionVersion: number): void {
  if (transactionVersion > LATEST_TRANSACTION_VERSION) {
    throw new TypeError(
      `Raw evidence transaction version ${transactionVersion} is newer than supported `
        + `version ${LATEST_TRANSACTION_VERSION}`,
    );
  }
}

function assertTransactionVersionForKind(
  kind: string,
  transactionVersion: number,
  supportedVersions: readonly number[],
): void {
  if (!supportedVersions.includes(transactionVersion)) {
    throw new TypeError(
      `Raw evidence transaction kind "${kind}" is not supported at version `
        + `${transactionVersion}; supported version(s): ${supportedVersions.join(", ")}`,
    );
  }
}

function isPersistedProjectionFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const failure = value as Record<string, unknown>;
  return (
    typeof failure.idempotencyKey === "string"
    && failure.idempotencyKey.length > 0
    && typeof failure.connectorId === "string"
    && failure.connectorId.length > 0
    && failure.failureCode === "projection-failed"
    && Number.isSafeInteger(failure.attemptCount)
    && (failure.attemptCount as number) >= 1
    && typeof failure.firstFailedAt === "string"
    && Number.isFinite(Date.parse(failure.firstFailedAt))
    && typeof failure.lastFailedAt === "string"
    && Number.isFinite(Date.parse(failure.lastFailedAt))
    && typeof failure.deadLettered === "boolean"
  );
}

export async function createPersistentRawEvidenceStore(
  options: PersistentRawEvidenceStoreOptions,
): Promise<PersistentRawEvidenceStore> {
  const store = new PersistentRawEvidenceStore(options);
  await store.initialize();
  return store;
}

export type { EncryptedEnvelope, KeyResolver } from "./crypto.ts";
