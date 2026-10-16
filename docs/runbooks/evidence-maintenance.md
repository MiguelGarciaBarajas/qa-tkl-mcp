# Evidence Maintenance Runbook (P4)

Owner: Source Ingestion / Knowledge & Traceability. Modules:
`packages/raw-evidence-store` (`@tkl/raw-evidence-store`),
`packages/sync-coordinator` (`@tkl/sync-coordinator`), and the
`apps/api` source-sync runner.

This runbook covers the production-safe maintenance operations for the
Bronze/Silver/Gold TKL architecture:

1. **Raw evidence retention/compaction** (Bronze) — bound the growth of the
   append-only encrypted transaction chunks without losing evidence,
   idempotency behavior, pending projection work, dead-letter (DLQ) state,
   checkpoints, audit/replay history, or provenance.
2. **Reconciliation** — compare Bronze/Silver/Gold and produce actionable,
   non-mutating findings.
3. **Controlled rebuilds** — rebuild Silver (canonical) from durable raw
   evidence and Gold (serving projections) from canonical knowledge, always
   bounded and resumable.

> **Safety first.** These operations are designed to be run against a
> maintenance/staging copy or a specific bounded scope. Do **not** point them
> at a large production evidence directory (for example the ~2.84 GB /
> ~2,680-file corpus) without first understanding the limits below. None of
> these commands contact a source or trigger a TestRail/ReportPortal sync.

## Safety model

| Guarantee | How it is enforced |
| --- | --- |
| Non-destructive by default | Compaction rewrites equivalent encrypted state as bounded segment files and only removes old chunks (and any superseded prior generation or legacy base) **after** the new generation's manifest is durably published. No evidence, DLQ entry, checkpoint, history entry, or provenance is dropped. |
| Bounded work | Compaction refuses to run when more than `--max-chunk-files` (default 1000) chunk files exist, and writes bounded segment files capped by `maxRecordsPerSegment`/`maxSegmentBytes` so no single serialize approaches Node's `MAX_STRING_LENGTH`. Rebuilds never process the full matched set without an explicit `--limit` or `--confirm`, and load/project only bounded pages. Reconciliation's evidence scan is bounded by finite `maxRecords`/`maxPages`/`deadline` and reports a resumable cursor when truncated. |
| Crash/restart idempotence | Each compacted generation is a directory of encrypted segment files published by a small manifest written temp→fsync→atomic-rename (the durability point). A crash before the manifest is renamed leaves an unpublished generation that startup ignores and cleans; a crash before old-chunk cleanup leaves stale chunks that the next startup ignores and re-deletes — never double-applied. |
| Lock exclusion | Compaction serializes with sync commits, acks, failures, and requeues on the same store instance. Silver rebuild takes the in-process maintenance run lock and refuses to overlap a sync run. Cross-process exclusion still requires one writer process per scope (see the [scheduled sync runbook](scheduled-sync.md)). |
| Confirmation for mutation | Reconciliation repairs and an unbounded rebuild require `--confirm`. |
| Sanitized output | Every result is counts, enum strings, ISO timestamps, and hex digests only — never a payload, source ID, URL, credential reference, or filesystem path. Results go to stdout as one JSON document; audit events go to stderr. |

## Command surface

The operator CLI is `packages/sync-coordinator/bin/run-maintenance.js`, run via:

```bash
npm run maintenance:run -- <command> [options]
```

It requires a raw evidence data directory and encryption key **reference**
(never the key itself), exactly like `sync:run`:

```bash
export TKL_RAW_EVIDENCE_DIR=/srv/tkl/raw-evidence
export TKL_RAW_EVIDENCE_KEY_REF=secret://raw-evidence/fl-titling
# ...or pass --data-directory and --key-ref explicitly.
```

Commands:

| Command | Tier | Mutates? | Purpose |
| --- | --- | --- | --- |
| `status` | Bronze | no | Print the compaction/maintenance posture. |
| `compact` | Bronze | rewrites | Fold transaction chunks into a compacted encrypted base. |
| `reconcile` | all | no | Structured cross-tier findings. |
| `repair` | Bronze | yes (gated) | Requeue dead-letter projection records. |
| `rebuild-gold` | Gold | yes (idempotent) | Rebuild serving projections from canonical knowledge. |

Silver rebuild is exposed as a **service** rather than in this raw-only CLI,
because it needs the normalization pipeline: use the `apps/api` source-sync
runner method `runner.rebuildSilver(...)` or the coordinator method
`coordinator.rebuildSilver({ projectRecords, ... })`.

### `status`

```bash
npm run maintenance:run -- status
```

Example output:

```json
{
  "reportType": "evidence.maintenance.status",
  "tenantId": "solera",
  "productId": "fl-titling",
  "generation": 2,
  "lastCompactedAt": "2026-09-14T18:00:00.000Z",
  "compactedThroughSequence": 512,
  "nextTransactionSequence": 540,
  "chunkFileCount": 27,
  "recordCount": 512,
  "pendingProjectionCount": 0,
  "deadLetterCount": 0,
  "historyEntryCount": 512
}
```

`generation` is the number of successful compactions. `compactedThroughSequence`
is the highest transaction folded into the current base; live chunk files hold
everything committed after it.

### `compact`

```bash
# Plan only — write nothing, delete nothing.
npm run maintenance:run -- compact --dry-run

# Compact, but only when there are at least 50 chunk files and no more than 500.
npm run maintenance:run -- compact --min-chunk-files 50 --max-chunk-files 500
```

Result `status` values:

| `status` | Meaning | Exit code |
| --- | --- | --- |
| `compacted` | A new compacted generation (segment files + manifest) was published and folded chunks removed. | 0 |
| `planned` | `--dry-run`: reports what would be folded. | 0 |
| `skipped` (`reason: below-threshold`) | Fewer than `--min-chunk-files` chunks; nothing to do. | 0 |
| `aborted` (`reason: exceeds-max-chunk-files`) | More chunks than `--max-chunk-files`; refused to avoid an unbounded rewrite. Raise the cap explicitly to proceed. | 1 |

To compact a very large generation on purpose, raise the cap deliberately, and
prefer a maintenance window:

```bash
npm run maintenance:run -- compact --max-chunk-files 3000
```

### `reconcile`

```bash
# Raw-only findings.
npm run maintenance:run -- reconcile

# Cross-tier findings (adds Silver/Gold counts from the knowledge store).
npm run maintenance:run -- reconcile --knowledge-directory /srv/tkl/knowledge

# Scope by source / version / observed range.
npm run maintenance:run -- reconcile --source github \
  --observed-from 2026-01-01T00:00:00.000Z --observed-to 2026-06-30T23:59:59.999Z
```

Findings each carry a `code`, `severity` (`info`/`warning`/`error`), `tier`,
counts, and a `remediation` hint. `bronze.evidenceChecksum` is a stable SHA-256
over the matched records' `(source, sourceId, sourceVersion, contentHash)` — the
meaningful "checksum" for detecting drift or corruption between reconciliations.
`highestSeverity: error` yields exit code 1.

Finding codes:

| Code | Severity | Remediation |
| --- | --- | --- |
| `raw.pending-projection-backlog` | warning | Drain projections (run a sync tick, which drains pending, or a Silver rebuild). |
| `raw.projection-dead-letter` | error | `repair --requeue-dead-letter` after fixing the projection cause. |
| `raw.history-record-count-mismatch` | error | Investigate durability; do not delete anything. |
| `silver.deferred-trace-links` | warning | Await late evidence or rebuild Silver. |
| `gold.serving-projection-backlog` | warning | `rebuild-gold` (or drain serving projections). |
| `silver.canonical-exceeds-raw` | error | Investigate provenance; canonical must not exceed retained raw evidence. |

### `repair`

Mutating; fails closed without `--confirm`:

```bash
npm run maintenance:run -- repair --requeue-dead-letter --confirm --limit 100
```

Moves up to `--limit` dead-letter projection records back to pending so a later
sync tick or Silver rebuild reprocesses them. Idempotent and bounded.

### `rebuild-gold`

```bash
npm run maintenance:run -- rebuild-gold --knowledge-directory /srv/tkl/knowledge --dry-run
npm run maintenance:run -- rebuild-gold --knowledge-directory /srv/tkl/knowledge \
  --batch-size 200 --max-batches 100
```

Drives the knowledge store's own bounded `rebuildServingProjections(cursor/batch)`
primitive to completion within `--max-batches`. If it stops with `done: false`,
re-run with `--cursor <nextCursor>` to resume.

### Silver rebuild (service)

Silver rebuild replays durable raw evidence back through the idempotent
knowledge ingest pipeline (content-addressed upsert), so it reconciles canonical
knowledge to the evidence without dropping provenance or creating duplicates. It
never processes the full matched set implicitly.

```js
// apps/api source-sync runner
const first = await runner.rebuildSilver({
  productId: "fl-titling",
  source: "github",          // optional filter
  limit: 500,                // bound this run (or pass confirm: true)
});
// Resume:
await runner.rebuildSilver({ productId: "fl-titling", cursor: first.nextCursor, limit: 500 });
```

`dryRun: true` returns a plan (`matched`, `wouldProcess`, `nextCursor`) without
ingesting. Progress fields: `processed`, `nextCursor`, `remaining`, `done`.

## Recovery procedures

- **Compaction interrupted by a crash.** Just restart the process/store. On
  `initialize()` the store discards any un-renamed manifest temp, ignores and
  cleans any unpublished (manifest-less) generation directory, applies the live
  published generation (segment files named by its manifest) if one exists,
  ignores transaction chunks at or below the compaction baseline, and re-deletes
  any stale folded chunks. A pre-existing legacy monolithic compacted base is
  still loaded when no segmented manifest is present. No action is required and
  no evidence is lost. Confirm with `status`.
- **`compact` returned `aborted`.** Expected safety behavior for a large
  generation. Re-run with a higher `--max-chunk-files` during a maintenance
  window, or leave the chunks — they are read normally on every startup.
- **Reconciliation shows a dead-letter backlog.** Fix the projection failure
  cause first, then `repair --requeue-dead-letter --confirm`, then re-run a sync
  tick or Silver rebuild to project them.
- **Gold backlog after a schema/projection change.** `rebuild-gold`; resume from
  `nextCursor` until `done: true`.
- **Silver looks behind raw evidence.** Run a bounded Silver rebuild by source
  and range; because ingest upserts, replaying is safe and idempotent.

## Concurrency limits

The in-process locks guarantee no overlap **within one process**. Across
processes, the store has no cross-process lock (same limitation as scheduled
sync). Run one maintenance process per tenant/product scope and do not run
maintenance concurrently with a sync run against the same scope.
