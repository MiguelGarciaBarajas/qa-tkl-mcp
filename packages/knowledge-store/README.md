# @tkl/knowledge-store

Owner: Josue Misael Torres (Knowledge and Traceability).

Canonical knowledge entities, claims, trace links, provenance metadata, and conflict
records for the TKL platform, plus an in-memory `KnowledgeStore` reference
implementation for early integration by other workstreams.

The Application API uses `SqliteKnowledgeStore` by default. It stores tenant/product
scoped canonical projections in normalized SQLite tables with WAL, transactional
idempotent upserts, indexed provenance, durable review/history records, and a rebuildable
Gold serving projection. Canonical entity, claim, provenance, and trace-link mutations
enqueue one idempotent `serving_projection_outbox` item in the same transaction.
`drainServingProjections()` updates the materialized search document and acknowledges the
outbox item in another single transaction, so restart recovery is at least once without
permanent missing search data.

The serving projection uses SQLite FTS5 with the trigram tokenizer when the runtime
provides it. Runtime builds without FTS5 retain the same deterministic, product-scoped
search behavior through the materialized projection; empty searches never issue an FTS
query. Existing schema-v3 `knowledge-store.json` snapshots are imported once
transactionally and are left untouched. `PersistentKnowledgeStore` remains available
for legacy compatibility.

Raw evidence remains the source of truth and normalized SQLite tables are the canonical
Silver layer. SQLite is the local/default backend; PostgreSQL plus pgvector is the
intended future production search scale-out for multi-node or semantic/hybrid retrieval.
No vector database, generated embeddings, PostgreSQL adapter, or pgvector integration is
implemented in this phase.

Operational methods are bounded and safe to repeat:

- `pendingServingProjectionCount()`
- `drainServingProjections({ limit })` / `refreshServingProjections({ limit })`
- `rebuildServingProjections({ batchSize, cursor })`

Drain and rebuild batches are limited to 500 entities. A full rebuild starts with cursor
`0` and calls the rebuild method until `done` is true, passing each returned
`nextCursor`.

Claims can be approved or rejected through durable review operations. Open conflicts
must be reviewed as a unit by selecting the accepted claim or claims; the remaining
claims are rejected and the immutable review decision is retained for audit.

## Status

The package uses the canonical entities, claims, trace links, provenance, and conflict
contracts published by `@tkl/contracts`. The former local contract mirror has been
removed so package consumers share one versioned model.

## Run tests

```powershell
npm run test --workspace=@tkl/knowledge-store
```
