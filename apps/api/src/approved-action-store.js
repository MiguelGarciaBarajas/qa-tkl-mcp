import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ApiError } from "./errors.js";

const SCHEMA_VERSION = 1;
const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_STALE_LOCK_MS = 30_000;
const FILE_NAME = "approved-actions.json";
const TEMP_FILE_NAME = `${FILE_NAME}.tmp`;
const LOCK_FILE_NAME = `${FILE_NAME}.lock`;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function emptySnapshot(tenantId, productId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    tenantId,
    productId,
    previews: [],
    approvals: [],
    executions: [],
  };
}

function clone(value) {
  return structuredClone(value);
}

function assertScope(name, value) {
  if (typeof value !== "string" || !SCOPE_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function parseSnapshot(text, tenantId, productId) {
  const snapshot = JSON.parse(text);
  if (
    snapshot?.schemaVersion !== SCHEMA_VERSION
    || snapshot.tenantId !== tenantId
    || snapshot.productId !== productId
    || !Number.isSafeInteger(snapshot.revision)
    || !Array.isArray(snapshot.previews)
    || !Array.isArray(snapshot.approvals)
    || !Array.isArray(snapshot.executions)
  ) {
    throw new Error("Approved action store snapshot is invalid or belongs to another scope.");
  }
  return snapshot;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function parseLockMetadata(text) {
  try {
    const metadata = JSON.parse(text);
    if (
      metadata?.schemaVersion !== LOCK_SCHEMA_VERSION
      || !Number.isSafeInteger(metadata.pid)
      || metadata.pid <= 0
      || typeof metadata.createdAt !== "string"
      || !Number.isFinite(Date.parse(metadata.createdAt))
      || typeof metadata.token !== "string"
      || !/^[0-9a-f-]{36}$/.test(metadata.token)
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export class InMemoryApprovedActionStore {
  constructor({ tenantId = "solera", productId = "fl-titling" } = {}) {
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

export class PersistentApprovedActionStore {
  constructor({
    dataDirectory,
    tenantId,
    productId,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    now = Date.now,
    isProcessAlive = processIsAlive,
  }) {
    assertScope("tenantId", tenantId);
    assertScope("productId", productId);
    if (typeof dataDirectory !== "string" || dataDirectory.trim().length === 0) {
      throw new TypeError("dataDirectory is required");
    }
    if (!Number.isFinite(staleLockMs) || staleLockMs < 0) {
      throw new TypeError("staleLockMs must be a non-negative number");
    }
    if (typeof now !== "function" || typeof isProcessAlive !== "function") {
      throw new TypeError("now and isProcessAlive must be functions");
    }
    this.tenantId = tenantId;
    this.productId = productId;
    this.staleLockMs = staleLockMs;
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.directory = join(dataDirectory, tenantId, productId);
    this.storagePath = join(this.directory, FILE_NAME);
    this.lockPath = join(this.directory, LOCK_FILE_NAME);
    mkdirSync(this.directory, { recursive: true });
    this.#withLock(() => this.#recover());
  }

  read() {
    return clone(this.#load());
  }

  transact(mutator) {
    return this.#withLock(() => {
      const snapshot = this.#load();
      const result = mutator(snapshot);
      snapshot.revision += 1;
      this.#persist(snapshot);
      return clone(result);
    });
  }

  #load() {
    if (!existsSync(this.storagePath)) {
      return emptySnapshot(this.tenantId, this.productId);
    }
    return parseSnapshot(
      readFileSync(this.storagePath, "utf8"),
      this.tenantId,
      this.productId,
    );
  }

  #persist(snapshot) {
    const temporaryPath = join(this.directory, TEMP_FILE_NAME);
    const descriptor = openSync(temporaryPath, "w");
    try {
      writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, this.storagePath);
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
    const temporaryPath = join(this.directory, TEMP_FILE_NAME);
    if (!existsSync(temporaryPath)) return;
    if (existsSync(this.storagePath)) {
      rmSync(temporaryPath);
      return;
    }
    parseSnapshot(
      readFileSync(temporaryPath, "utf8"),
      this.tenantId,
      this.productId,
    );
    renameSync(temporaryPath, this.storagePath);
  }

  #withLock(action) {
    let lock;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        lock = this.#acquireLock();
        break;
      } catch (error) {
        if (
          error?.code === "EEXIST"
          && attempt === 0
          && this.#recoverStaleLock()
        ) {
          continue;
        }
        if (error?.code === "EEXIST") {
          throw new ApiError(
            503,
            "approved_action_store_busy",
            "Approved action store is busy; retry the request.",
            { retryable: true },
          );
        }
        throw error;
      }
    }
    try {
      return action();
    } finally {
      closeSync(lock.descriptor);
      this.#releaseLock(lock.contents);
    }
  }

  #acquireLock() {
    const descriptor = openSync(this.lockPath, "wx");
    const contents = `${JSON.stringify({
      schemaVersion: LOCK_SCHEMA_VERSION,
      pid: process.pid,
      createdAt: new Date(this.now()).toISOString(),
      token: randomUUID(),
    })}\n`;
    try {
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
      return { descriptor, contents };
    } catch (error) {
      closeSync(descriptor);
      rmSync(this.lockPath, { force: true });
      throw error;
    }
  }

  #releaseLock(contents) {
    try {
      if (readFileSync(this.lockPath, "utf8") === contents) {
        rmSync(this.lockPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  #recoverStaleLock() {
    let contents;
    let observed;
    try {
      contents = readFileSync(this.lockPath, "utf8");
      observed = statSync(this.lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }

    const metadata = parseLockMetadata(contents);
    if (metadata) {
      if (this.isProcessAlive(metadata.pid)) return false;
    } else if (this.now() - observed.mtimeMs < this.staleLockMs) {
      return false;
    }

    const fingerprint = createHash("sha256")
      .update(contents)
      .update(`${observed.dev}:${observed.ino}:${observed.size}:${observed.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
    const recoveryPath = `${this.lockPath}.stale-${fingerprint}`;
    try {
      linkSync(this.lockPath, recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (error?.code !== "EEXIST") throw error;
    }

    let claimed;
    try {
      claimed = statSync(recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") return !existsSync(this.lockPath);
      throw error;
    }
    if (
      readFileSync(recoveryPath, "utf8") !== contents
      || !sameFileVersion(observed, claimed)
    ) {
      rmSync(recoveryPath, { force: true });
      return false;
    }
    rmSync(this.lockPath, { force: true });
    rmSync(recoveryPath, { force: true });
    return true;
  }
}

export function createPersistentApprovedActionStore(options) {
  return new PersistentApprovedActionStore(options);
}
