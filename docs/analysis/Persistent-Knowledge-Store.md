# Persistent Knowledge Store

## Scope

`SqliteKnowledgeStore` is the dependency-free local/default durable implementation. It
uses Node's built-in `node:sqlite` `DatabaseSync` API and preserves the synchronous
`KnowledgeStore` contract so current core, analyzer, evaluation, API, and dashboard
consumers do not require an asynchronous storage migration.

`InMemoryKnowledgeStore` remains available for isolated unit tests.
`PersistentKnowledgeStore` remains available as a read/write legacy JSON implementation
for compatibility and migration tests, but the Application API factory no longer selects
it by default.

## Storage Layout

The caller supplies a local data directory plus validated `tenantId` and `productId`
values. The SQLite database contains tenant/product columns on every canonical table:

```text
<data-directory>/knowledge-store.sqlite
```

Scope identifiers cannot contain path separators or traversal segments. Every query and
mutation is tenant/product scoped, every loaded or written entity must match the store's
scope, and trace links retain the existing same-scope endpoint checks.

Legacy snapshots remain at:

```text
<data-directory>/<tenant-id>/<product-id>/knowledge-store.json
```

## Durability and Atomicity

Each mutation uses `BEGIN IMMEDIATE` and commits its canonical changes plus operation
history and an idempotent serving-projection outbox row atomically. Batch `upsert` is one
database transaction. Invalid entities, claims, links, or reviews roll back without
partial rows, history entries, or outbox work.

Projection application and outbox acknowledgement share a second transaction. A crash
before that transaction leaves the outbox row pending; a crash during it rolls back both
the projection update and acknowledgement; a replay after commit is harmless. This
provides at-least-once projection delivery and idempotent final state.

SQLite runs with foreign keys enabled, WAL journaling, full synchronous durability, and
a configurable busy timeout (`TKL_KNOWLEDGE_SQLITE_BUSY_TIMEOUT_MS`, default 5000 ms).
Independent API processes can safely serialize writers through SQLite locking. Database
corruption, invalid JSON, unsupported schemas, and lock timeouts fail explicitly; there
is no fallback to the legacy JSON store.

## Schema and History

The relational schema is versioned with `PRAGMA user_version` plus a
`schema_migrations` table. Normalized/indexed tables store entities, claims, trace links,
deferred trace links, conflicts and their claim memberships, reviews and approved
claims, provenance, metadata, and append-only operation history. JSON record columns
preserve the exact public contract while indexed relational columns support direct
lookups without loading the corpus.

The Gold serving layer consists of:

- `serving_entity_search`, a materialized, versioned entity document containing title,
  entity ID/type, scalar metadata, non-rejected claim text, entity source references, and
  connected trace-link identifiers;
- `serving_entity_search_fts`, an external-content SQLite FTS5 index using the trigram
  tokenizer when supplied by the SQLite runtime;
- `serving_projection_outbox`, the durable transaction boundary between canonical
  Silver writes and Gold refresh.

Search keeps legacy entity-ID/title matches first in canonical sequence, followed by
supplemental canonical-text matches in canonical sequence. Tenant/product and source
provenance filters are applied before pagination. Empty queries use the materialized
table directly. If FTS5 or its trigram tokenizer is unavailable, search uses the same
materialized document with a deterministic substring fallback instead of failing open or
inventing embeddings.

On first open for a tenant/product, an existing schema-v3 `knowledge-store.json` is
validated and imported in one transaction. The transaction writes a durable
tenant/product migration marker only after every record and history entry succeeds.
Subsequent opens do not re-import the snapshot. The legacy file is never deleted or
rewritten, so it remains available for rollback inspection.

Raw evidence remains the immutable source of truth. Relational canonical knowledge is a
rebuildable projection retaining provenance back to raw source IDs and versions.

`pendingServingProjectionCount`, `drainServingProjections`, and
`refreshServingProjections` expose bounded outbox processing. A versioned full rebuild is
performed with `rebuildServingProjections({ batchSize, cursor })`; each call processes at
most 500 canonical entities and returns the next cursor and `done` flag. Starting again
at cursor `0` is safe. The Application service drains pending work when a product store
is opened, after ordinary ingestion, and before a knowledge search. A drain failure is
surfaced while its durable outbox work remains pending for restart retry.

## Production Configuration

SQLite is the implemented local/default backend and is suitable for a single-node
deployment. PostgreSQL is the production scale-out target for multi-node/high-write
deployments; pgvector is the documented future option for genuine semantic or hybrid
retrieval after an embedding model, lifecycle, and evaluation policy are approved. No
PostgreSQL adapter, pgvector integration, vector database, or synthetic embedding is
implemented here. The exported
`RelationalKnowledgeStore`/`KnowledgeStore` interfaces preserve that adapter boundary;
do not describe the SQLite implementation as PostgreSQL.

The repository ignores local database files and environment files. Runtime
configuration must place the data directory on durable storage outside committed source
artifacts and must not include credential values in the path.
