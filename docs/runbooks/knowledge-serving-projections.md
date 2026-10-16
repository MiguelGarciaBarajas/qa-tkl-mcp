# Knowledge Serving Projection Operations

## Purpose

The SQLite canonical store is the Silver source for a rebuildable Gold entity-search
projection. Canonical writes and `serving_projection_outbox` enqueueing are atomic.
Projection updates and outbox acknowledgement are also atomic, so pending work survives
process termination and is safe to retry.

The Application service drains pending work when a product store opens, after ingestion,
and before search. A failure is returned to the caller and leaves durable work pending.

## Health check

Use the product-scoped store method:

```js
store.pendingServingProjectionCount()
```

A nonzero value means canonical data is durable but Gold is behind. Repeatedly increasing
counts or `last_error` values in `serving_projection_outbox` require investigation.
Error text is bounded and must not contain credentials.

## Bounded retry

Drain at most 100 records per transaction:

```js
const result = store.drainServingProjections({ limit: 100 });
// { attempted, projected, remaining, version }
```

`refreshServingProjections` is an equivalent bounded operation. The accepted range is
1-500. Retry while `remaining` is nonzero. Do not delete outbox rows manually: doing so
can make canonical entities permanently absent from search.

## Full rebuild

Stop or quiesce ingestion for the simplest operational procedure, then iterate from
cursor zero:

```js
let cursor = 0;
while (true) {
  const batch = store.rebuildServingProjections({
    batchSize: 100,
    cursor,
  });
  if (batch.done) break;
  cursor = batch.nextCursor;
}
```

Each call is one bounded transaction and uses serving projection version `1`. It reads
current canonical rows, refreshes the entity document, and acknowledges redundant
outbox work for those entities. Interruption is safe: retain the last returned cursor,
or restart from zero. A completed pass removes stale/wrong-version Gold rows that have no
current canonical counterpart.

## Search behavior

- Results are tenant/product scoped and source-filtered before pagination.
- Legacy entity-ID/title matches are first in canonical insertion sequence, followed by
  supplemental canonical-text matches in canonical insertion sequence; FTS rank is not
  exposed.
- Empty queries return a deterministic page without issuing an FTS query.
- Searchable text includes entity title/ID/type, scalar metadata, non-rejected claims,
  entity source references, and trace-link identifiers.
- SQLite builds with FTS5 and the trigram tokenizer use `MATCH`; other builds use the
  same materialized document with deterministic substring matching.

## Recovery

1. Preserve `knowledge-store.sqlite` and its WAL files.
2. Correct the storage, disk-space, SQLite-extension, or malformed-data cause.
3. Reopen the Application service; product-store initialization retries pending work.
4. If work remains, run bounded drains and observe `remaining`.
5. If projection consistency is uncertain, run the full rebuild above.

Raw evidence and canonical Silver tables remain authoritative. Do not edit the FTS table
directly. PostgreSQL/pgvector is a future production scale-out option only; no embeddings
or vector store are part of this implementation.
