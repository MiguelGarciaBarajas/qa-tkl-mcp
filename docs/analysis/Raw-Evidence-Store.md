# Raw Evidence Store

## Scope

`@tkl/raw-evidence-store` is the dependency-free durable implementation for
`ING-105`: the persistence boundary connectors commit unnormalized raw evidence and
their sync checkpoint into, before any normalization or coverage logic runs. It is
source-neutral — it has no Jira/GitHub/TestRail-specific code — so it can back every
current and future connector.

`InMemoryRawEvidenceStore` remains available for isolated unit/contract tests.
`PersistentRawEvidenceStore` (via the `createPersistentRawEvidenceStore` async
factory) is the durable, encrypted implementation intended for real ingestion runs.

Consumers import both from the package entry point, `import { ... } from
"@tkl/raw-evidence-store"`. Following the repository's source-first
`node --experimental-strip-types` convention, `src/index.js` re-exports the `.ts`
sources directly (`export * from "./store.ts"`, and so on); it is not a compiled
artifact. Because any consumer process (not just this package's own scripts) must
be able to load those `.ts` sources, this package requires **Node >=22.18.0**,
the version where native TypeScript type stripping became unflagged (enabled by
default) — the repository root's `engines.node` floor was raised to the same
`>=22.18.0` value so the two no longer disagree. Below that version, type
stripping still exists but requires `--experimental-strip-types` explicitly on
whatever process is doing the importing; this package cannot supply that flag on
a caller's behalf. `src/package-entry.test.ts` imports the package by its bare
specifier (not a relative path) specifically to catch a regression where the
entry point re-exports resolve to nonexistent modules; `src/entry-node-version-contract.test.ts`
additionally verifies, against whichever Node binary is actually running the
suite, that a plain unflagged import fails below the 22.18.0 floor and succeeds
at/above it (so this stays a real, runtime-checked contract instead of an
assumption); and `npm run build` also runs a runtime import check
(`verify-entry`) for the same reason.

## Storage Layout

The caller supplies a local data directory plus validated `tenantId` and `productId`
values. Each scope is physically isolated:

```text
<data-directory>/<tenant-id>/<product-id>/raw-evidence-store.json
```

Scope identifiers (`tenantId`/`productId`) cannot contain path separators or
traversal segments (same `[A-Za-z0-9_-]` pattern as `PersistentKnowledgeStore`).
`connectorId` uses a related but slightly wider pattern: the same `[A-Za-z0-9_-]`
alphabet, plus dot-separated segments (for example the canonical plugin ID
`connector.jira`), so it accepts both plain scope-style IDs and
`@tkl/plugin-registry` plugin IDs while still rejecting path separators and
traversal-style values (`..`, leading/trailing/doubled dots). Every committed
record must match the store's tenant and product.

Checkpoints are namespaced per `connectorId` inside the same scoped file — one
checkpoint per connector ID/scope — so multiple connectors (or multiple
repo/project-scoped `connectorId`s for the same source) never share or overwrite
each other's sync cursor.

## Durability and Atomicity

Each `commit()` call is one transaction covering both new evidence records and the
connector's checkpoint:

1. Every record in the batch is validated for tenant/product scope and for
   idempotency-key conflicts *before* anything is mutated in memory. The
   checkpoint is also deep-cloned/validated and the store's clock (`now()`) is
   evaluated before that same point, so a non-structured-cloneable checkpoint
   (`DataCloneError`) or a throwing clock aborts the commit exactly like a
   conflict — before any record, checkpoint, or history mutation happens.
2. If any record reuses an existing idempotency key with different content, the
   entire commit — including any other, unrelated records in the same batch and the
   checkpoint update — is rejected. Nothing is written.
3. If validation passes, records and the checkpoint are applied in memory, then a
   full encrypted snapshot is written to `raw-evidence-store.json.tmp`, flushed
   (`fsync`ed) to durable storage, and atomically renamed over the durable file.
   **This rename is the commit's durability point.** Once it succeeds, the
   transaction is committed: `commit()` never reports it as failed and never
   rolls back the in-memory state it already applied, regardless of what
   happens afterward.
4. If the temp-file flush or the rename itself fails (disk error, key-resolver
   failure, and so on) — i.e. anything *before* the commit point in step 3 — the
   in-memory state — including the checkpoint — is rolled back to what was
   durable before the commit, and the temp file is quarantined. This rollback
   covers the entire in-memory-commit step, not merely the durable write, so any
   failure mode inside it also leaves the store untouched. Quarantine writes a
   best-effort "rejected" tombstone marker for the temp file *before* attempting
   to remove it: if that removal itself then fails too (for example a locked
   file), the marker is what lets a later startup tell this deliberately-rejected
   leftover apart from a genuine crash-before-rename leftover (the two are
   otherwise indistinguishable on disk) and refuse to ever promote it — see
   "Recovery" below.
5. After the rename succeeds, the containing scope directory is best-effort
   `fsync`ed too, so the rename's own directory-entry update is durable across an
   immediate crash, on platforms that support it (skipped as a no-op only for the
   known-unsupported case of `fsync` on a directory handle on Windows). Any other
   directory-sync failure at this point is *not* a commit failure — the rename
   already landed — so it is surfaced instead as a sanitized, non-fatal
   `DurabilityWarning` (identifiers, a fixed description, and an optional error
   code only; never record payloads, checkpoint content, or key material) via an
   optional injected `onDurabilityWarning` callback, the commit result's
   `durabilityWarning` field, and the store's `lastDurabilityWarning` state. The
   warning's timestamp is captured from the store's clock *before* the rename is
   attempted (not when the warning is built, after the rename has already
   succeeded), so nothing on this post-rename path can ever call a
   caller-injected clock again and turn an already-committed transaction into a
   rollback if that clock throws.

An identical replay of an already-stored record (same idempotency key, same
canonical content) is a no-op counted as a duplicate; it does not create a new
history entry beyond the surrounding commit's duplicate count and does not require
callers to pre-filter already-seen evidence. "Same canonical content" excludes
`observedAt`: that field is the observation timestamp, not part of the source's
immutable identity, and legitimately differs on every resumed page or periodic
re-sync of otherwise-unchanged evidence. A reused idempotency key with a changed
`source`, `sourceId`, `sourceVersion`, `sourceUrl`, `contentType`, `contentHash`,
`payload`, or `classification` is still a conflict and is rejected, even if
`observedAt` also changed.

## Durable Encryption

Snapshots are never written in plaintext. Each write produces a versioned,
authenticated envelope:

- **Algorithm:** AES-256-GCM.
- **IV:** a fresh random 96-bit (12-byte) value per write; IVs are never reused for a
  given key.
- **Authentication:** the auth tag is verified on every read. The envelope's own
  visible metadata (`envelopeVersion`, `algorithm`, `tenantId`, `productId`,
  `schemaVersion`, `keyRef`) is bound into the tag as additional authenticated data
  (AAD), so tampering with those fields — not just the ciphertext — fails
  authentication.
- **Key handling:** configuration holds only a `keyRef` (for example
  `secret://raw-evidence/fl-titling`), matching the existing connector
  `CredentialReference` convention. A `resolveKey(keyRef, scope)` function is
  injected at runtime and returns the actual key material; there is no plaintext
  fallback if it is missing, throws, or returns the wrong length. This package
  intentionally does not implement a secret manager or KMS client — integrate
  `resolveKey` with whatever the deployment already uses.

## Recovery

Each write goes to a temp file which is flushed (`fsync`ed) to durable storage,
then atomically renamed over the durable file — the rename is the commit's
durability point. After that rename succeeds, the containing scope directory is
best-effort `fsync`ed so the rename's directory-entry update is durable too, on
platforms that support it (Windows raises `EPERM` fsyncing a directory handle,
which is the one known-unsupported case swallowed as a no-op). Any other
directory-sync failure at this point no longer fails the commit or rolls it
back — the rename already landed — it is instead surfaced as a sanitized
`DurabilityWarning` (see "Durability and Atomicity" above). If the temp-file
flush or the rename itself fails (i.e. before the commit point), the temp file
is quarantined (removed) before the error propagates to the caller, so a
rejected transaction's temp file can never be authenticated and promoted by a
later startup. Quarantine writes a best-effort "`.tmp.rejected`" tombstone
marker next to the temp file before attempting its removal; if the removal
itself also fails, the marker is what a later startup uses to recognize this
leftover as an explicitly rejected commit rather than a genuine
crash-before-rename leftover.

At startup, before the durable-vs-temporary comparison below runs at all:

- If a rejected-commit tombstone marker exists, its temp file — if the earlier
  removal attempt failed and it is still present — is never authenticated or
  promoted, no matter what it contains. Startup retries the removal; once it
  succeeds (marker and temp file both cleared), startup proceeds normally using
  only the durable snapshot, if any. If the removal still fails, startup fails
  closed (refuses to start) instead of guessing.

Only once there is no rejected-commit marker does the ordinary
crash-vs-durable comparison apply:

- When both a durable snapshot and a temporary file exist, the durable snapshot is
  authenticated (scope, version, and decryption) *before* the temporary file is
  discarded. If the durable snapshot fails authentication, both files are preserved
  untouched and the store fails closed — the temporary file may be the only
  remaining valid snapshot and must not be destroyed based on an unauthenticated
  durable file.
- A stale temporary file is discarded once the durable snapshot has authenticated
  (durable wins).
- A valid temporary file is promoted when no durable snapshot exists (recovers a
  crash between the write and the rename).
- Invalid JSON, an invalid envelope shape, a tampered ciphertext or metadata field,
  a wrong decryption key, a scope mismatch, or an unsupported future
  envelope/schema version all fail explicitly and leave the data directory
  untouched — nothing is silently discarded, promoted, or rewritten.

### Concurrent commits: in-process serialization vs. the cross-process limitation

These are two different concerns and only the first is solved inside the store:

- **In-process (solved):** `PersistentRawEvidenceStore.commit()` is serialized per
  store *instance*. The whole critical section — snapshot memory, apply the commit
  in memory, write the temp snapshot, rename it, and roll back on failure — runs
  exclusively, so two overlapping `commit()` calls on one instance cannot interleave
  their in-memory mutation with another transaction's rollback snapshot and cannot
  write the shared temp path at the same time. Every caller keeps the same public
  API and still gets its own transaction's outcome, which always matches both
  in-memory state and what a restart reloads; both callers' checkpoints are
  preserved. Overlapping callers are simply ordered: the second one's promise
  resolves after the first transaction reaches its durability point.
- **Cross-process (still a limitation):** the store has no cross-process locking or
  database transactions, so two *processes* (or two store instances in different
  processes) writing the same data directory/scope can still race on the atomic
  rename. That remains unsupported, the same limitation `PersistentKnowledgeStore`
  documents. Coordinating concurrent writers still requires serializing ingestion
  per scope — one ingestion process per tenant/product — or a future storage adapter
  with cross-process locking or database transactions. `OPS-101`
  (`@tkl/sync-coordinator`) consumes this constraint rather than removing it: it
  prevents overlapping runs per tenant/product/connector **within a process**,
  documents the cross-process requirement in `docs/runbooks/scheduled-sync.md`, and
  exposes an `externalLock` seam so a deployment that can provide a real lease
  (database row lock, blob lease, job-runner concurrency policy) can enforce
  exclusion without this package pretending to.

## Schema, Versioning, and Migration

Snapshots currently use schema version `1`, authenticated as part of the envelope.
A future higher schema version is rejected outright (fail closed) rather than
silently discarded or coerced; adding a migration (as `PersistentKnowledgeStore`
does for its schema `0` → `1` step) is required before the version is ever bumped.

Key rotation is a read-under-old-key, write-under-new-key operation today: there is
no in-place re-encryption helper. A rotation script should open a store with the
old `keyRef`/`resolveKey`, and re-commit its contents into a store configured with
the new `keyRef`/`resolveKey`.

## History and Safety

The append-only commit history and all read APIs (`listRecords`, `getRecord`,
`getCheckpoint`, `history`) return independent, deep copies — mutating a returned
value never affects stored state, matching the "immutable copies on read/replay"
requirement so downstream normalizers can safely replay evidence. History entries
and every thrown error carry only identifiers (idempotency keys, connector IDs,
counts) — never raw payloads or credential/key material.

## Production Configuration

As with `PersistentKnowledgeStore`, runtime configuration must place the data
directory outside committed source artifacts, and must never place credential or
key values in the path or in `keyRef` itself (it is a reference, not a secret).
