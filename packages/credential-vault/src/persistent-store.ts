import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { open as openFileHandle, rename as renameFile, rm as removeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InMemoryCredentialVault,
  type CredentialVaultOptions,
  type CredentialVaultRecordMetadata,
  type DisconnectInput,
  type SourceId,
  type UpdateStatusInput,
  type UpsertConnectionInput,
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
 * Durable, encrypted implementation of `CredentialVault`. Extends
 * `InMemoryCredentialVault` so reads reuse the in-memory contract/validation,
 * and adds atomic encrypted persistence plus crash-safe recovery.
 *
 * Storage layout mirrors `@tkl/raw-evidence-store`/`@tkl/knowledge-store`:
 *
 * ```text
 * <data-directory>/<tenant-id>/<product-id>/credential-vault.json      (durable, encrypted)
 * <data-directory>/<tenant-id>/<product-id>/credential-vault.json.tmp  (write-in-progress)
 * ```
 *
 * Every mutation (`upsertConnection`/`updateStatus`/`disconnect`) writes a
 * full encrypted snapshot of *every* source record in this scope to the
 * `.tmp` file, flushes it to durable storage (`fsync`) before attempting the
 * rename, then atomically renames it over the durable file. The rename is
 * this store's durability point: once it succeeds, the mutation is
 * committed. A failure at or before the rename (temp write/flush, or the
 * rename itself) rolls the in-memory mutation back to what was durable
 * before the call, and best-effort quarantines (removes) the failed temp
 * file so it can never be mistakenly authenticated and promoted by a later
 * restart.
 *
 * Concurrency: mutations are serialized per store *instance* — every call
 * runs its whole snapshot -> mutate -> persist -> (rollback) critical
 * section exclusively, so overlapping callers can never interleave their
 * in-memory mutation with another call's rollback snapshot, and never write
 * the same shared temp path at once. This is in-process serialization only;
 * running two processes against the same data directory/scope concurrently
 * is not supported (see README).
 */

const SCHEMA_VERSION = 1;
const FILE_NAME = "credential-vault.json";
const TEMP_FILE_NAME = `${FILE_NAME}.tmp`;
export const CREDENTIAL_VAULT_KEY_REF_PATTERN = /^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

interface PersistedRecord extends CredentialVaultRecordMetadata {
  credential?: string;
}

interface PersistedContent {
  records: PersistedRecord[];
}

type MemorySnapshot = Map<SourceId, PersistedRecord>;

/**
 * Low-level durable file operations used by `persist()`. Exists as an
 * injectable seam so tests can observe call order/arguments and simulate
 * failure modes deterministically and cross-platform, without depending on
 * real disk faults. Production code should always use the
 * `nodeFsOperations` default.
 */
export interface PersistFsOperations {
  /** Writes `contents` to `path` and flushes it (`fsync`) before resolving. */
  writeFileDurable(path: string, contents: string): Promise<void>;
  /** Atomically renames `oldPath` to `newPath`. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Best-effort fsync of the directory at `path`. Swallows only the known-unsupported Windows case. */
  syncDirectory(path: string): Promise<void>;
  /** Removes a leftover temp file. Must throw if removal failed; must not throw if already gone. */
  removeTempFile(path: string): Promise<void>;
}

/**
 * Windows cannot `fsync` a directory handle (opening one for read succeeds,
 * but flushing it fails with `EPERM`). This is the only directory-sync
 * failure treated as "unsupported, not an error", and only on `win32` — a
 * genuine `EPERM` on a POSIX platform still fails loudly.
 */
export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    process.platform === "win32"
    && typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "EPERM"
  );
}

/** Default, real-filesystem implementation of {@link PersistFsOperations}. */
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
      if (!isUnsupportedDirectorySyncError(error)) {
        throw error;
      }
    } finally {
      await handle.close();
    }
  },

  async removeTempFile(path) {
    await removeFile(path, { recursive: true, force: true });
  },
};

export interface PersistentCredentialVaultOptions extends CredentialVaultOptions {
  /** Directory under which `<tenantId>/<productId>/` scope directories are created. */
  dataDirectory: string;
  /**
   * An explicit reference to encryption key material (for example
   * "secret://credential-vault/fl-titling"), never the key itself.
   * Configuration must only ever hold this reference.
   */
  keyRef: string;
  /** Resolves `keyRef` (and scope) to raw AES-256 key material at runtime. */
  resolveKey: KeyResolver;
  /**
   * Advanced/test-only seam for the durable file operations `persist()`
   * uses. Defaults to `nodeFsOperations` (the real filesystem); production
   * callers should not need to set this.
   */
  fsOperations?: PersistFsOperations;
}

export class PersistentCredentialVault extends InMemoryCredentialVault {
  readonly storagePath: string;
  readonly keyRef: string;
  private readonly dataDirectory: string;
  private readonly resolveKey: KeyResolver;
  private readonly tempPath: string;
  private readonly scopeDirectory: string;
  private readonly fsOperations: PersistFsOperations;
  private initialized = false;
  /** Tail of the per-instance mutation chain; see `runExclusively`. */
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: PersistentCredentialVaultOptions) {
    super(options);
    if (!options.dataDirectory || !options.dataDirectory.trim()) {
      throw new TypeError("dataDirectory must not be empty");
    }
    if (typeof options.keyRef !== "string" || !CREDENTIAL_VAULT_KEY_REF_PATTERN.test(options.keyRef)) {
      throw new TypeError('keyRef must match "secret://..." or "env://..."');
    }
    if (typeof options.resolveKey !== "function") {
      throw new TypeError("resolveKey must be a function");
    }

    this.dataDirectory = options.dataDirectory;
    this.keyRef = options.keyRef;
    this.resolveKey = options.resolveKey;
    this.fsOperations = options.fsOperations ?? nodeFsOperations;
    this.scopeDirectory = join(this.dataDirectory, this.tenantId, this.productId);
    this.storagePath = join(this.scopeDirectory, FILE_NAME);
    this.tempPath = join(this.scopeDirectory, TEMP_FILE_NAME);
    mkdirSync(this.scopeDirectory, { recursive: true });
  }

  /**
   * Performs crash-safe temp recovery and loads the durable snapshot. Must
   * be called (typically via `createPersistentCredentialVault`) before any
   * other method. Throws without modifying the data directory when the
   * durable or temp snapshot is corrupt, tampered, encrypted with a
   * different key, declares an unsupported future version, or belongs to a
   * different scope — this vault fails closed rather than silently
   * discarding or resurrecting ambiguous data.
   */
  async initialize(): Promise<this> {
    if (this.initialized) return this;
    await this.recoverTemporarySnapshot();
    await this.load();
    this.initialized = true;
    return this;
  }

  override async upsertConnection(input: UpsertConnectionInput): Promise<CredentialVaultRecordMetadata> {
    this.assertInitialized();
    return this.runExclusively(() => this.mutateExclusively(() => this.upsertConnectionInMemory(input)));
  }

  override async updateStatus(input: UpdateStatusInput): Promise<CredentialVaultRecordMetadata> {
    this.assertInitialized();
    return this.runExclusively(() => this.mutateExclusively(() => this.updateStatusInMemory(input)));
  }

  override async disconnect(input: DisconnectInput): Promise<CredentialVaultRecordMetadata> {
    this.assertInitialized();
    return this.runExclusively(() => this.mutateExclusively(() => this.disconnectInMemory(input)));
  }

  override async resolveCredential(
    tenantId: string,
    productId: string,
    source: SourceId,
  ): Promise<string | undefined> {
    this.assertInitialized();
    return super.resolveCredential(tenantId, productId, source);
  }

  override get(
    tenantId: string,
    productId: string,
    source: SourceId,
  ): CredentialVaultRecordMetadata | undefined {
    this.assertInitialized();
    return super.get(tenantId, productId, source);
  }

  override list(tenantId: string, productId: string): CredentialVaultRecordMetadata[] {
    this.assertInitialized();
    return super.list(tenantId, productId);
  }

  /**
   * Runs `operation` after every previously enqueued mutation on this
   * instance has settled, and makes subsequent mutations wait for it. The
   * chain is kept alive across rejections (a failed mutation must not
   * deadlock or poison later mutations), and the caller still sees
   * `operation`'s own outcome unchanged.
   */
  private runExclusively<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Applies a single in-memory mutation, persists the result durably, and
   * rolls back to the pre-mutation snapshot if anything before the durable
   * rename fails. `mutate` synchronously validates and applies the change
   * (via the inherited `*InMemory` helpers), so a thrown validation error
   * never reaches `persist()` and never needs a rollback.
   */
  private async mutateExclusively(
    mutate: () => CredentialVaultRecordMetadata,
  ): Promise<CredentialVaultRecordMetadata> {
    const before = this.captureMemory();
    try {
      const result = mutate();
      await this.persist();
      return result;
    } catch (error) {
      this.restoreMemory(before);
      throw error;
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "PersistentCredentialVault was not initialized; use createPersistentCredentialVault " +
          "or call initialize() before use",
      );
    }
  }

  private get scope(): { tenantId: string; productId: string } {
    return { tenantId: this.tenantId, productId: this.productId };
  }

  private captureMemory(): MemorySnapshot {
    return new Map(this.entries);
  }

  private restoreMemory(snapshot: MemorySnapshot): void {
    this.entries.clear();
    for (const [key, value] of snapshot) this.entries.set(key, value);
  }

  /**
   * Writes the current in-memory state durably: temp-file write, `fsync`,
   * then atomic rename over the durable file. The rename is this vault's
   * commit point — once it succeeds, this method never throws afterward
   * (the only remaining step, a best-effort containing-directory `fsync`,
   * swallows its own failures).
   */
  private async persist(): Promise<void> {
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    const content: PersistedContent = {
      records: [...this.entries.values()],
    };
    const envelope = encryptEnvelope(content, key, {
      tenantId: this.tenantId,
      productId: this.productId,
      schemaVersion: SCHEMA_VERSION,
      keyRef: this.keyRef,
    });
    try {
      // Write + flush the temp file to durable storage *before* attempting
      // the rename: the rename only ever promotes bytes that are themselves
      // already durable, so a crash right after a successful rename can
      // never expose a partially-written file.
      await this.fsOperations.writeFileDurable(this.tempPath, `${JSON.stringify(envelope, null, 2)}\n`);
      await this.fsOperations.rename(this.tempPath, this.storagePath);
    } catch (error) {
      // Failure at or before the rename: the mutation never reached its
      // durability point. Quarantine (best-effort remove) the temp file so
      // a later `initialize()` can never mistakenly authenticate and
      // promote it, then propagate so the caller's mutation is rolled back.
      await this.quarantineFailedTempWrite();
      throw error;
    }

    // The rename above succeeded: the mutation is committed and durable.
    // Everything from here on is best-effort extra safety margin and must
    // never cause a rollback of an already-durable mutation.
    try {
      await this.fsOperations.syncDirectory(this.scopeDirectory);
    } catch {
      // Best-effort only: the rename itself is this vault's durability
      // point, so a post-rename directory-fsync failure is not fatal.
    }
  }

  private async quarantineFailedTempWrite(): Promise<void> {
    try {
      await this.fsOperations.removeTempFile(this.tempPath);
    } catch {
      // Best-effort: if cleanup itself fails, the original persist() error
      // still propagates to the caller. A leftover, unpromotable (because
      // it never authenticates as a complete/valid write, or because a
      // durable snapshot already takes precedence) temp file is handled
      // safely by `recoverTemporarySnapshot` on the next restart.
    }
  }

  private async recoverTemporarySnapshot(): Promise<void> {
    if (!existsSync(this.tempPath)) return;

    if (existsSync(this.storagePath)) {
      // A stale temp file only loses to the durable snapshot if the durable
      // snapshot itself authenticates. Blindly deleting the temp file here
      // would be unsafe: if the durable file were corrupt, tampered, or
      // otherwise unreadable, this would destroy the only other candidate
      // snapshot instead of preserving it for investigation/recovery.
      const durableEnvelope = readEnvelopeFile(this.storagePath);
      await this.decryptUsableEnvelope(durableEnvelope);
      rmSync(this.tempPath);
      return;
    }

    // No durable snapshot exists: the process must have crashed after
    // writing the temp file but before the rename. Validate it fully
    // (scope, version, and authenticated decryption) before promoting it,
    // so a corrupt or tampered temp file fails closed instead of silently
    // becoming durable.
    const envelope = readEnvelopeFile(this.tempPath);
    await this.decryptUsableEnvelope(envelope);
    renameSync(this.tempPath, this.storagePath);
  }

  private async load(): Promise<void> {
    if (!existsSync(this.storagePath)) return;
    const envelope = readEnvelopeFile(this.storagePath);
    const content = assertPersistedContentShape(await this.decryptUsableEnvelope(envelope));
    for (const record of content.records) {
      this.entries.set(record.source, record);
    }
  }

  /**
   * Validates envelope metadata (cheap, synchronous checks first) and then
   * performs authenticated decryption, returning the decrypted content.
   * Used by both startup load and temp-file recovery so both paths fail
   * closed identically on scope mismatch, unsupported versions, wrong
   * keys, corruption, or tampering.
   */
  private async decryptUsableEnvelope(envelope: EncryptedEnvelope): Promise<unknown> {
    assertEnvelopeScope(envelope, this.tenantId, this.productId);
    assertSupportedEnvelopeVersion(envelope);
    assertSupportedSchemaVersion(envelope, SCHEMA_VERSION);
    if (envelope.keyRef !== this.keyRef) {
      throw new TypeError(
        `Credential vault snapshot key reference does not match configured keyRef for ` +
          `${this.tenantId}/${this.productId}`,
      );
    }
    const key = await resolveKeyMaterial(this.resolveKey, this.keyRef, this.scope);
    return decryptEnvelope(envelope, key);
  }
}

function readEnvelopeFile(path: string): EncryptedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new TypeError("Credential vault snapshot envelope is not valid JSON");
  }
  assertEnvelopeShape(parsed);
  return parsed;
}

function assertPersistedContentShape(value: unknown): PersistedContent {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Credential vault snapshot content must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.records)) {
    throw new TypeError("Credential vault snapshot content has an invalid shape");
  }
  return candidate as unknown as PersistedContent;
}

/** Convenience factory: constructs and initializes a durable vault in one step. */
export async function createPersistentCredentialVault(
  options: PersistentCredentialVaultOptions,
): Promise<PersistentCredentialVault> {
  const vault = new PersistentCredentialVault(options);
  await vault.initialize();
  return vault;
}
