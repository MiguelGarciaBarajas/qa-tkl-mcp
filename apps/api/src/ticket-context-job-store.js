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
import {
  assertEnvelopeScope,
  assertEnvelopeShape,
  assertSupportedEnvelopeVersion,
  assertSupportedSchemaVersion,
  decryptEnvelope,
  encryptEnvelope,
  resolveKeyMaterial
} from "@tkl/credential-vault";

const SCHEMA_VERSION = 2;
const STORE_SCOPE = "ticket-context-jobs";
const FILE_NAME = "ticket-context-jobs.enc.json";
const TEMP_FILE_NAME = `${FILE_NAME}.tmp`;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SOURCES = ["jira", "testrail", "github"];
const DISPOSITIONS = new Set(["accepted", "duplicate", "obsolete", "not-hot", "rejected"]);
const RECEIPT_DISPOSITIONS = new Set(["accepted", "obsolete", "not-hot"]);
const JOB_STATES = new Set(["pending", "running", "complete", "partial", "unavailable", "cancelled"]);
const SOURCE_STATES = new Set([
  "local", "refreshed", "pending", "running", "complete", "partial",
  "unavailable", "not-connected", "cancelled"
]);
const JOB_KEYS = new Set([
  "productId", "issueKey", "state", "createdAt", "updatedAt", "queuedAt",
  "startedAt", "completedAt", "cancelledAt", "attemptCount", "retryCount",
  "nextRetryAt", "force", "sources", "completeness", "invalidation"
]);
const SOURCE_KEYS = new Set([
  "state", "startedAt", "completedAt", "attemptCount", "recordsCollected",
  "truncated", "error"
]);
const ROOT_KEYS = new Set([
  "schemaVersion", "revision", "tenantId", "jobs", "receipts",
  "invalidationStats", "lastRetentionSweep", "failures"
]);
const COUNT_KEYS = ["accepted", "duplicate", "obsolete", "notHot", "rejected"];

function clone(value) {
  return structuredClone(value);
}

function emptyCounts() {
  return {
    accepted: 0,
    duplicate: 0,
    obsolete: 0,
    notHot: 0,
    rejected: 0
  };
}

function emptyFailures() {
  return { worker: null, persistence: null };
}

function emptySnapshot(tenantId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    tenantId,
    jobs: [],
    receipts: [],
    invalidationStats: [],
    lastRetentionSweep: null,
    failures: emptyFailures()
  };
}

function emptyInvalidation() {
  return {
    generation: 0,
    runningGeneration: null,
    refreshAfterRun: false,
    sources: Object.fromEntries(SOURCES.map((source) => [
      source,
      {
        stale: false,
        generation: 0,
        observedAt: null,
        eventIdDigest: null,
        latestSuccessfulCompletionAt: null
      }
    ]))
  };
}

function assertScope(name, value) {
  if (typeof value !== "string" || !SCOPE_PATTERN.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}

function migrateSnapshot(snapshot) {
  if (!isRecord(snapshot) || !Number.isSafeInteger(snapshot.schemaVersion)) {
    throw new Error("Ticket context job store snapshot has no valid schema version.");
  }
  const migrated = clone(snapshot);
  if (migrated.schemaVersion === 0) migrated.schemaVersion = 1;
  if (migrated.schemaVersion === 1) {
    migrated.schemaVersion = 2;
  }
  if (migrated.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Ticket context job store schema ${migrated.schemaVersion} is not supported.`
    );
  }
  migrated.receipts ??= [];
  migrated.invalidationStats ??= [];
  migrated.lastRetentionSweep ??= null;
  migrated.failures ??= emptyFailures();
  migrated.failures.worker ??= null;
  migrated.failures.persistence ??= null;
  for (const job of migrated.jobs ?? []) {
    job.retryCount ??= 0;
    job.invalidation ??= emptyInvalidation();
    for (const source of SOURCES) {
      const invalidationSource = job.invalidation.sources[source];
      const sourceState = job.sources?.[source]?.state;
      if (source === "jira" && sourceState === "local") {
        invalidationSource.latestSuccessfulCompletionAt = null;
      } else if (
        !Object.hasOwn(invalidationSource, "latestSuccessfulCompletionAt")
      ) {
        invalidationSource.latestSuccessfulCompletionAt =
          ["refreshed", "complete"].includes(sourceState)
            ? job.sources[source].completedAt
            : null;
      }
    }
  }
  return migrated;
}

function assertSnapshot(input, tenantId) {
  const snapshot = migrateSnapshot(input);
  if (
    snapshot.tenantId !== tenantId
    || !Number.isSafeInteger(snapshot.revision)
    || Object.keys(snapshot).some((key) => !ROOT_KEYS.has(key))
    || !Array.isArray(snapshot.jobs)
    || !Array.isArray(snapshot.receipts)
    || !Array.isArray(snapshot.invalidationStats)
    || !isNullableSweep(snapshot.lastRetentionSweep)
    || !isFailures(snapshot.failures)
  ) {
    throw new Error("Ticket context job store snapshot is invalid or belongs to another scope.");
  }

  const identities = new Set();
  for (const job of snapshot.jobs) {
    if (
      !isRecord(job)
      || Object.keys(job).some((key) => !JOB_KEYS.has(key))
      || !SCOPE_PATTERN.test(job.productId ?? "")
      || !ISSUE_KEY_PATTERN.test(job.issueKey ?? "")
      || !JOB_STATES.has(job.state)
      || !isTimestamp(job.createdAt)
      || !isTimestamp(job.updatedAt)
      || !isTimestamp(job.queuedAt)
      || !isNullableTimestamp(job.startedAt)
      || !isNullableTimestamp(job.completedAt)
      || !isNullableTimestamp(job.cancelledAt)
      || !isNonNegativeInteger(job.attemptCount)
      || !isNonNegativeInteger(job.retryCount)
      || !isNullableTimestamp(job.nextRetryAt)
      || typeof job.force !== "boolean"
      || !isRecord(job.sources)
      || !SOURCES.every((source) => isSourceOutcome(job.sources[source]))
      || Object.keys(job.sources).some((source) => !SOURCES.includes(source))
      || !isCompleteness(job.completeness)
      || !isInvalidation(job.invalidation)
      || identities.has(`${job.productId}:${job.issueKey}`)
    ) {
      throw new Error("Ticket context job store contains invalid operational metadata.");
    }
    identities.add(`${job.productId}:${job.issueKey}`);
  }

  const receiptIdentities = new Set();
  for (const receipt of snapshot.receipts) {
    const identity = `${receipt.productId}:${receipt.source}:${receipt.eventIdDigest}`;
    if (
      !isRecord(receipt)
      || Object.keys(receipt).some((key) => ![
        "productId", "source", "eventIdDigest", "issueKeyDigest",
        "observedAt", "receivedAt", "disposition"
      ].includes(key))
      || !SCOPE_PATTERN.test(receipt.productId ?? "")
      || !SOURCES.includes(receipt.source)
      || !DIGEST_PATTERN.test(receipt.eventIdDigest ?? "")
      || !DIGEST_PATTERN.test(receipt.issueKeyDigest ?? "")
      || !isTimestamp(receipt.observedAt)
      || !isTimestamp(receipt.receivedAt)
      || !RECEIPT_DISPOSITIONS.has(receipt.disposition)
      || receiptIdentities.has(identity)
    ) {
      throw new Error("Ticket context job store contains invalid delivery receipts.");
    }
    receiptIdentities.add(identity);
  }

  const statProducts = new Set();
  for (const stat of snapshot.invalidationStats) {
    if (
      !isRecord(stat)
      || Object.keys(stat).some((key) => !["productId", "counts", "last"].includes(key))
      || !SCOPE_PATTERN.test(stat.productId ?? "")
      || !isCounts(stat.counts)
      || !isNullableLastInvalidation(stat.last)
      || statProducts.has(stat.productId)
    ) {
      throw new Error("Ticket context job store contains invalid invalidation statistics.");
    }
    statProducts.add(stat.productId);
  }
  return snapshot;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

function isNullableDigest(value) {
  return value === null || (typeof value === "string" && DIGEST_PATTERN.test(value));
}

function isSourceOutcome(value) {
  return (
    isRecord(value)
    && Object.keys(value).every((key) => SOURCE_KEYS.has(key))
    && SOURCE_STATES.has(value.state)
    && isNullableTimestamp(value.startedAt)
    && isNullableTimestamp(value.completedAt)
    && isNonNegativeInteger(value.attemptCount)
    && isNonNegativeInteger(value.recordsCollected)
    && typeof value.truncated === "boolean"
    && (
      value.error === null
      || (
        isRecord(value.error)
        && Object.keys(value.error).every((key) => ["code", "message"].includes(key))
        && typeof value.error.code === "string"
        && typeof value.error.message === "string"
      )
    )
  );
}

function isCompleteness(value) {
  return (
    isRecord(value)
    && Object.keys(value).every((key) => ["status", "complete", "reasons"].includes(key))
    && ["pending", "complete", "partial", "unavailable", "cancelled"].includes(value.status)
    && typeof value.complete === "boolean"
    && Array.isArray(value.reasons)
    && value.reasons.every((reason) => typeof reason === "string")
  );
}

function isInvalidation(value) {
  return (
    isRecord(value)
    && Object.keys(value).every((key) =>
      ["generation", "runningGeneration", "refreshAfterRun", "sources"].includes(key))
    && isNonNegativeInteger(value.generation)
    && (value.runningGeneration === null || isNonNegativeInteger(value.runningGeneration))
    && typeof value.refreshAfterRun === "boolean"
    && isRecord(value.sources)
    && SOURCES.every((source) => {
      const state = value.sources[source];
      return (
        isRecord(state)
        && Object.keys(state).every((key) =>
          [
            "stale", "generation", "observedAt", "eventIdDigest",
            "latestSuccessfulCompletionAt"
          ].includes(key))
        && typeof state.stale === "boolean"
        && isNonNegativeInteger(state.generation)
        && isNullableTimestamp(state.observedAt)
        && isNullableDigest(state.eventIdDigest)
        && isNullableTimestamp(state.latestSuccessfulCompletionAt)
      );
    })
    && Object.keys(value.sources).every((source) => SOURCES.includes(source))
  );
}

function isCounts(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => COUNT_KEYS.includes(key))
    && COUNT_KEYS.every((key) => isNonNegativeInteger(value[key]));
}

function isNullableLastInvalidation(value) {
  return value === null || (
    isRecord(value)
    && Object.keys(value).every((key) => [
      "source", "observedAt", "receivedAt", "disposition",
      "eventIdDigest", "issueKeyDigest"
    ].includes(key))
    && SOURCES.includes(value.source)
    && isNullableTimestamp(value.observedAt)
    && isTimestamp(value.receivedAt)
    && DISPOSITIONS.has(value.disposition)
    && isNullableDigest(value.eventIdDigest)
    && isNullableDigest(value.issueKeyDigest)
  );
}

function isNullableSweep(value) {
  return value === null || (
    isRecord(value)
    && Object.keys(value).every((key) =>
      ["startedAt", "completedAt", "jobsDeleted", "receiptsDeleted"].includes(key))
    && isTimestamp(value.startedAt)
    && isTimestamp(value.completedAt)
    && isNonNegativeInteger(value.jobsDeleted)
    && isNonNegativeInteger(value.receiptsDeleted)
  );
}

function isFailure(value) {
  return value === null || (
    isRecord(value)
    && Object.keys(value).every((key) => ["productId", "at", "code"].includes(key))
    && (value.productId === null || SCOPE_PATTERN.test(value.productId ?? ""))
    && isTimestamp(value.at)
    && typeof value.code === "string"
    && /^[a-z0-9_]{1,64}$/.test(value.code)
  );
}

function isFailures(value) {
  return isRecord(value)
    && Object.keys(value).every((key) => ["worker", "persistence"].includes(key))
    && isFailure(value.worker)
    && isFailure(value.persistence);
}

export class InMemoryTicketContextJobStore {
  constructor({ tenantId = "solera" } = {}) {
    assertScope("tenantId", tenantId);
    this.tenantId = tenantId;
    this.snapshot = emptySnapshot(tenantId);
    this.mutationTail = Promise.resolve();
  }

  async initialize() {}

  async read() {
    await this.mutationTail;
    return clone(this.snapshot);
  }

  async transact(mutator) {
    const operation = this.mutationTail.then(async () => {
      const draft = clone(this.snapshot);
      const result = await mutator(draft);
      draft.revision += 1;
      this.snapshot = assertSnapshot(draft, this.tenantId);
      return clone(result);
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class PersistentTicketContextJobStore {
  constructor({
    dataDirectory,
    tenantId,
    keyRef = "env://TKL_CONTEXT_JOB_KEY",
    resolveKey
  }) {
    assertScope("tenantId", tenantId);
    if (typeof dataDirectory !== "string" || dataDirectory.trim().length === 0) {
      throw new TypeError("dataDirectory is required");
    }
    if (typeof keyRef !== "string" || keyRef.length === 0) {
      throw new TypeError("keyRef is required");
    }
    if (typeof resolveKey !== "function") {
      throw new TypeError("resolveKey is required");
    }
    this.tenantId = tenantId;
    this.keyRef = keyRef;
    this.resolveKey = resolveKey;
    this.directory = join(dataDirectory, tenantId);
    this.storagePath = join(this.directory, FILE_NAME);
    this.temporaryPath = join(this.directory, TEMP_FILE_NAME);
    this.keyPromise = null;
    this.mutationTail = Promise.resolve();
    mkdirSync(this.directory, { recursive: true });
  }

  async initialize() {
    await this.#key();
    await this.#recover();
    const snapshot = await this.#load();
    if (existsSync(this.storagePath)) {
      const envelope = JSON.parse(readFileSync(this.storagePath, "utf8"));
      if (envelope.schemaVersion < SCHEMA_VERSION) await this.#persist(snapshot);
    }
  }

  async read() {
    await this.mutationTail;
    return clone(await this.#load());
  }

  async transact(mutator) {
    const operation = this.mutationTail.then(
      () => this.#transact(mutator),
      () => this.#transact(mutator)
    );
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #key() {
    if (!this.keyPromise) {
      this.keyPromise = resolveKeyMaterial(
        this.resolveKey,
        this.keyRef,
        { tenantId: this.tenantId, productId: STORE_SCOPE }
      );
    }
    return this.keyPromise;
  }

  async #transact(mutator) {
    const snapshot = await this.#load();
    const result = await mutator(snapshot);
    snapshot.revision += 1;
    await this.#persist(snapshot);
    return clone(result);
  }

  async #load() {
    if (!existsSync(this.storagePath)) return emptySnapshot(this.tenantId);
    const envelope = JSON.parse(readFileSync(this.storagePath, "utf8"));
    assertEnvelopeShape(envelope);
    assertSupportedEnvelopeVersion(envelope);
    assertSupportedSchemaVersion(envelope, SCHEMA_VERSION);
    assertEnvelopeScope(envelope, this.tenantId, STORE_SCOPE);
    return assertSnapshot(
      decryptEnvelope(envelope, await this.#key()),
      this.tenantId
    );
  }

  async #persist(input) {
    const snapshot = assertSnapshot(input, this.tenantId);
    const envelope = encryptEnvelope(snapshot, await this.#key(), {
      tenantId: this.tenantId,
      productId: STORE_SCOPE,
      schemaVersion: SCHEMA_VERSION,
      keyRef: this.keyRef
    });
    const descriptor = openSync(this.temporaryPath, "w");
    try {
      writeFileSync(descriptor, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
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

  async #recover() {
    if (!existsSync(this.temporaryPath)) return;
    if (existsSync(this.storagePath)) {
      rmSync(this.temporaryPath);
      return;
    }
    const envelope = JSON.parse(readFileSync(this.temporaryPath, "utf8"));
    assertEnvelopeShape(envelope);
    assertSupportedEnvelopeVersion(envelope);
    assertSupportedSchemaVersion(envelope, SCHEMA_VERSION);
    assertEnvelopeScope(envelope, this.tenantId, STORE_SCOPE);
    assertSnapshot(
      decryptEnvelope(envelope, await this.#key()),
      this.tenantId
    );
    renameSync(this.temporaryPath, this.storagePath);
  }
}

export function createPersistentTicketContextJobStore(options) {
  return new PersistentTicketContextJobStore(options);
}
