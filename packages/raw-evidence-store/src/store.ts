import type { RawEvidenceRecord, SyncCheckpoint } from "@tkl/contracts";
import { assertRawEvidenceRecord, stableJson } from "@tkl/contracts";

/**
 * Connector IDs identify the checkpoint/evidence namespace within a store scope.
 * Canonical plugin IDs (for example `connector.jira`, see `PLUGIN_ID_PATTERN` in
 * `@tkl/contracts`) use dot-separated segments, so this pattern allows internal
 * dots in addition to the plain `tenantId`/`productId` scope-ID alphabet, while
 * still requiring every dot-segment to start with a letter/number and rejecting
 * path separators plus leading/trailing/doubled dots or any other
 * traversal-style value.
 */
export const CONNECTOR_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * Boundary contracts for `ING-105`. `RawEvidenceStore` is the source-neutral
 * persistence boundary connectors commit unnormalized evidence and their sync
 * checkpoint into. It intentionally knows nothing about Jira/GitHub/TestRail;
 * connectors and the future coordinator (`ING-104`) depend on this contract, not
 * the reverse.
 */

export const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RawEvidenceStoreOptions {
  tenantId: string;
  productId: string;
  now?: () => string;
  projectionFailureThreshold?: number;
}

export interface RawEvidenceCommitRequest<TPayload = unknown> {
  /** Identifies the connector/scope owning this batch and its checkpoint namespace. */
  connectorId: string;
  records: RawEvidenceRecord<TPayload>[];
  /**
   * The connector's sync cursor after this batch. Pass `null` to clear a
   * checkpoint (for example, a full resync) or omit the field to leave the
   * existing checkpoint untouched.
   */
  checkpoint?: SyncCheckpoint | null;
}

export interface RawEvidenceCommitResult {
  connectorId: string;
  /** Records newly written by this commit (excludes replays of identical records). */
  committedCount: number;
  /** Records that were byte-for-byte identical to an already-stored record. */
  duplicateCount: number;
  totalCount: number;
  checkpointAdvanced: boolean;
  checkpoint: SyncCheckpoint | null;
  /** Exact idempotency keys accepted by this commit, in commit order. */
  committedIdempotencyKeys: string[];
  /**
   * Present only on a `PersistentRawEvidenceStore` commit that durably
   * committed (the rename succeeded) but hit a non-fatal durability issue
   * afterward (currently: a best-effort directory-fsync failure). The commit
   * itself is never rolled back or reported as failed for this; see
   * {@link DurabilityWarning}. Absent/`undefined` for a commit with no such
   * issue, and always absent on `InMemoryRawEvidenceStore`.
   */
  durabilityWarning?: DurabilityWarning;
}

/**
 * Sanitized, non-fatal durability notice for `ING-105`. The atomic rename
 * that promotes a `PersistentRawEvidenceStore` commit's encrypted transaction to durable
 * storage is that commit's durability point: once it succeeds, the
 * transaction is committed and must never be reported as failed or rolled
 * back. A directory-fsync failure *after* that rename only means the
 * rename's own directory-entry update could not be confirmed synced (an
 * extra safety margin against an immediate crash before the OS journals the
 * rename itself) -- it does not mean the commit was lost. This type carries
 * only identifiers/timestamps/error codes; it must never include record
 * payloads, checkpoint content, or key material.
 */
export interface DurabilityWarning {
  /** The durability step that could not be confirmed. Only one exists today. */
  stage: "directory-sync";
  /** The connector whose commit triggered the warning. Safe to log. */
  connectorId: string;
  /** ISO timestamp (from the store's clock) when the warning was recorded. */
  occurredAt: string;
  /** Fixed, sanitized description; never derived from the raw error message. */
  message: string;
  /** The underlying error's `code` (for example `"EIO"`), if it exposed one. */
  errorCode?: string;
}

export interface RawEvidenceHistoryEntry {
  id: string;
  connectorId: string;
  operation: "commit";
  recordCount: number;
  committedCount: number;
  duplicateCount: number;
  recordedAt: string;
}

export interface RawEvidenceListFilter {
  connectorId?: string;
  source?: string;
  /** Matches `String(record.sourceVersion)` exactly when provided. */
  sourceVersion?: string;
  /** Inclusive lower bound on `record.observedAt` (ISO-8601). */
  observedFrom?: string;
  /** Inclusive upper bound on `record.observedAt` (ISO-8601). */
  observedTo?: string;
}

/**
 * A bounded, durable-order page of records. `records` are immutable clones of
 * only the requested slice, so paging a large corpus never materializes or
 * deep-clones the whole dataset. `cursor` is the number of matching records
 * skipped before this page; `nextCursor` advances past the returned records.
 * `done` is true only when no further matching record exists after this page.
 */
export interface RawEvidencePage {
  records: RawEvidenceRecord[];
  cursor: number;
  nextCursor: number;
  done: boolean;
}

/** Options for a single bounded page request over stored records. */
export interface RawEvidencePageRequest {
  filter?: RawEvidenceListFilter;
  /** Matching records to skip before this page. Defaults to 0. */
  cursor?: number;
  /** Maximum records to clone into this page. Defaults to 100. */
  limit?: number;
}

/**
 * One aggregated, source-scoped row of durable inventory metadata. Produced by a
 * single bounded pass over the store's index fields ({@link RawEvidenceStore.sourceInventory}):
 * it reads only `source`, `observedAt`, and `connectorId` and never materializes,
 * decrypts, or clones a record payload, so it is safe over an arbitrarily large corpus.
 * `firstObservedAt`/`lastObservedAt` are the lexicographically smallest/largest ISO-8601
 * `observedAt` values seen for the source (or `null` when none were parseable).
 */
export interface RawEvidenceSourceInventoryEntry {
  source: string;
  recordCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  connectorIds: string[];
}

export interface ProjectionFailureMetadata {
  idempotencyKey: string;
  connectorId: string;
  failureCode: "projection-failed";
  attemptCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

export interface ProjectionFailureResult {
  failedCount: number;
  deadLetteredCount: number;
}

interface RawEvidenceStoreEntry {
  connectorId: string;
  record: RawEvidenceRecord;
}

interface ProjectionFailureState {
  failureCode: "projection-failed";
  attemptCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

const DEFAULT_PROJECTION_FAILURE_THRESHOLD = 3;
const MAX_PROJECTION_REQUEUE_BATCH_SIZE = 1_000;

/**
 * Raised when a record's idempotency key already exists in this store scope
 * with different content. Never includes payload or credential content, only
 * identifiers, so it is always safe to log.
 */
export class DuplicateEvidenceConflictError extends Error {
  readonly idempotencyKey: string;
  readonly connectorId: string;

  constructor(idempotencyKey: string, connectorId: string) {
    super(
      `Raw evidence idempotency key "${idempotencyKey}" for connector "${connectorId}" ` +
        "already exists with different content",
    );
    this.name = "DuplicateEvidenceConflictError";
    this.idempotencyKey = idempotencyKey;
    this.connectorId = connectorId;
  }
}

/** Raised when a record or snapshot does not belong to this store's tenant/product scope. */
export class RawEvidenceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawEvidenceScopeError";
  }
}

export interface RawEvidenceStore {
  readonly tenantId: string;
  readonly productId: string;

  /**
   * Atomically commits a batch of raw evidence records plus the connector's
   * checkpoint. Either every new record and the checkpoint update land together,
   * or none of them do: a same-key/different-content conflict anywhere in the
   * batch aborts the whole commit before anything is written.
   */
  commit(request: RawEvidenceCommitRequest): Promise<RawEvidenceCommitResult>;

  /** Returns an immutable copy of the connector's last committed checkpoint, if any. */
  getCheckpoint(connectorId: string): SyncCheckpoint | undefined;

  /** Returns an immutable copy of a stored record by its idempotency key. */
  getRecord(idempotencyKey: string): RawEvidenceRecord | undefined;

  /** Checks whether equivalent evidence is already present without cloning its payload. */
  hasEvidence(record: RawEvidenceRecord): boolean;

  /** Returns immutable copies of stored records in commit order, optionally filtered. */
  listRecords(filter?: RawEvidenceListFilter): RawEvidenceRecord[];

  /**
   * Counts matching records in durable order without cloning any record. Safe
   * for very large corpora: it reads only the identity/index fields needed to
   * evaluate the filter and never materializes payloads.
   */
  countRecords(filter?: RawEvidenceListFilter): number;

  /**
   * Returns one aggregated inventory row per distinct source in a single bounded
   * pass over durable index fields, without cloning, decrypting, or materializing
   * any record payload. Safe for very large corpora and used by the Knowledge
   * Inventory aggregate to report retained evidence counts and freshness per source.
   */
  sourceInventory(): RawEvidenceSourceInventoryEntry[];

  /**
   * Returns one bounded, durable-order page of matching records, cloning only
   * the records in that page. Together with {@link countRecords} this lets
   * callers reconcile or rebuild over an arbitrarily large corpus without ever
   * deep-cloning the full dataset.
   */
  pageRecords(request?: RawEvidencePageRequest): RawEvidencePage;

  /** Returns the next durable batch waiting for canonical projection. */
  listPendingProjectionRecords(limit?: number): RawEvidenceRecord[];

  /** Returns the pending projection count without scanning or copying the queue. */
  countPendingProjectionRecords(): number;

  /** Checks one idempotency key without materializing the pending queue. */
  hasPendingProjection(idempotencyKey: string): boolean;

  /** Durably marks raw evidence records as projected into canonical knowledge. */
  acknowledgeProjected(idempotencyKeys: string[]): Promise<void>;

  /**
   * Durably records one sanitized failure attempt for each pending key.
   * No raw error message, stack, payload, or source response is accepted.
   */
  recordProjectionFailures(idempotencyKeys: string[]): Promise<ProjectionFailureResult>;

  /** Returns the dead-letter count without scanning or copying the queue. */
  countDeadLetterProjectionRecords(): number;

  /** Returns bounded, sanitized dead-letter metadata without record payloads. */
  listDeadLetterProjectionRecords(limit?: number): ProjectionFailureMetadata[];

  /** Durably requeues a bounded set of dead-lettered records with a fresh attempt budget. */
  requeueDeadLetterProjectionRecords(idempotencyKeys: string[]): Promise<number>;

  /** Returns an immutable copy of the append-only commit history. */
  history(connectorId?: string): RawEvidenceHistoryEntry[];
}

/**
 * In-memory reference implementation. Useful for contract tests and as the base
 * class for the durable, encrypted `PersistentRawEvidenceStore`. Not durable and
 * must not be used in production.
 */
export class InMemoryRawEvidenceStore implements RawEvidenceStore {
  readonly tenantId: string;
  readonly productId: string;
  protected readonly now: () => string;
  protected readonly entries = new Map<string, RawEvidenceStoreEntry>();
  protected readonly recordOrder: string[] = [];
  protected readonly checkpoints = new Map<string, SyncCheckpoint>();
  protected readonly historyEntries: RawEvidenceHistoryEntry[] = [];
  protected readonly pendingProjectionKeys = new Set<string>();
  protected readonly projectionFailures = new Map<string, ProjectionFailureState>();
  protected readonly deadLetterProjectionKeys = new Set<string>();
  protected readonly projectionFailureThreshold: number;

  constructor(options: RawEvidenceStoreOptions) {
    assertScopeId("tenantId", options.tenantId);
    assertScopeId("productId", options.productId);
    if (
      options.projectionFailureThreshold !== undefined
      && (
        !Number.isSafeInteger(options.projectionFailureThreshold)
        || options.projectionFailureThreshold < 1
      )
    ) {
      throw new TypeError("projectionFailureThreshold must be a positive integer");
    }
    this.tenantId = options.tenantId;
    this.productId = options.productId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.projectionFailureThreshold =
      options.projectionFailureThreshold ?? DEFAULT_PROJECTION_FAILURE_THRESHOLD;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for durable subclasses
  async commit(request: RawEvidenceCommitRequest): Promise<RawEvidenceCommitResult> {
    return this.commitInMemory(request);
  }

  getCheckpoint(connectorId: string): SyncCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(connectorId);
    return checkpoint ? deepClone(checkpoint) : undefined;
  }

  getRecord(idempotencyKey: string): RawEvidenceRecord | undefined {
    const entry = this.entries.get(idempotencyKey);
    return entry ? deepClone(entry.record) : undefined;
  }

  hasEvidence(record: RawEvidenceRecord): boolean {
    return this.entries.has(rawEvidenceIdempotencyKey(record));
  }

  listRecords(filter: RawEvidenceListFilter = {}): RawEvidenceRecord[] {
    return this.recordOrder
      .map((key) => this.entries.get(key)!)
      .filter((entry) => matchesFilter(entry, filter))
      .map((entry) => deepClone(entry.record));
  }

  countRecords(filter: RawEvidenceListFilter = {}): number {
    let count = 0;
    for (const key of this.recordOrder) {
      if (matchesFilter(this.entries.get(key)!, filter)) count += 1;
    }
    return count;
  }

  sourceInventory(): RawEvidenceSourceInventoryEntry[] {
    const bySource = new Map<
      string,
      {
        recordCount: number;
        firstObservedAt: string | null;
        lastObservedAt: string | null;
        connectorIds: Set<string>;
      }
    >();
    for (const key of this.recordOrder) {
      const entry = this.entries.get(key)!;
      const source = entry.record.source;
      let aggregate = bySource.get(source);
      if (!aggregate) {
        aggregate = {
          recordCount: 0,
          firstObservedAt: null,
          lastObservedAt: null,
          connectorIds: new Set<string>(),
        };
        bySource.set(source, aggregate);
      }
      aggregate.recordCount += 1;
      aggregate.connectorIds.add(entry.connectorId);
      const observedAt = entry.record.observedAt;
      if (typeof observedAt === "string" && observedAt.length > 0) {
        if (aggregate.firstObservedAt === null || observedAt < aggregate.firstObservedAt) {
          aggregate.firstObservedAt = observedAt;
        }
        if (aggregate.lastObservedAt === null || observedAt > aggregate.lastObservedAt) {
          aggregate.lastObservedAt = observedAt;
        }
      }
    }
    return [...bySource.entries()]
      .map(([source, aggregate]) => ({
        source,
        recordCount: aggregate.recordCount,
        firstObservedAt: aggregate.firstObservedAt,
        lastObservedAt: aggregate.lastObservedAt,
        connectorIds: [...aggregate.connectorIds].sort(),
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  pageRecords(request: RawEvidencePageRequest = {}): RawEvidencePage {
    const { filter = {}, cursor = 0, limit = 100 } = request;
    assertPageCursor(cursor);
    assertProjectionLimit(limit);
    const records: RawEvidenceRecord[] = [];
    let matchedIndex = 0;
    let done = true;
    for (const key of this.recordOrder) {
      const entry = this.entries.get(key)!;
      if (!matchesFilter(entry, filter)) continue;
      if (matchedIndex < cursor) {
        matchedIndex += 1;
        continue;
      }
      if (records.length >= limit) {
        // At least one matching record exists beyond this page.
        done = false;
        break;
      }
      records.push(deepClone(entry.record));
      matchedIndex += 1;
    }
    return { records, cursor, nextCursor: cursor + records.length, done };
  }

  listPendingProjectionRecords(limit = 100): RawEvidenceRecord[] {
    assertProjectionLimit(limit);
    const records: RawEvidenceRecord[] = [];
    for (const key of this.pendingProjectionKeys) {
      records.push(deepClone(this.entries.get(key)!.record));
      if (records.length === limit) break;
    }
    return records;
  }

  countPendingProjectionRecords(): number {
    return this.pendingProjectionKeys.size;
  }

  hasPendingProjection(idempotencyKey: string): boolean {
    return this.pendingProjectionKeys.has(idempotencyKey);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- durable stores override this method
  async acknowledgeProjected(idempotencyKeys: string[]): Promise<void> {
    this.acknowledgeProjectedInMemory(idempotencyKeys);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- durable stores override this method
  async recordProjectionFailures(
    idempotencyKeys: string[],
  ): Promise<ProjectionFailureResult> {
    return this.recordProjectionFailuresInMemory(idempotencyKeys);
  }

  countDeadLetterProjectionRecords(): number {
    return this.deadLetterProjectionKeys.size;
  }

  listDeadLetterProjectionRecords(limit = 100): ProjectionFailureMetadata[] {
    assertProjectionLimit(limit);
    const failures: ProjectionFailureMetadata[] = [];
    for (const key of this.deadLetterProjectionKeys) {
      const state = this.projectionFailures.get(key)!;
      failures.push({
        idempotencyKey: key,
        connectorId: this.entries.get(key)!.connectorId,
        ...state,
      });
      if (failures.length === limit) break;
    }
    return failures;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- durable stores override this method
  async requeueDeadLetterProjectionRecords(idempotencyKeys: string[]): Promise<number> {
    return this.requeueDeadLetterProjectionRecordsInMemory(idempotencyKeys);
  }

  history(connectorId?: string): RawEvidenceHistoryEntry[] {
    return this.historyEntries
      .filter((entry) => !connectorId || entry.connectorId === connectorId)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Applies a commit synchronously to in-memory state and returns the result.
   * Validation (scope + conflicts) always runs before any mutation, so a
   * thrown error guarantees no partial mutation occurred. This also includes
   * deep-cloning/validating the checkpoint and evaluating `now()` *before* the
   * first mutation: a non-cloneable checkpoint (`DataCloneError` from
   * `structuredClone`) or a clock that throws must leave the store completely
   * untouched, the same as a mid-batch idempotency conflict. Callers
   * (including `PersistentRawEvidenceStore`, whose rollback wraps this entire
   * call) rely on "throws => no mutation happened" holding for every failure
   * mode, not just conflict errors.
   */
  protected commitInMemory(request: RawEvidenceCommitRequest): RawEvidenceCommitResult {
    assertConnectorId(request.connectorId);
    if (!Array.isArray(request.records)) {
      throw new TypeError("commit requires records to be an array");
    }

    const toApply: Array<{ key: string; entry: RawEvidenceStoreEntry }> = [];
    let duplicateCount = 0;

    for (const record of request.records) {
      assertRawEvidenceRecord(record);
      this.assertRecordScope(record);
      const key = rawEvidenceIdempotencyKey(record);
      const existing = this.entries.get(key) ?? toApply.find((item) => item.key === key)?.entry;
      if (existing) {
        if (isSameRecord(existing.record, record)) {
          duplicateCount += 1;
          continue;
        }
        throw new DuplicateEvidenceConflictError(key, request.connectorId);
      }
      toApply.push({ key, entry: { connectorId: request.connectorId, record: deepClone(record) } });
    }

    // Clone/validate the checkpoint and evaluate the clock now, before the
    // first mutation below. `deepClone` here (on a not-yet-stored value) can
    // throw `DataCloneError` for a non-structured-cloneable checkpoint, and a
    // caller-supplied `now()` can throw too; either must abort the whole
    // commit exactly like a validation failure above, not partway through
    // applying records/checkpoint/history.
    const nextCheckpoint =
      request.checkpoint !== undefined && request.checkpoint !== null
        ? deepClone(request.checkpoint)
        : request.checkpoint;
    const recordedAt = this.now();

    for (const { key, entry } of toApply) {
      this.entries.set(key, entry);
      this.recordOrder.push(key);
      this.pendingProjectionKeys.add(key);
    }

    let checkpointAdvanced = false;
    if (request.checkpoint !== undefined) {
      if (request.checkpoint === null) {
        this.checkpoints.delete(request.connectorId);
      } else {
        this.checkpoints.set(request.connectorId, nextCheckpoint as SyncCheckpoint);
      }
      checkpointAdvanced = true;
    }

    this.historyEntries.push({
      id: `history:${this.historyEntries.length + 1}`,
      connectorId: request.connectorId,
      operation: "commit",
      recordCount: request.records.length,
      committedCount: toApply.length,
      duplicateCount,
      recordedAt,
    });

    return {
      connectorId: request.connectorId,
      committedCount: toApply.length,
      duplicateCount,
      totalCount: request.records.length,
      checkpointAdvanced,
      checkpoint: this.checkpoints.has(request.connectorId)
        ? deepClone(this.checkpoints.get(request.connectorId)!)
        : null,
      committedIdempotencyKeys: toApply.map(({ key }) => key),
    };
  }

  protected assertRecordScope(record: RawEvidenceRecord): void {
    if (record.tenantId !== this.tenantId || record.productId !== this.productId) {
      throw new RawEvidenceScopeError(
        `Raw evidence record does not belong to store scope ${this.tenantId}/${this.productId}`,
      );
    }
  }

  protected acknowledgeProjectedInMemory(idempotencyKeys: string[]): string[] {
    const acknowledged = this.selectPendingProjectionKeys(idempotencyKeys);
    for (const key of acknowledged) {
      this.pendingProjectionKeys.delete(key);
      this.projectionFailures.delete(key);
    }
    return acknowledged;
  }

  protected selectPendingProjectionKeys(idempotencyKeys: string[]): string[] {
    return uniqueProjectionKeys(idempotencyKeys).filter(
      (key) => this.pendingProjectionKeys.has(key),
    );
  }

  protected buildProjectionFailureUpdates(
    idempotencyKeys: string[],
  ): Array<{ idempotencyKey: string; state: ProjectionFailureState; deadLettered: boolean }> {
    const keys = this.selectPendingProjectionKeys(idempotencyKeys);
    if (keys.length === 0) return [];
    const failedAt = this.now();
    if (typeof failedAt !== "string" || !Number.isFinite(Date.parse(failedAt))) {
      throw new TypeError("Projection failure timestamps must be valid date-time strings");
    }
    return keys.map((idempotencyKey) => {
      const previous = this.projectionFailures.get(idempotencyKey);
      const state: ProjectionFailureState = {
        failureCode: "projection-failed",
        attemptCount: (previous?.attemptCount ?? 0) + 1,
        firstFailedAt: previous?.firstFailedAt ?? failedAt,
        lastFailedAt: failedAt,
      };
      return {
        idempotencyKey,
        state,
        deadLettered: state.attemptCount >= this.projectionFailureThreshold,
      };
    });
  }

  protected applyProjectionFailureUpdates(
    updates: Array<{
      idempotencyKey: string;
      state: ProjectionFailureState;
      deadLettered: boolean;
    }>,
  ): ProjectionFailureResult {
    let deadLetteredCount = 0;
    for (const { idempotencyKey, state, deadLettered } of updates) {
      this.projectionFailures.set(idempotencyKey, state);
      this.pendingProjectionKeys.delete(idempotencyKey);
      if (deadLettered) {
        this.deadLetterProjectionKeys.add(idempotencyKey);
        deadLetteredCount += 1;
      } else {
        // Rotate retryable failures behind records not yet attempted in this drain pass.
        this.pendingProjectionKeys.add(idempotencyKey);
      }
    }
    return { failedCount: updates.length, deadLetteredCount };
  }

  protected recordProjectionFailuresInMemory(
    idempotencyKeys: string[],
  ): ProjectionFailureResult {
    return this.applyProjectionFailureUpdates(
      this.buildProjectionFailureUpdates(idempotencyKeys),
    );
  }

  protected selectDeadLetterKeysForRequeue(idempotencyKeys: string[]): string[] {
    const keys = uniqueProjectionKeys(idempotencyKeys, MAX_PROJECTION_REQUEUE_BATCH_SIZE);
    return keys.filter((key) => this.deadLetterProjectionKeys.has(key));
  }

  protected applyDeadLetterRequeue(idempotencyKeys: string[]): number {
    for (const key of idempotencyKeys) {
      this.deadLetterProjectionKeys.delete(key);
      this.projectionFailures.delete(key);
      this.pendingProjectionKeys.add(key);
    }
    return idempotencyKeys.length;
  }

  protected requeueDeadLetterProjectionRecordsInMemory(idempotencyKeys: string[]): number {
    return this.applyDeadLetterRequeue(this.selectDeadLetterKeysForRequeue(idempotencyKeys));
  }
}

export function assertScopeId(name: string, value: string): void {
  if (typeof value !== "string" || !SCOPE_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must use only letters, numbers, periods, underscores, or hyphens`);
  }
}

function assertConnectorId(value: string): void {
  if (typeof value !== "string" || !CONNECTOR_ID_PATTERN.test(value)) {
    throw new TypeError(
      "connectorId must use only letters, numbers, underscores, hyphens, or dot-separated " +
        "segments (for example \"connector.jira\"), with no path separators or traversal segments",
    );
  }
}

export function rawEvidenceIdempotencyKey(record: RawEvidenceRecord): string {
  if (typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0) {
    return record.idempotencyKey;
  }
  return `${record.source}:${record.sourceId}:${record.sourceVersion}`;
}

function assertProjectionLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Projection batch limit must be a positive integer");
  }
}

function assertPageCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError("Page cursor must be a non-negative integer");
  }
}

function uniqueProjectionKeys(idempotencyKeys: string[], maxLength?: number): string[] {
  if (!Array.isArray(idempotencyKeys)) {
    throw new TypeError("idempotencyKeys must be an array");
  }
  if (maxLength !== undefined && idempotencyKeys.length > maxLength) {
    throw new TypeError(`Projection operation accepts at most ${maxLength} keys`);
  }
  for (const key of idempotencyKeys) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Projection idempotency keys must be non-empty strings");
    }
  }
  return [...new Set(idempotencyKeys)];
}

/**
 * Compares two records under the same idempotency key for "same content"
 * duplicate detection. `observedAt` is excluded intentionally: it is the
 * timestamp of *observation*, not part of the source's immutable identity, so
 * a connector replaying the same key/content batch with a fresh `observedAt`
 * (for example a resumed page or a periodic re-sync of unchanged data) must
 * still be recognized as a duplicate. Every other field — tenant/product
 * scope, source/sourceId/sourceVersion/sourceUrl, contentType, contentHash,
 * payload, classification, and idempotencyKey — is compared, so any change to
 * the record's immutable identity or content under a reused key still raises
 * `DuplicateEvidenceConflictError`.
 */
function isSameRecord(left: RawEvidenceRecord, right: RawEvidenceRecord): boolean {
  const { observedAt: _leftObservedAt, ...leftIdentity } = left;
  const { observedAt: _rightObservedAt, ...rightIdentity } = right;
  return stableJson(leftIdentity as never) === stableJson(rightIdentity as never);
}

function matchesFilter(entry: RawEvidenceStoreEntry, filter: RawEvidenceListFilter): boolean {
  if (filter.connectorId && entry.connectorId !== filter.connectorId) return false;
  const record = entry.record;
  if (filter.source && record.source !== filter.source) return false;
  if (
    filter.sourceVersion !== undefined
    && String(record.sourceVersion) !== String(filter.sourceVersion)
  ) {
    return false;
  }
  if (filter.observedFrom !== undefined || filter.observedTo !== undefined) {
    const observedMs = Date.parse(record.observedAt);
    if (filter.observedFrom !== undefined) {
      const fromMs = Date.parse(filter.observedFrom);
      if (Number.isNaN(observedMs) || observedMs < fromMs) return false;
    }
    if (filter.observedTo !== undefined) {
      const toMs = Date.parse(filter.observedTo);
      if (Number.isNaN(observedMs) || observedMs > toMs) return false;
    }
  }
  return true;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
