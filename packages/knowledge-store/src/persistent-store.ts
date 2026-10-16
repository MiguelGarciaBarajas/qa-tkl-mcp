import {
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CanonicalEntity,
  Claim,
  ClaimReviewInput,
  ConflictReviewInput,
  ConflictRecord,
  KnowledgeReviewRecord,
  NormalizationResult,
  TraceLink,
} from "@tkl/contracts";
import { InMemoryKnowledgeStore } from "./store.ts";

const STORE_SCHEMA_VERSION = 3;
const STORE_FILE_NAME = "knowledge-store.json";
const TEMP_FILE_NAME = `${STORE_FILE_NAME}.tmp`;
const LOCK_FILE_NAME = `${STORE_FILE_NAME}.lock`;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const activeLocks = new Set<string>();

class KnowledgeStorePostCommitDurabilityError extends Error {
  constructor(error: unknown) {
    super("Knowledge store snapshot was renamed but directory durability could not be confirmed", {
      cause: error,
    });
    this.name = "KnowledgeStorePostCommitDurabilityError";
  }
}

export interface KnowledgeStoreHistoryEntry {
  id: string;
  operation:
    | "upsert"
    | "add-entity"
    | "add-claim"
    | "add-trace-link"
    | "add-conflict"
    | "review-claim"
    | "review-conflict";
  recordedAt: string;
}

interface PersistentStoreSnapshot {
  schemaVersion: number;
  revision: number;
  tenantId: string;
  productId: string;
  entities: CanonicalEntity[];
  claims: Claim[];
  traceLinks: TraceLink[];
  deferredTraceLinks: TraceLink[];
  conflicts: ConflictRecord[];
  reviews: KnowledgeReviewRecord[];
  history: KnowledgeStoreHistoryEntry[];
}

export interface PersistentKnowledgeStoreOptions {
  dataDirectory: string;
  tenantId: string;
  productId: string;
  now?: () => string;
}

interface MemorySnapshot {
  entities: CanonicalEntity[];
  claims: Claim[];
  traceLinks: TraceLink[];
  deferredTraceLinks: TraceLink[];
  conflicts: ConflictRecord[];
  reviews: KnowledgeReviewRecord[];
  history: KnowledgeStoreHistoryEntry[];
}

export class PersistentKnowledgeStore extends InMemoryKnowledgeStore {
  readonly storagePath: string;
  private readonly tenantId: string;
  private readonly productId: string;
  private readonly now: () => string;
  private readonly historyEntries: KnowledgeStoreHistoryEntry[] = [];
  protected readonly deferredTraceLinks = new Map<string, TraceLink>();
  private revision = 0;
  private transactionDepth = 0;

  constructor(options: PersistentKnowledgeStoreOptions) {
    super();
    assertScopeId("tenantId", options.tenantId);
    assertScopeId("productId", options.productId);
    if (!options.dataDirectory.trim()) {
      throw new TypeError("dataDirectory must not be empty");
    }

    this.tenantId = options.tenantId;
    this.productId = options.productId;
    this.now = options.now ?? (() => new Date().toISOString());
    const scopeDirectory = join(options.dataDirectory, this.tenantId, this.productId);
    this.storagePath = join(scopeDirectory, STORE_FILE_NAME);
    mkdirSync(scopeDirectory, { recursive: true });
    this.withWriterLock(() => this.recoverTemporarySnapshot());
    this.load();
  }

  history(): KnowledgeStoreHistoryEntry[] {
    return [...this.historyEntries];
  }

  override upsert(result: Partial<NormalizationResult>): void {
    this.mutate("upsert", () => super.upsert(result));
  }

  protected upsertWithDeferredTraceLinks(
    result: Partial<NormalizationResult>,
    deferredTraceLinks: Iterable<TraceLink>,
  ): void {
    this.mutate("upsert", () => {
      this.deferredTraceLinks.clear();
      for (const link of deferredTraceLinks) this.deferredTraceLinks.set(link.id, link);
      super.upsert(result);
    });
  }

  protected persistedDeferredTraceLinks(): TraceLink[] {
    return [...this.deferredTraceLinks.values()];
  }

  protected addEntityWithDeferredTraceLinks(
    entity: CanonicalEntity,
    resolvedTraceLinks: TraceLink[],
    deferredTraceLinks: Iterable<TraceLink>,
  ): void {
    this.assertEntityScope(entity);
    this.mutate("add-entity", () => {
      super.addEntity(entity);
      this.replaceDeferredTraceLinks(deferredTraceLinks);
      for (const link of resolvedTraceLinks) super.addTraceLink(link);
    });
  }

  protected addTraceLinkWithDeferredTraceLinks(
    link: TraceLink | null,
    deferredTraceLinks: Iterable<TraceLink>,
  ): void {
    this.mutate("add-trace-link", () => {
      this.replaceDeferredTraceLinks(deferredTraceLinks);
      if (link) super.addTraceLink(link);
    });
  }

  override addEntity(entity: CanonicalEntity): void {
    this.assertEntityScope(entity);
    this.mutate("add-entity", () => super.addEntity(entity));
  }

  override addClaim(claim: Claim): void {
    this.assertEntityExists(claim.entityId, `Claim ${claim.id}`);
    this.mutate("add-claim", () => super.addClaim(claim));
  }

  override addTraceLink(link: TraceLink): void {
    this.mutate("add-trace-link", () => super.addTraceLink(link));
  }

  override addConflict(conflict: ConflictRecord): void {
    this.assertEntityExists(conflict.entityId, `Conflict ${conflict.id}`);
    this.mutate("add-conflict", () => super.addConflict(conflict));
  }

  override reviewClaim(input: ClaimReviewInput): KnowledgeReviewRecord {
    return this.mutate("review-claim", () => super.reviewClaim(input));
  }

  override reviewConflict(input: ConflictReviewInput): KnowledgeReviewRecord {
    return this.mutate("review-conflict", () => super.reviewConflict(input));
  }

  private mutate<T>(
    operation: KnowledgeStoreHistoryEntry["operation"],
    action: () => T,
  ): T {
    if (this.transactionDepth > 0) {
      return action();
    }

    const before = this.captureMemory();
    this.transactionDepth += 1;
    try {
      const result = action();
      this.historyEntries.push({
        id: `history:${this.historyEntries.length + 1}`,
        operation,
        recordedAt: this.now(),
      });
      this.persist();
      return result;
    } catch (error) {
      if (!(error instanceof KnowledgeStorePostCommitDurabilityError)) {
        this.restoreMemory(before);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private assertEntityScope(entity: CanonicalEntity): void {
    if (entity.tenantId !== this.tenantId || entity.productId !== this.productId) {
      throw new Error(
        `Entity ${entity.id} does not belong to store scope ${this.tenantId}/${this.productId}`,
      );
    }
  }

  private replaceDeferredTraceLinks(links: Iterable<TraceLink>): void {
    this.deferredTraceLinks.clear();
    for (const link of links) this.deferredTraceLinks.set(link.id, link);
  }

  private assertEntityExists(entityId: string, subject: string): void {
    if (!this.entities.has(entityId)) {
      throw new Error(`${subject} requires entity ${entityId} in the same store scope`);
    }
  }

  private captureMemory(): MemorySnapshot {
    return {
      entities: [...this.entities.values()],
      claims: [...this.claims],
      traceLinks: [...this.traceLinks],
      deferredTraceLinks: [...this.deferredTraceLinks.values()],
      conflicts: [...this.conflictRecords],
      reviews: [...this.reviewRecords],
      history: [...this.historyEntries],
    };
  }

  private restoreMemory(snapshot: MemorySnapshot): void {
    this.entities.clear();
    for (const entity of snapshot.entities) this.entities.set(entity.id, entity);
    this.claims.splice(0, this.claims.length, ...snapshot.claims);
    this.traceLinks.splice(0, this.traceLinks.length, ...snapshot.traceLinks);
    this.deferredTraceLinks.clear();
    for (const link of snapshot.deferredTraceLinks) this.deferredTraceLinks.set(link.id, link);
    this.conflictRecords.splice(0, this.conflictRecords.length, ...snapshot.conflicts);
    this.reviewRecords.splice(0, this.reviewRecords.length, ...snapshot.reviews);
    this.historyEntries.splice(0, this.historyEntries.length, ...snapshot.history);
  }

  private snapshot(revision = this.revision): PersistentStoreSnapshot {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      revision,
      tenantId: this.tenantId,
      productId: this.productId,
      entities: [...this.entities.values()],
      claims: [...this.claims],
      traceLinks: [...this.traceLinks],
      deferredTraceLinks: [...this.deferredTraceLinks.values()],
      conflicts: [...this.conflictRecords],
      reviews: [...this.reviewRecords],
      history: [...this.historyEntries],
    };
  }

  private persist(): void {
    const scopeDirectory = this.storagePath.slice(0, -STORE_FILE_NAME.length);
    const temporaryPath = join(scopeDirectory, TEMP_FILE_NAME);
    this.withWriterLock(() => {
      if (existsSync(this.storagePath)) {
        const durable = migrateSnapshot(parseSnapshot(readFileSync(this.storagePath, "utf-8")));
        if (durable.revision !== this.revision) {
          throw new Error(
            `Persistent knowledge store revision changed from ${this.revision} to ${durable.revision}`,
          );
        }
      } else if (this.revision !== 0) {
        throw new Error("Persistent knowledge store snapshot was removed by another writer");
      }

      const nextRevision = this.revision + 1;
      const temporaryDescriptor = openSync(temporaryPath, "w");
      try {
        writeFileSync(temporaryDescriptor, `${JSON.stringify(this.snapshot(nextRevision), null, 2)}\n`, "utf-8");
        fsyncSync(temporaryDescriptor);
      } finally {
        closeSync(temporaryDescriptor);
      }
      renameSync(temporaryPath, this.storagePath);
      this.revision = nextRevision;
      const directoryPath = this.storagePath.slice(0, -STORE_FILE_NAME.length);
      const directoryDescriptor = openSync(directoryPath, "r");
      try {
        fsyncSync(directoryDescriptor);
      } catch (error) {
        const unsupportedOnWindows =
          process.platform === "win32"
          && typeof error === "object"
          && error !== null
          && (error as NodeJS.ErrnoException).code === "EPERM";
        if (!unsupportedOnWindows) {
          throw new KnowledgeStorePostCommitDurabilityError(error);
        }
      } finally {
        closeSync(directoryDescriptor);
      }
    });
  }

  private withWriterLock<T>(action: () => T): T {
    const lockPath = join(
      this.storagePath.slice(0, -STORE_FILE_NAME.length),
      LOCK_FILE_NAME,
    );
    const lockDescriptor = acquireWriterLock(lockPath);
    activeLocks.add(lockPath);
    try {
      return action();
    } finally {
      activeLocks.delete(lockPath);
      releaseWriterLock(lockDescriptor, lockPath);
    }
  }

  private recoverTemporarySnapshot(): void {
    const temporaryPath = join(
      this.storagePath.slice(0, -STORE_FILE_NAME.length),
      TEMP_FILE_NAME,
    );
    if (!existsSync(temporaryPath)) return;

    if (existsSync(this.storagePath)) {
      rmSync(temporaryPath);
      return;
    }

    const recovered = parseSnapshot(readFileSync(temporaryPath, "utf-8"));
    assertSnapshotScope(recovered, this.tenantId, this.productId);
    renameSync(temporaryPath, this.storagePath);
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    const original = parseSnapshot(readFileSync(this.storagePath, "utf-8"));
    const snapshot = migrateSnapshot(original);
    assertSnapshotScope(snapshot, this.tenantId, this.productId);
    this.revision = snapshot.revision;

    for (const entity of snapshot.entities) {
      this.assertEntityScope(entity);
      this.entities.set(entity.id, entity);
    }
    for (const claim of snapshot.claims) {
      this.assertEntityExists(claim.entityId, `Claim ${claim.id}`);
      this.claims.push(claim);
    }
    for (const link of snapshot.traceLinks) {
      const fromEntity = this.entities.get(link.fromEntityId);
      const toEntity = this.entities.get(link.toEntityId);
      if (!fromEntity || !toEntity) {
        throw new Error(`Trace link ${link.id} requires both endpoint entities`);
      }
      if (
        fromEntity.tenantId !== toEntity.tenantId
        || fromEntity.productId !== toEntity.productId
      ) {
        throw new Error(`Trace link ${link.id} cannot cross tenant or product boundaries`);
      }
      this.traceLinks.push(link);
    }
    for (const link of snapshot.deferredTraceLinks) {
      if (this.traceLinks.some((resolved) => resolved.id === link.id)) {
        throw new Error(`Deferred trace link ${link.id} is already resolved`);
      }
      this.deferredTraceLinks.set(link.id, link);
    }
    for (const conflict of snapshot.conflicts) {
      this.assertEntityExists(conflict.entityId, `Conflict ${conflict.id}`);
      this.conflictRecords.push(conflict);
    }
    for (const review of snapshot.reviews) this.restoreReview(review);
    this.historyEntries.push(...snapshot.history);

    if (original.schemaVersion !== STORE_SCHEMA_VERSION) this.persist();
  }
}

function acquireWriterLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      return descriptor;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!canReclaimWriterLock(lockPath)) {
        throw new Error("Persistent knowledge store is being updated by another writer");
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Persistent knowledge store writer lock could not be acquired");
}

function canReclaimWriterLock(lockPath: string): boolean {
  if (activeLocks.has(lockPath)) return false;
  let lock: { pid?: unknown; createdAt?: unknown };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: unknown;
      createdAt?: unknown;
    };
  } catch {
    return false;
  }
  if (!Number.isInteger(lock.pid) || typeof lock.createdAt !== "string") return false;
  const createdAt = Date.parse(lock.createdAt);
  if (Number.isNaN(createdAt)) return false;
  if (lock.pid === process.pid) return true;
  try {
    process.kill(Number(lock.pid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function releaseWriterLock(descriptor: number, lockPath: string): void {
  try {
    closeSync(descriptor);
  } catch (error) {
    process.emitWarning(`Knowledge store lock descriptor cleanup failed: ${errorCode(error)}`);
  }
  try {
    rmSync(lockPath, { force: true });
  } catch (error) {
    process.emitWarning(`Knowledge store lock file cleanup failed: ${errorCode(error)}`);
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : "unknown";
}

function assertScopeId(name: string, value: string): void {
  if (!SCOPE_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must use only letters, numbers, underscores, or hyphens`);
  }
}

function parseSnapshot(content: string): PersistentStoreSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Persistent knowledge store snapshot is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Persistent knowledge store snapshot must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ["entities", "claims", "traceLinks", "conflicts"] as const) {
    if (!Array.isArray(candidate[field])) {
      throw new Error(`Persistent knowledge store snapshot field ${field} must be an array`);
    }
  }
  if (!Number.isInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) < 0) {
    throw new Error("Persistent knowledge store snapshot has an invalid schemaVersion");
  }
  if (
    candidate.revision !== undefined
    && (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 0)
  ) {
    throw new Error("Persistent knowledge store snapshot has an invalid revision");
  }
  if (typeof candidate.tenantId !== "string" || typeof candidate.productId !== "string") {
    throw new Error("Persistent knowledge store snapshot is missing its scope");
  }
  if (candidate.history !== undefined && !Array.isArray(candidate.history)) {
    throw new Error("Persistent knowledge store snapshot field history must be an array");
  }
  if (candidate.reviews !== undefined && !Array.isArray(candidate.reviews)) {
    throw new Error("Persistent knowledge store snapshot field reviews must be an array");
  }
  return {
    schemaVersion: Number(candidate.schemaVersion),
    revision: Number(candidate.revision ?? 0),
    tenantId: candidate.tenantId,
    productId: candidate.productId,
    entities: candidate.entities as CanonicalEntity[],
    claims: candidate.claims as Claim[],
    traceLinks: candidate.traceLinks as TraceLink[],
    deferredTraceLinks: (candidate.deferredTraceLinks ?? []) as TraceLink[],
    conflicts: candidate.conflicts as ConflictRecord[],
    reviews: (candidate.reviews ?? []) as KnowledgeReviewRecord[],
    history: (candidate.history ?? []) as KnowledgeStoreHistoryEntry[],
  };
}

function migrateSnapshot(snapshot: PersistentStoreSnapshot): PersistentStoreSnapshot {
  if (snapshot.schemaVersion > STORE_SCHEMA_VERSION) {
    throw new Error(
      `Persistent knowledge store schema ${snapshot.schemaVersion} is newer than supported schema ${STORE_SCHEMA_VERSION}`,
    );
  }
  if (snapshot.schemaVersion === STORE_SCHEMA_VERSION) return snapshot;
  if (snapshot.schemaVersion === 0 || snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2) {
    return {
      ...snapshot,
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: snapshot.revision ?? 0,
      deferredTraceLinks: snapshot.deferredTraceLinks ?? [],
      reviews: snapshot.reviews ?? [],
      history: snapshot.history ?? [],
    };
  }
  throw new Error(`No migration exists for knowledge store schema ${snapshot.schemaVersion}`);
}

function assertSnapshotScope(
  snapshot: PersistentStoreSnapshot,
  tenantId: string,
  productId: string,
): void {
  if (snapshot.tenantId !== tenantId || snapshot.productId !== productId) {
    throw new Error(
      `Persistent knowledge store snapshot scope ${snapshot.tenantId}/${snapshot.productId} does not match ${tenantId}/${productId}`,
    );
  }
}
