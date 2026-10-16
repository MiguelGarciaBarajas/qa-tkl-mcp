# @tkl/raw-evidence-store

Owner: Jorge (Production Source Ingestion).

Source-neutral, durable, encrypted persistence boundary for `ING-105`: connectors
commit unnormalized raw evidence plus their sync checkpoint here, atomically, before
any normalization happens. This package knows nothing about Jira, GitHub, or
TestRail; connectors and the connector coordinator (`ING-104`) depend on this
contract, not the reverse.

## Status

`@tkl/raw-evidence-store` is dependency-free except `@tkl/contracts` (ESM,
source-first `.ts` — see [Node version requirement](#node-version-requirement)
below). It reuses `RawEvidenceRecord` and `SyncCheckpoint` from `@tkl/contracts`
unchanged.

## Node version requirement

This package requires **Node >=22.18.0**, matching the repository root's
`engines.node` floor. Its `src/index.js` entry point re-exports the `.ts`
sources directly (`export * from "./store.ts"`, and so on) — the same
source-first convention the rest of this repo uses — so *any* process that
imports `@tkl/raw-evidence-store` (not just this package's own
build/lint/test scripts, which pass `--experimental-strip-types` explicitly)
must be able to load `.ts` files without that flag. Node's native TypeScript
type stripping is unflagged (enabled by default, no
`--experimental-strip-types` needed) starting in **Node 22.18.0**; below that
(for example a locally installed Node 22.14.x), type stripping exists but is
still gated behind `--experimental-strip-types`, which this package cannot
pass on a caller's behalf. This repository's contributor-facing commands
(`build`/`lint`/`test`, here and at the repo root) continue to pass
`--experimental-strip-types` explicitly in every script that needs it, so
they keep working unchanged whether the local Node binary is just below or
at/above 22.18.0. `src/entry-node-version-contract.test.ts` verifies both
halves of this contract (the flag is required below 22.18.0; a plain,
unflagged import works at/above it) against whichever Node binary is actually
running the suite,
instead of assuming the local runtime satisfies the newer half.

## What it provides

- `InMemoryRawEvidenceStore` — in-memory reference implementation. Useful for
  contract/unit tests. **Not durable; do not use in production.**
- `PersistentRawEvidenceStore` (+ `createPersistentRawEvidenceStore` factory) —
  durable, AES-256-GCM-encrypted implementation scoped by `tenantId`/`productId`,
  with atomic commits, crash-safe recovery, and one checkpoint namespace per
  connector ID.

Both implement the same `RawEvidenceStore` interface:

```ts
interface RawEvidenceStore {
  commit(request: RawEvidenceCommitRequest): Promise<RawEvidenceCommitResult>;
  getCheckpoint(connectorId: string): SyncCheckpoint | undefined;
  getRecord(idempotencyKey: string): RawEvidenceRecord | undefined;
  listRecords(filter?: RawEvidenceListFilter): RawEvidenceRecord[];
  countPendingProjectionRecords(): number;
  listPendingProjectionRecords(limit?: number): RawEvidenceRecord[];
  acknowledgeProjected(idempotencyKeys: string[]): Promise<void>;
  recordProjectionFailures(idempotencyKeys: string[]): Promise<ProjectionFailureResult>;
  countDeadLetterProjectionRecords(): number;
  listDeadLetterProjectionRecords(limit?: number): ProjectionFailureMetadata[];
  requeueDeadLetterProjectionRecords(idempotencyKeys: string[]): Promise<number>;
  history(connectorId?: string): RawEvidenceHistoryEntry[];
}
```

Projection delivery uses the same encrypted append-only transaction log as evidence
commits. A failed projection stores only a fixed `projection-failed` code, connector
and idempotency identifiers, attempt count, and first/last failure timestamps; raw
error messages, stacks, payloads, and source responses are never accepted. Retryable
records rotate to the back of the pending queue. At `projectionFailureThreshold`
(default `3`) they move to the DLQ until explicitly requeued. Counts are O(1), lists
are caller-bounded, and one requeue call accepts at most 1,000 keys.

Transaction compatibility is explicit by kind:

- evidence commits are read at versions 1 and 2 and continue to be written at
  version 2 (`projectionKeys` was added in v2);
- projection acknowledgements are read at versions 1 and 2 and written at
  version 2; and
- projection-failure and projection-requeue transactions are introduced and
  written only at version 3.

The reader rejects a kind paired with any other version and rejects transaction
versions newer than 3 before applying them. Keeping the new kinds at v3 is
intentional: binaries whose maximum supported transaction version is v2 fail
closed on those chunks instead of attempting to interpret them as a v2
transaction. Current binaries still replay existing v1/v2 stores.

Projection runners must distinguish projection failures from acknowledgement
failures. Only a rejected `projectRecords` call should be passed to
`recordProjectionFailures`. If `acknowledgeProjected` rejects, that durability
error must propagate; the store leaves the records pending and does not increment
their projection-failure attempts.

## Connector / coordinator usage

A connector (or the future `ING-104` coordinator that runs one) calls `commit` once
per collected batch, with the records plus the new sync cursor:

```ts
const result = await store.commit({
  connectorId: "connector.jira",
  records: batchOfRawEvidenceRecords,
  checkpoint: { cursor: nextPageCursor, observedAt: new Date().toISOString() },
});
// result.committedCount / result.duplicateCount / result.checkpointAdvanced
```

The commit is one atomic transaction: either every new record and the checkpoint
update land together, or none of them do. If any record in the batch reuses an
existing `idempotencyKey` with different content, the whole commit — including the
checkpoint — is rejected and rolled back, so a connector can safely retry the same
page without ever advancing past evidence it has not durably recorded.

Idempotency key: callers may set `RawEvidenceRecord.idempotencyKey` explicitly;
otherwise the store derives `` `${source}:${sourceId}:${sourceVersion}` ``. Replaying
an identical record is a no-op counted as a duplicate — "identical" compares every
field *except* `observedAt` (source/sourceId/sourceVersion/sourceUrl, contentType,
contentHash, payload, classification, idempotencyKey), since `observedAt` is when the
record was *observed*, not part of its immutable source identity, and legitimately
changes on every resumed page or periodic re-sync of otherwise-unchanged evidence.
The same key with a change to any of those immutable fields always fails explicitly —
it is never silently overwritten.

## Durable encryption

`PersistentRawEvidenceStore` never writes plaintext to disk and never falls back to
plaintext if a key cannot be resolved. Every base snapshot and transaction chunk is sealed in a versioned,
authenticated envelope:

- Algorithm: AES-256-GCM.
- IV: random 96 bits (12 bytes) per write.
- Auth tag: verified on every read; any tampering of ciphertext **or** of the
  envelope's own metadata (`envelopeVersion`, `algorithm`, `tenantId`, `productId`,
  `schemaVersion`, `keyRef`) fails authentication, because that metadata is bound in
  as GCM additional authenticated data (AAD).
- Configuration holds only a `keyRef` (for example `secret://raw-evidence/fl-titling`
  or `env://RAW_EVIDENCE_KEY`), matching the same `secret://`/`env://` convention as
  connector credential references. The caller injects a `resolveKey(keyRef, scope)`
  function that returns the actual 32-byte AES-256 key material at runtime (sync or
  async). **This package does not implement or invent a secret manager or KMS
  client** — wire `resolveKey` to whatever the deployment already uses.

```ts
const store = await createPersistentRawEvidenceStore({
  dataDirectory: "/var/lib/tkl/raw-evidence",
  tenantId: "solera",
  productId: "fl-titling",
  keyRef: "secret://raw-evidence/fl-titling",
  resolveKey: async (keyRef) => await mySecretManager.getKeyBytes(keyRef), // 32 bytes
});
```

## Durability, atomicity, and recovery

Storage is a backward-compatible base snapshot plus an append-only transaction
log:

```text
<scope>/raw-evidence-store.json                         (optional legacy encrypted base)
<scope>/raw-evidence-store.json.tmp                     (legacy recovery only)
<scope>/raw-evidence-store.chunks/0000000000000001.json (encrypted transaction)
<scope>/raw-evidence-store.chunks/0000000000000002.json (encrypted transaction)
<scope>/raw-evidence-store.chunks/pending.json.tmp       (write-in-progress)
```

On initialization, the store decrypts the optional legacy base once, then
replays the numbered chunks in strict contiguous order. The legacy base is
never rewritten. Fresh stores may have no base at all; their first and
subsequent commits are chunks. This keeps serialization and encryption bounded
by one commit instead of by the complete accumulated dataset, avoiding V8's
maximum string length when an existing base is hundreds of megabytes.

Each successful commit writes exactly one encrypted transaction containing only
its newly accepted records, checkpoint mutation (set, clear, or unchanged), and
history entry. These parts remain atomic because they are authenticated and
promoted as one file. The store writes `pending.json.tmp`, **flushes it to
durable storage (`fsync`) before attempting the rename**, then atomically renames
it to the next numbered chunk. **The rename is the commit's durability point:**
once it succeeds, `commit()` never reports failure or rolls back the in-memory
mutation. The chunks directory is then best-effort `fsync`ed. Windows cannot
`fsync` a directory handle (`EPERM`), so that known platform limitation is
treated as a no-op. Any other post-rename directory-sync error is surfaced as a
sanitized, non-fatal `DurabilityWarning` (`{ stage: "directory-sync",
connectorId, occurredAt, message, errorCode? }`) via:

- an optional `onDurabilityWarning(warning)` constructor callback (best-effort:
  if the callback itself throws, that is swallowed too, so a broken logging sink
  can never turn a committed transaction into a reported failure),
- the `durabilityWarning` field on that call's `RawEvidenceCommitResult`, and
- the store's `lastDurabilityWarning` getter, reset to `null` on every commit
  that raises no warning.

The warning's `occurredAt` timestamp is captured from the store's clock
*before* the rename is attempted, not by calling the clock again once the
warning is actually built (after the rename has already succeeded): nothing on
that post-rename path may call a caller-injected clock, since a throw there
would otherwise be indistinguishable, from `commit()`'s point of view, from a
genuine pre-rename failure and incorrectly roll back an already-durable
transaction.

If the temp-file flush or rename fails before the commit point, the failed
transaction is rolled back in memory and its temp file is quarantined. A
rejected commit must never be promoted by a later `initialize()`. Quarantine
writes a `<temp-file>.rejected` tombstone marker and makes it
crash-durable *itself* — flushed (`fsync`) and, on platforms that support it,
its containing directory synced too — before attempting that removal, and
before the rejected commit is ever reported back to the caller. Establishing
the marker durably before returning closes the gap a merely-`writeFileSync`d
marker would leave: without a flush and a directory sync, the marker's bytes or
its directory entry might never reach disk before a crash, so a later restart
could find the leftover temp file with no marker at all and wrongly treat a
deliberately-rejected transaction as a safe crash-before-rename leftover to
authenticate and promote. Once the marker is durable, if the removal itself
also fails (a locked file, a permissions error), the marker is what lets a
later `initialize()` recognize this leftover as an explicitly rejected commit
rather than a genuine crash-before-rename leftover — the two are otherwise
indistinguishable on disk, but must never be handled the same way (see the
recovery bullets below).

If the marker *cannot* be made durable (its flush or its directory sync
throws) and the temp-file removal also fails, quarantine falls back to a
marker-independent, durable/validated protocol instead of leaving an ambiguous
leftover: it durably overwrites the temp file's own bytes with content that
can never pass envelope validation, so a startup that finds this temp file
with no marker present still fails closed on it (via the ordinary
corrupt-temp-file recovery path) rather than silently promoting a rejected
transaction.

These low-level file operations are exposed as an injectable `fsOperations`
constructor option (`PersistFsOperations` — `writeFileDurable`, `rename`,
`syncDirectory`, and `removeTempFile`; defaulting to the real
`nodeFsOperations`) purely as a test seam for exercising flush/rename/directory-sync/
removal ordering and failure handling deterministically, including the marker's
own write-flush-directory-sync ordering and failures; production callers
should not need to set it. At startup (`createPersistentRawEvidenceStore` / `initialize()`):

- If a rejected-commit tombstone marker is present, its temp file (if the
  earlier quarantine removal failed and it is still there) is **never**
  authenticated or promoted, no matter what it contains. Startup retries the
  removal; once it succeeds, both the marker and the `.tmp` file are gone and
  startup proceeds normally against whatever durable base/chunks exist. If
  removal still fails, startup fails closed (refuses to start) rather than
  guessing. This check runs *before* the durable-vs-`.tmp` comparison below.
- Legacy snapshot recovery remains supported. When both a legacy base and its
  `.tmp` file exist, the base is
  authenticated (scope, version, and decryption) *before* the stale `.tmp` file is
  discarded. If the durable base fails authentication, **both files are
  preserved untouched** and the store fails closed instead of destroying the
  `.tmp` file, which may be the only remaining valid snapshot.
- A stale legacy `.tmp` file is discarded only once the base has authenticated
  (the durable base wins).
- A valid legacy `.tmp` file is promoted when no base exists (crash between
  write and rename is recovered).
- A valid pending transaction whose sequence is exactly next is promoted and
  replayed. If its numbered chunk already exists and authenticates, the durable
  chunk wins and the stale temp is removed. Gaps, duplicate sequence content,
  malformed transactions, or non-contiguous history fail closed.
- Corrupt JSON, tampered ciphertext/metadata, a wrong key, an unsupported future
  envelope/schema version, or a tenant/product scope mismatch all **fail closed**:
  the constructor/factory rejects and the data directory is left untouched (nothing
  is deleted or rewritten).

If a durable write fails *before the rename* (temp-file flush failure, rename
failure, or key-resolver failure), in-memory state — including the checkpoint
and history — is rolled back to the previously durable state. This rollback
covers the entire in-memory commit step: the checkpoint is
deep-cloned/validated and the store's clock (`now()`) is evaluated *before* any
record, checkpoint, or history mutation happens, so a non-structured-cloneable
checkpoint (`DataCloneError`) or a throwing clock aborts the commit exactly like an
idempotency-key conflict — no partial mutation ever needs to be unwound because
none ever happened.

## Isolation and safety

- Every store instance is scoped to exactly one `tenantId`/`productId`; scopes are
  physically isolated (separate files) and `tenantId`/`productId` may only contain
  letters, numbers, underscores, or hyphens (no path traversal).
- Checkpoints are namespaced per `connectorId` within a scope, so Jira/GitHub/TestRail
  connectors (or multiple repos/projects encoded into distinct `connectorId`s) never
  share or clobber each other's cursor. `connectorId` accepts the same
  `[A-Za-z0-9_-]` alphabet plus dot-separated segments (for example the canonical
  plugin ID `connector.jira`), so it can hold either a plain scope-style ID or a
  `@tkl/plugin-registry` plugin ID; path separators and traversal segments (`..`,
  leading/trailing/doubled dots) are always rejected.
- `listRecords`, `getRecord`, `getCheckpoint`, and `history` all return deep,
  independent copies; mutating a returned value never affects the store.
- History entries and thrown errors carry only identifiers (idempotency keys,
  connector IDs, counts) — never payloads, credentials, or key material.

## One-writer scope: in-process serialization vs. cross-process limitation

**In-process, concurrent `commit()` calls are safe.** `PersistentRawEvidenceStore`
serializes commits per store *instance*: the whole capture → commit-in-memory →
persist → rollback critical section runs exclusively, so overlapping callers never
interleave their mutations, never share the temp file mid-write, and each caller's
reported outcome always matches in-memory state and what a restart reloads (both
callers' checkpoints are preserved). No API change is needed — overlapping
`commit()` calls are simply ordered.

**Across processes, one writer per scope is still required.** The store has no
cross-process locking or database transactions. Running two ingestion *processes*
against the same data directory/scope concurrently can still race on the atomic
rename and is not supported. `OPS-101` (`@tkl/sync-coordinator`) works within this
constraint rather than removing it: it serializes runs per
tenant/product/connector inside one process, requires one ingestion process per
tenant/product scope (see `docs/runbooks/scheduled-sync.md`), and accepts an
injected `externalLock` lease for deployments that can provide real cross-process
mutual exclusion. A lock-aware storage adapter here remains future work.

## Key rotation and migration

- **Key rotation:** every base/chunk records and authenticates its `keyRef`.
  There is no in-place mixed-key rotation helper yet; use an offline migration
  that reads the old store and writes a new scope with the new key.
- **Schema migration:** the envelope's `schemaVersion` is authenticated and checked
  on every read. A future higher schema version is rejected (fail closed) rather
  than silently discarded; add an explicit migration path (as
  `PersistentKnowledgeStore` does for its schema `0` → `1` migration) before bumping
  `SCHEMA_VERSION`.

## Run tests

```powershell
npm run test --workspace=@tkl/raw-evidence-store
```
