/**
 * Boundary contracts for `@tkl/credential-vault`. This package is the
 * tenant/product/source-scoped home for connector *credentials* (Jira/GitHub/
 * TestRail/Confluence/ReportPortal API tokens, etc.) and their non-secret
 * connection metadata. Connector code and the future connection-management
 * API depend on this contract, not the reverse.
 *
 * Design summary:
 * - A `CredentialVault` instance is scoped to exactly one `tenantId`/
 *   `productId` (mirroring `@tkl/raw-evidence-store` and
 *   `@tkl/knowledge-store`); within that scope, one record exists per
 *   `source` (`jira`, `github`, `testrail`, `confluence`, `reportportal`).
 * - Every record holds `ownerSubject`, sanitized non-secret `config`,
 *   connection status/timestamps/error metadata, and *optionally* a
 *   credential value. `list`/`get` only ever return metadata: the
 *   `credential` field is never present on a returned object, not even as
 *   `undefined` set explicitly by the caller-visible shape.
 * - `resolveCredential` is the one method that returns the actual credential
 *   value. It exists for trusted, server-side connector code only (for
 *   example a plugin about to call a source API) and must never be exposed
 *   through a public HTTP/MCP surface directly.
 */

export const SOURCE_IDS = ["jira", "github", "testrail", "confluence", "reportportal"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const CONNECTION_STATUSES = [
  "not-connected",
  "validating",
  "connected",
  "syncing",
  "stale",
  "authorization-expired",
  "error",
  "disabled",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_ERROR_CATEGORIES = [
  "authorization",
  "configuration",
  "network",
  "provider",
  "internal",
] as const;
export type ConnectionErrorCategory = (typeof CONNECTION_ERROR_CATEGORIES)[number];

/**
 * Sanitized connection-error metadata. Deliberately limited to these three
 * fields: callers frequently want to record a provider's rejection (an HTTP
 * body, a stack trace, headers) for local debugging, but none of that may
 * ever be persisted or returned by this vault. `sanitizeConnectionError`
 * enforces this by construction — it copies only `code`/`category`/`message`
 * out of whatever is passed in.
 */
export interface ConnectionError {
  code: string;
  category: ConnectionErrorCategory;
  message: string;
}

export type SourceConfigValue = string | string[];
export type SourceConfig = Record<string, SourceConfigValue>;

export const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const OWNER_SUBJECT_MAX_LENGTH = 320;
export const CONFIG_VALUE_MAX_LENGTH = 2048;
export const CONFIG_ARRAY_MAX_ITEMS = 100;
export const CONFIG_MAX_KEYS = 64;
export const CREDENTIAL_MAX_LENGTH = 8192;
export const ERROR_CODE_MAX_LENGTH = 200;
export const ERROR_MESSAGE_MAX_LENGTH = 2000;

/**
 * Config keys are rejected outright if their normalized (lower-cased,
 * non-alphanumeric-stripped) form *contains* any of these substrings — a
 * connector's "non-secret configuration" must never smuggle in a token,
 * password, or similar under a key like `apiKey`, `Authorization-Header`, or
 * `private_key`. This mirrors the equivalent list in the rest of this
 * repository's contracts/validation layers, duplicated here on purpose so
 * this package stays dependency-free.
 */
export const SECRET_LIKE_KEY_PARTS = [
  "apikey",
  "authorization",
  "credential",
  "password",
  "privatekey",
  "secret",
  "token",
];

/** Metadata-only record shape. Never contains a `credential` field. */
export interface CredentialVaultRecordMetadata {
  tenantId: string;
  productId: string;
  source: SourceId;
  ownerSubject: string;
  config: SourceConfig;
  status: ConnectionStatus;
  /** Whether a credential is currently stored, without ever revealing it. */
  hasCredential: boolean;
  connectedAt: string | null;
  lastValidatedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  error: ConnectionError | null;
  createdAt: string;
  updatedAt: string;
}

/** Internal, in-memory record shape. `credential` never leaves this module except via `resolveCredential`. */
interface StoredRecord extends CredentialVaultRecordMetadata {
  credential?: string;
}

export interface CredentialVaultOptions {
  tenantId: string;
  productId: string;
  now?: () => string;
}

export interface UpsertConnectionInput {
  tenantId: string;
  productId: string;
  source: SourceId;
  ownerSubject: string;
  config: SourceConfig;
  /** A raw credential value. Never returned; only ever stored/resolved. */
  credential?: string;
  /**
   * Optional explicit status. When omitted: a freshly supplied/rotated
   * credential defaults the record to `"validating"`; otherwise the
   * existing record's status is preserved (or `"not-connected"` for a new
   * record with no credential yet).
   */
  status?: ConnectionStatus;
}

export interface UpdateStatusInput {
  tenantId: string;
  productId: string;
  source: SourceId;
  status: ConnectionStatus;
  /** Pass `null` to clear a previously recorded error. */
  error?: ConnectionError | null;
  connectedAt?: string | null;
  lastValidatedAt?: string | null;
  lastSyncAt?: string | null;
  lastSuccessfulSyncAt?: string | null;
}

export interface DisconnectInput {
  tenantId: string;
  productId: string;
  source: SourceId;
}

/** Raised for malformed input: bad source/status/ownerSubject/config/credential/error shape. */
export class CredentialVaultValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultValidationError";
  }
}

/** Raised when a request's tenantId/productId does not match this vault instance's scope. */
export class CredentialVaultScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultScopeError";
  }
}

/** Raised by `updateStatus`/`disconnect` when no record exists yet for the given source. */
export class CredentialVaultNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultNotFoundError";
  }
}

export interface CredentialVault {
  readonly tenantId: string;
  readonly productId: string;

  /**
   * Creates or updates a source connection's owner/config/credential.
   * Accepts a raw `credential` but always returns sanitized metadata —
   * the credential itself is never present in the return value.
   */
  upsertConnection(input: UpsertConnectionInput): Promise<CredentialVaultRecordMetadata>;

  /**
   * Updates connection status/timestamps/error metadata only. Never
   * accepts or touches the stored credential.
   */
  updateStatus(input: UpdateStatusInput): Promise<CredentialVaultRecordMetadata>;

  /** Destroys the stored credential (if any) and marks the connection `"not-connected"`. */
  disconnect(input: DisconnectInput): Promise<CredentialVaultRecordMetadata>;

  /** Returns sanitized metadata for one source, or `undefined` if never connected. */
  get(tenantId: string, productId: string, source: SourceId): CredentialVaultRecordMetadata | undefined;

  /** Returns sanitized metadata for every source in this vault's scope. */
  list(tenantId: string, productId: string): CredentialVaultRecordMetadata[];

  /**
   * Returns the raw credential value for trusted connector code only (for
   * example a plugin about to authenticate against a source API).
   * **Never** call this from a public API/MCP handler or any path whose
   * result could be serialized back to a caller — use `get`/`list` for
   * anything user- or client-facing.
   */
  resolveCredential(tenantId: string, productId: string, source: SourceId): Promise<string | undefined>;
}

/**
 * In-memory reference implementation. Useful for unit/contract tests and as
 * the base class for the durable, encrypted `PersistentCredentialVault`. Not
 * durable and must not be used in production.
 */
export class InMemoryCredentialVault implements CredentialVault {
  readonly tenantId: string;
  readonly productId: string;
  protected readonly now: () => string;
  protected readonly entries = new Map<SourceId, StoredRecord>();

  constructor(options: CredentialVaultOptions) {
    assertScopeId("tenantId", options.tenantId);
    assertScopeId("productId", options.productId);
    this.tenantId = options.tenantId;
    this.productId = options.productId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for durable subclasses
  async upsertConnection(input: UpsertConnectionInput): Promise<CredentialVaultRecordMetadata> {
    return this.upsertConnectionInMemory(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for durable subclasses
  async updateStatus(input: UpdateStatusInput): Promise<CredentialVaultRecordMetadata> {
    return this.updateStatusInMemory(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for durable subclasses
  async disconnect(input: DisconnectInput): Promise<CredentialVaultRecordMetadata> {
    return this.disconnectInMemory(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for durable subclasses
  async resolveCredential(
    tenantId: string,
    productId: string,
    source: SourceId,
  ): Promise<string | undefined> {
    this.assertScope(tenantId, productId);
    assertSourceId(source);
    return this.entries.get(source)?.credential;
  }

  get(tenantId: string, productId: string, source: SourceId): CredentialVaultRecordMetadata | undefined {
    this.assertScope(tenantId, productId);
    assertSourceId(source);
    const entry = this.entries.get(source);
    return entry ? toMetadata(entry) : undefined;
  }

  list(tenantId: string, productId: string): CredentialVaultRecordMetadata[] {
    this.assertScope(tenantId, productId);
    return [...this.entries.values()]
      .sort((left, right) => left.source.localeCompare(right.source))
      .map(toMetadata);
  }

  /**
   * Applies an upsert synchronously to in-memory state. Validation always
   * runs before any mutation, so a thrown error guarantees no partial
   * mutation occurred — the same "throws => no mutation happened" guarantee
   * `PersistentCredentialVault`'s rollback relies on.
   */
  protected upsertConnectionInMemory(input: UpsertConnectionInput): CredentialVaultRecordMetadata {
    this.assertScope(input.tenantId, input.productId);
    assertSourceId(input.source);
    const ownerSubject = assertOwnerSubject(input.ownerSubject);
    const config = sanitizeConfig(input.config);
    const credential = input.credential !== undefined ? assertCredential(input.credential) : undefined;
    const status = input.status !== undefined ? assertStatus(input.status) : undefined;
    const existing = this.entries.get(input.source);
    const timestamp = this.now();

    const record: StoredRecord = {
      tenantId: this.tenantId,
      productId: this.productId,
      source: input.source,
      ownerSubject,
      config,
      status: status ?? (credential !== undefined ? "validating" : existing?.status ?? "not-connected"),
      credential: credential !== undefined ? credential : existing?.credential,
      hasCredential: credential !== undefined ? true : existing?.hasCredential ?? false,
      connectedAt: existing?.connectedAt ?? null,
      lastValidatedAt: existing?.lastValidatedAt ?? null,
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt ?? null,
      error: existing?.error ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.entries.set(input.source, record);
    return toMetadata(record);
  }

  protected updateStatusInMemory(input: UpdateStatusInput): CredentialVaultRecordMetadata {
    this.assertScope(input.tenantId, input.productId);
    assertSourceId(input.source);
    const status = assertStatus(input.status);
    const error = input.error !== undefined ? sanitizeConnectionError(input.error) : undefined;
    const existing = this.entries.get(input.source);
    if (!existing) {
      throw new CredentialVaultNotFoundError(
        `No credential vault record exists for source "${input.source}" in scope ` +
          `${this.tenantId}/${this.productId}; call upsertConnection first`,
      );
    }
    const timestamp = this.now();
    const record: StoredRecord = {
      ...existing,
      status,
      error: error !== undefined ? error : existing.error,
      connectedAt: input.connectedAt !== undefined ? input.connectedAt : existing.connectedAt,
      lastValidatedAt: input.lastValidatedAt !== undefined ? input.lastValidatedAt : existing.lastValidatedAt,
      lastSyncAt: input.lastSyncAt !== undefined ? input.lastSyncAt : existing.lastSyncAt,
      lastSuccessfulSyncAt:
        input.lastSuccessfulSyncAt !== undefined ? input.lastSuccessfulSyncAt : existing.lastSuccessfulSyncAt,
      updatedAt: timestamp,
    };
    this.entries.set(input.source, record);
    return toMetadata(record);
  }

  protected disconnectInMemory(input: DisconnectInput): CredentialVaultRecordMetadata {
    this.assertScope(input.tenantId, input.productId);
    assertSourceId(input.source);
    const existing = this.entries.get(input.source);
    if (!existing) {
      throw new CredentialVaultNotFoundError(
        `No credential vault record exists for source "${input.source}" in scope ` +
          `${this.tenantId}/${this.productId}; nothing to disconnect`,
      );
    }
    const timestamp = this.now();
    const record: StoredRecord = {
      ...existing,
      credential: undefined,
      hasCredential: false,
      status: "not-connected",
      connectedAt: null,
      error: null,
      updatedAt: timestamp,
    };
    this.entries.set(input.source, record);
    return toMetadata(record);
  }

  protected assertScope(tenantId: string, productId: string): void {
    if (tenantId !== this.tenantId || productId !== this.productId) {
      throw new CredentialVaultScopeError(
        `Request scope ${tenantId}/${productId} does not match credential vault scope ` +
          `${this.tenantId}/${this.productId}`,
      );
    }
  }
}

function toMetadata(record: StoredRecord): CredentialVaultRecordMetadata {
  // Destructuring drops `credential` entirely — the returned object never
  // has the key at all (not even set to `undefined`) — and deep-clones
  // `config`/`error` so a caller mutating the returned object can never
  // affect the store. `hasCredential` is always recomputed from the actual
  // presence of `credential` here (rather than trusting whatever value the
  // stored record carries) so it can never drift from reality.
  const { credential, config, error, ...rest } = record;
  return {
    ...rest,
    hasCredential: credential !== undefined,
    config: cloneConfig(config),
    error: error ? { ...error } : null,
  };
}

function cloneConfig(config: SourceConfig): SourceConfig {
  const clone: SourceConfig = {};
  for (const [key, value] of Object.entries(config)) {
    clone[key] = Array.isArray(value) ? [...value] : value;
  }
  return clone;
}

export function assertScopeId(name: string, value: string): void {
  if (typeof value !== "string" || !SCOPE_ID_PATTERN.test(value)) {
    throw new CredentialVaultValidationError(
      `${name} must use only letters, numbers, underscores, or hyphens`,
    );
  }
}

export function assertSourceId(value: unknown): asserts value is SourceId {
  if (typeof value !== "string" || !(SOURCE_IDS as readonly string[]).includes(value)) {
    throw new CredentialVaultValidationError(
      `source must be one of: ${SOURCE_IDS.join(", ")}`,
    );
  }
}

export function assertStatus(value: unknown): ConnectionStatus {
  if (typeof value !== "string" || !(CONNECTION_STATUSES as readonly string[]).includes(value)) {
    throw new CredentialVaultValidationError(
      `status must be one of: ${CONNECTION_STATUSES.join(", ")}`,
    );
  }
  return value as ConnectionStatus;
}

export function assertOwnerSubject(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > OWNER_SUBJECT_MAX_LENGTH
  ) {
    throw new CredentialVaultValidationError(
      `ownerSubject must be a non-empty string of at most ${OWNER_SUBJECT_MAX_LENGTH} characters`,
    );
  }
  return value;
}

export function assertCredential(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > CREDENTIAL_MAX_LENGTH) {
    throw new CredentialVaultValidationError(
      `credential must be a non-empty string of at most ${CREDENTIAL_MAX_LENGTH} characters`,
    );
  }
  return value;
}

/** Normalizes a config key for secret-like-substring matching: lower-cased, non-alphanumeric stripped. */
function normalizeConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretLikeKey(key: string): boolean {
  const normalized = normalizeConfigKey(key);
  return SECRET_LIKE_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * Validates and returns a sanitized copy of connector configuration.
 * Configuration is intentionally non-secret: every value must be a string
 * or array of strings within length/count limits, and any key that looks
 * like it might hold a secret (`apiKey`, `Authorization`, `password`,
 * `privateKey`, `secret`, `token`, `credential`, or any variant matching
 * those substrings once normalized) is rejected outright rather than
 * silently stored — callers must use `credential` for secret values.
 */
export function sanitizeConfig(value: unknown): SourceConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialVaultValidationError("config must be a JSON object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CONFIG_MAX_KEYS) {
    throw new CredentialVaultValidationError(`config must not have more than ${CONFIG_MAX_KEYS} keys`);
  }
  const sanitized: SourceConfig = {};
  for (const [key, entry] of entries) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new CredentialVaultValidationError("config keys must be non-empty strings");
    }
    if (isSecretLikeKey(key)) {
      throw new CredentialVaultValidationError(
        `config.${key} looks like it may hold a secret value; secrets must be passed as ` +
          "\"credential\", never inside config",
      );
    }
    if (Array.isArray(entry)) {
      if (
        entry.length === 0
        || entry.length > CONFIG_ARRAY_MAX_ITEMS
        || !entry.every(
          (item) => typeof item === "string" && item.trim().length > 0 && item.length <= CONFIG_VALUE_MAX_LENGTH,
        )
      ) {
        throw new CredentialVaultValidationError(
          `config.${key} must be a non-empty array of at most ${CONFIG_ARRAY_MAX_ITEMS} non-empty ` +
            `strings, each at most ${CONFIG_VALUE_MAX_LENGTH} characters`,
        );
      }
      sanitized[key] = entry.map((item) => (item as string).trim());
    } else if (
      typeof entry !== "string"
      || entry.trim().length === 0
      || entry.length > CONFIG_VALUE_MAX_LENGTH
    ) {
      throw new CredentialVaultValidationError(
        `config.${key} must be a non-empty string of at most ${CONFIG_VALUE_MAX_LENGTH} characters`,
      );
    } else {
      sanitized[key] = entry.trim();
    }
  }
  return sanitized;
}

/**
 * Copies only `code`/`category`/`message` out of an arbitrary error-like
 * value, discarding everything else (stack traces, raw provider response
 * bodies, headers, etc.) so persisted/returned error metadata is always
 * safe to log and never leaks upstream provider content.
 */
export function sanitizeConnectionError(value: ConnectionError | null | undefined): ConnectionError | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw new CredentialVaultValidationError("error must be an object with code/category/message");
  }
  const { code, category, message } = value as Record<string, unknown>;
  if (typeof code !== "string" || code.trim().length === 0 || code.length > ERROR_CODE_MAX_LENGTH) {
    throw new CredentialVaultValidationError(
      `error.code must be a non-empty string of at most ${ERROR_CODE_MAX_LENGTH} characters`,
    );
  }
  if (typeof category !== "string" || !(CONNECTION_ERROR_CATEGORIES as readonly string[]).includes(category)) {
    throw new CredentialVaultValidationError(
      `error.category must be one of: ${CONNECTION_ERROR_CATEGORIES.join(", ")}`,
    );
  }
  if (
    typeof message !== "string"
    || message.trim().length === 0
    || message.length > ERROR_MESSAGE_MAX_LENGTH
  ) {
    throw new CredentialVaultValidationError(
      `error.message must be a non-empty string of at most ${ERROR_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  return { code, category: category as ConnectionErrorCategory, message };
}
