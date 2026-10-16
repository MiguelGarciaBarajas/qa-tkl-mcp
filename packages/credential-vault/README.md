# @tkl/credential-vault

Tenant/product/source-scoped storage for connector **credentials** (Jira,
GitHub, TestRail, Confluence, ReportPortal API tokens, etc.) and their
non-secret connection metadata. Connector code and the future connection-
management API depend on this contract, not the reverse.

## Status

`@tkl/credential-vault` is **dependency-free** (no runtime dependencies at
all, not even `@tkl/contracts`; ESM, source-first `.ts` — see
[Node version requirement](#node-version-requirement) below).

## Node version requirement

This package requires **Node >=22.18.0**, matching the repository root's
`engines.node` floor. Its `src/index.js` entry point re-exports the `.ts`
sources directly (`export * from "./store.ts"`, and so on) — the same
source-first convention the rest of this repo uses — so *any* process that
imports `@tkl/credential-vault` must be able to load `.ts` files without a
flag. Node's native TypeScript type stripping is unflagged starting in
**Node 22.18.0**; below that, it is still gated behind
`--experimental-strip-types`. This repository's `build`/`lint`/`test`
scripts (here and at the repo root) pass that flag explicitly, so they keep
working on either side of that boundary.

## What it provides

- `InMemoryCredentialVault` — in-memory reference implementation. Useful for
  unit/contract tests. **Not durable; do not use in production.**
- `PersistentCredentialVault` (+ `createPersistentCredentialVault` factory) —
  durable, AES-256-GCM-encrypted implementation scoped by
  `tenantId`/`productId`, with one record per `source` per scope, atomic
  writes, crash-safe recovery, and serialized concurrent mutations.

Both implement the same `CredentialVault` interface:

```ts
interface CredentialVault {
  readonly tenantId: string;
  readonly productId: string;

  upsertConnection(input: UpsertConnectionInput): Promise<CredentialVaultRecordMetadata>;
  updateStatus(input: UpdateStatusInput): Promise<CredentialVaultRecordMetadata>;
  disconnect(input: DisconnectInput): Promise<CredentialVaultRecordMetadata>;
  get(tenantId: string, productId: string, source: SourceId): CredentialVaultRecordMetadata | undefined;
  list(tenantId: string, productId: string): CredentialVaultRecordMetadata[];
  resolveCredential(tenantId: string, productId: string, source: SourceId): Promise<string | undefined>;
}
```

A vault instance is scoped to exactly one `tenantId`/`productId` (mirroring
`@tkl/raw-evidence-store`/`@tkl/knowledge-store`); within that scope, one
record exists per `source`.

## Domain model

```ts
type SourceId = "jira" | "github" | "testrail" | "confluence" | "reportportal";

type ConnectionStatus =
  | "not-connected" | "validating" | "connected" | "syncing"
  | "stale" | "authorization-expired" | "error" | "disabled";

interface ConnectionError {
  code: string;
  category: "authorization" | "configuration" | "network" | "provider" | "internal";
  message: string;
}

interface CredentialVaultRecordMetadata {
  tenantId: string;
  productId: string;
  source: SourceId;
  ownerSubject: string;
  config: Record<string, string | string[]>; // sanitized, non-secret
  status: ConnectionStatus;
  hasCredential: boolean;   // never the credential value itself
  connectedAt: string | null;
  lastValidatedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  error: ConnectionError | null;
  createdAt: string;
  updatedAt: string;
}
```

**`CredentialVaultRecordMetadata` never contains a `credential` field** —
not even set to `undefined`. `get`/`list` always return this shape.
`upsertConnection` accepts a raw `credential` in its input but still only
ever *returns* sanitized metadata.

## Usage

```ts
import { createPersistentCredentialVault } from "@tkl/credential-vault";

const vault = await createPersistentCredentialVault({
  dataDirectory: "/var/lib/tkl/credential-vault",
  tenantId: "solera",
  productId: "fl-titling",
  keyRef: "secret://credential-vault/fl-titling",
  resolveKey: async (keyRef) => await mySecretManager.getKeyBytes(keyRef), // 32 bytes
});

// A UI/API layer creates or updates a connection. Returns sanitized metadata only.
const metadata = await vault.upsertConnection({
  tenantId: "solera",
  productId: "fl-titling",
  source: "jira",
  ownerSubject: "qa-lead@example.com",
  config: { baseUrl: "https://jira.example.com", allowedProjects: ["STT"] },
  credential: suppliedApiToken,
});
// metadata.status === "validating"; metadata has no `credential` field.

// A validation step (outside this package) then reports the outcome:
await vault.updateStatus({
  tenantId: "solera",
  productId: "fl-titling",
  source: "jira",
  status: "connected",
  lastValidatedAt: new Date().toISOString(),
});

// Trusted, server-side connector code (never a public API/MCP handler)
// resolves the actual credential to call the source API:
const token = await vault.resolveCredential("solera", "fl-titling", "jira");

// A user-initiated disconnect destroys the stored credential:
await vault.disconnect({ tenantId: "solera", productId: "fl-titling", source: "jira" });
```

### Status/credential semantics

- `upsertConnection` accepts a raw `credential` but returns sanitized
  metadata. Supplying a new/rotated `credential` resets `status` to
  `"validating"` unless an explicit `status` is also given, since a
  connection must be re-validated whenever its credential changes.
  Omitting `credential` (a config/owner-only update) leaves the existing
  credential and status untouched.
- `updateStatus` updates status/timestamps/error metadata only. It never
  accepts and never touches the stored credential, and throws
  `CredentialVaultNotFoundError` if `upsertConnection` has not been called
  for that source yet.
- `disconnect` destroys the stored credential, sets `status` to
  `"not-connected"`, clears `connectedAt`/`error`, and leaves
  `lastSyncAt`/`lastSuccessfulSyncAt` alone as sync history. Throws
  `CredentialVaultNotFoundError` if no record exists.
- `resolveCredential` is the **only** method that returns the actual
  credential value. It exists for trusted, server-side connector code (a
  plugin about to authenticate against a source API) and must never be
  reachable from a public HTTP/MCP handler or any path whose result could
  be serialized back to a caller.
- `get`/`list` always return sanitized metadata; the returned objects never
  carry a `credential` key (not even `undefined`), and are deep, independent
  copies — mutating one never affects the store.

## Validation

- `source` must be one of `jira`, `github`, `testrail`, `confluence`,
  `reportportal`.
- `status` (via `upsertConnection`'s optional `status` or `updateStatus`)
  must be one of the eight `ConnectionStatus` values listed above.
- `ownerSubject` must be a non-empty string of at most 320 characters.
- `config` must be a plain JSON object of at most 64 keys, each value a
  non-empty string (≤2048 chars) or a non-empty array of such strings
  (≤100 items) — arbitrary nesting/other types are rejected.
- **Any `config` key that looks like it might hold a secret is rejected
  outright**: keys are normalized (lower-cased, non-alphanumeric stripped)
  and checked for the substrings `apikey`, `authorization`, `credential`,
  `password`, `privatekey`, `secret`, `token` (so `apiKey`, `Authorization`,
  `private_key`, `API_KEY`, etc. are all caught). Secrets must always be
  passed as `credential`, never inside `config`.
- `credential` must be a non-empty string of at most 8192 characters.
- `error` (via `updateStatus`) is sanitized to exactly `{ code, category,
  message }` — `category` must be one of `authorization`, `configuration`,
  `network`, `provider`, `internal`; any other fields on the input (stack
  traces, raw provider response bodies, headers) are discarded, never
  persisted or returned.
- Every mutating call validates the given `tenantId`/`productId` against the
  vault instance's own scope and throws `CredentialVaultScopeError` on a
  mismatch, so a caller can never accidentally read or write another
  tenant/product's records through the wrong vault instance.

## Durable encryption

`PersistentCredentialVault` never writes plaintext to disk and never falls
back to plaintext if a key cannot be resolved. The **entire snapshot** (every
source record in the scope, config and all, including any stored credential)
is sealed in one versioned, authenticated envelope per write:

- Algorithm: AES-256-GCM.
- IV: random 96 bits (12 bytes) per write.
- Auth tag: verified on every read; any tampering of ciphertext **or** of the
  envelope's own metadata (`envelopeVersion`, `algorithm`, `tenantId`,
  `productId`, `schemaVersion`, `keyRef`) fails authentication, because that
  metadata is bound in as GCM additional authenticated data (AAD).
- Configuration holds only an explicit `keyRef` (for example
  `secret://credential-vault/fl-titling` or `env://CREDENTIAL_VAULT_KEY`),
  never the key itself. The caller injects a `resolveKey(keyRef, scope)`
  function that returns the actual 32-byte AES-256 key material at runtime
  (sync or async), given the same `keyRef` plus the vault's
  `{ tenantId, productId }` scope. **This package does not implement or
  invent a secret manager or KMS client** — wire `resolveKey` to whatever the
  deployment already uses.

## Durability, atomicity, and recovery

Storage layout mirrors `@tkl/raw-evidence-store`/`@tkl/knowledge-store`:

```text
<data-directory>/<tenant-id>/<product-id>/credential-vault.json      (durable, encrypted)
<data-directory>/<tenant-id>/<product-id>/credential-vault.json.tmp  (write-in-progress)
```

Every mutation (`upsertConnection`/`updateStatus`/`disconnect`) writes a full
encrypted snapshot of every source record in scope to the `.tmp` file,
**flushes it to durable storage (`fsync`) before attempting the rename**,
then atomically renames it over the durable file. **The rename is the
mutation's durability point:** once it succeeds, the mutation is committed;
the only remaining step (a best-effort containing-directory `fsync`, skipped
as unsupported on Windows) can never roll it back or fail it. A failure at
or before the rename (temp write/flush, or the rename itself) rolls the
in-memory mutation back to what was durable before the call, and
best-effort quarantines (removes) the failed temp file so a later restart
can never mistake it for a valid snapshot.

At startup (`createPersistentCredentialVault`/`initialize()`):

- If both a durable snapshot and a `.tmp` file exist, the durable snapshot is
  authenticated (scope, version, decryption) *before* the stale `.tmp` file
  is discarded. If the durable snapshot fails authentication, **both files
  are preserved untouched** and the vault fails closed instead of destroying
  the `.tmp` file, which may be the only remaining valid snapshot.
- A valid `.tmp` file is promoted (renamed over the durable path) when no
  durable snapshot exists yet — recovering a crash that happened between the
  temp write and the rename.
- Corrupt JSON, tampered ciphertext/metadata, a wrong key, an unsupported
  future envelope/schema version, or a tenant/product scope mismatch all
  **fail closed**: the constructor/factory rejects and the data directory is
  left untouched (nothing is deleted or rewritten).

## Isolation and safety

- Every vault instance is scoped to exactly one `tenantId`/`productId`;
  scopes are physically isolated (separate files), and `tenantId`/`productId`
  may only contain letters, numbers, underscores, or hyphens (no path
  traversal).
- Within a scope, each `source` has its own record; sources never share or
  clobber each other's credential, config, or status.
- `list`/`get` always return deep, independent, credential-free copies of
  metadata; mutating a returned value never affects the vault.
- Thrown errors and `ConnectionError` metadata carry only identifiers,
  fixed/sanitized messages, and codes — never credentials, raw provider
  response bodies, or key material.

## Concurrency

Mutations are **serialized per vault instance**: `upsertConnection`,
`updateStatus`, and `disconnect` all run their whole snapshot -> mutate ->
persist -> (rollback-on-failure) critical section exclusively, so
overlapping callers on the same instance can never interleave their
mutations, never race on the shared temp file, and each caller's reported
outcome always matches both in-memory state and what a restart reloads.

This is **in-process serialization only**. The vault has no cross-process
locking; running two processes against the same data directory/scope
concurrently is not supported — provide external mutual exclusion (or route
all writes for a scope through one process) if that is required.

## Run tests

```powershell
npm run test --workspace=@tkl/credential-vault
```
