import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const FILE_NAME = "github-repositories.json";
const TEMP_FILE_NAME = `${FILE_NAME}.tmp`;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TARGET_KEYS = new Set([
  "id",
  "repository",
  "url",
  "purpose",
  "lifecycle",
  "enabled",
  "validationStatus",
  "syncStatus",
  "lastValidatedAt",
  "lastSyncAt",
  "lastSuccessfulSyncAt",
  "recordsCollected",
  "error"
]);
const VALIDATION_STATUSES = new Set(["pending", "validating", "valid", "failed"]);
const SYNC_STATUSES = new Set(["idle", "syncing", "succeeded", "failed", "cancelled"]);

function clone(value) {
  return structuredClone(value);
}

function emptySnapshot(tenantId, productId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    tenantId,
    productId,
    legacyMigrated: false,
    repositories: []
  };
}

function assertScope(name, value) {
  if (typeof value !== "string" || !SCOPE_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertSnapshot(snapshot, tenantId, productId) {
  if (
    snapshot?.schemaVersion !== SCHEMA_VERSION
    || snapshot.tenantId !== tenantId
    || snapshot.productId !== productId
    || !Number.isSafeInteger(snapshot.revision)
    || typeof snapshot.legacyMigrated !== "boolean"
    || !Array.isArray(snapshot.repositories)
  ) {
    throw new Error("GitHub repository store snapshot is invalid or belongs to another scope.");
  }
  const ids = new Set();
  const repositoryNames = new Set();
  for (const repository of snapshot.repositories) {
    let parsedUrl;
    try {
      parsedUrl = new URL(repository?.url);
    } catch {
      parsedUrl = null;
    }
    const normalizedRepository =
      typeof repository?.repository === "string"
        ? repository.repository.toLowerCase()
        : "";
    if (
      repository === null
      || typeof repository !== "object"
      || Array.isArray(repository)
      || Object.keys(repository).some((key) => !TARGET_KEYS.has(key))
      || typeof repository.id !== "string"
      || typeof repository.repository !== "string"
      || typeof repository.url !== "string"
      || typeof repository.purpose !== "string"
      || typeof repository.lifecycle !== "string"
      || typeof repository.enabled !== "boolean"
      || !VALIDATION_STATUSES.has(repository.validationStatus)
      || !SYNC_STATUSES.has(repository.syncStatus)
      || !Number.isSafeInteger(repository.recordsCollected)
      || repository.recordsCollected < 0
      || !isNullableTimestamp(repository.lastValidatedAt)
      || !isNullableTimestamp(repository.lastSyncAt)
      || !isNullableTimestamp(repository.lastSuccessfulSyncAt)
      || !isSanitizedError(repository.error)
      || ids.has(repository.id)
      || repositoryNames.has(normalizedRepository)
      || !parsedUrl
      || parsedUrl.username
      || parsedUrl.password
    ) {
      throw new Error("GitHub repository store contains invalid repository metadata.");
    }
    ids.add(repository.id);
    repositoryNames.add(normalizedRepository);
  }
  return snapshot;
}

function isNullableTimestamp(value) {
  return value === null
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isSanitizedError(value) {
  if (value === null) return true;
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => ["code", "category", "message"].includes(key))
    && typeof value.code === "string"
    && typeof value.category === "string"
    && typeof value.message === "string"
  );
}

export class InMemoryGitHubRepositoryStore {
  constructor({ tenantId, productId }) {
    assertScope("tenantId", tenantId);
    assertScope("productId", productId);
    this.snapshot = emptySnapshot(tenantId, productId);
  }

  read() {
    return clone(this.snapshot);
  }

  transact(mutator) {
    const draft = clone(this.snapshot);
    const result = mutator(draft);
    draft.revision += 1;
    this.snapshot = draft;
    return clone(result);
  }
}

export class PersistentGitHubRepositoryStore {
  constructor({ dataDirectory, tenantId, productId }) {
    assertScope("tenantId", tenantId);
    assertScope("productId", productId);
    if (typeof dataDirectory !== "string" || dataDirectory.trim().length === 0) {
      throw new TypeError("dataDirectory is required");
    }
    this.tenantId = tenantId;
    this.productId = productId;
    this.directory = join(dataDirectory, tenantId, productId);
    this.storagePath = join(this.directory, FILE_NAME);
    this.temporaryPath = join(this.directory, TEMP_FILE_NAME);
    this.mutationTail = Promise.resolve();
    mkdirSync(this.directory, { recursive: true });
    this.#recover();
  }

  read() {
    return clone(this.#load());
  }

  async transact(mutator) {
    const operation = this.mutationTail.then(
      () => this.#transact(mutator),
      () => this.#transact(mutator)
    );
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #transact(mutator) {
    const snapshot = this.#load();
    const result = mutator(snapshot);
    snapshot.revision += 1;
    this.#persist(snapshot);
    return clone(result);
  }

  #load() {
    if (!existsSync(this.storagePath)) {
      return emptySnapshot(this.tenantId, this.productId);
    }
    return assertSnapshot(
      JSON.parse(readFileSync(this.storagePath, "utf8")),
      this.tenantId,
      this.productId
    );
  }

  #persist(snapshot) {
    const descriptor = openSync(this.temporaryPath, "w");
    try {
      writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(this.temporaryPath, this.storagePath);
    const directoryDescriptor = openSync(this.directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  #recover() {
    if (!existsSync(this.temporaryPath)) return;
    if (existsSync(this.storagePath)) {
      rmSync(this.temporaryPath);
      return;
    }
    assertSnapshot(
      JSON.parse(readFileSync(this.temporaryPath, "utf8")),
      this.tenantId,
      this.productId
    );
    renameSync(this.temporaryPath, this.storagePath);
  }
}

export function createPersistentGitHubRepositoryStore(options) {
  return new PersistentGitHubRepositoryStore(options);
}
