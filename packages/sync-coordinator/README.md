# @tkl/sync-coordinator

Owner: Jorge (Source Ingestion). Backlog item: `OPS-101`.

Scheduled incremental sync, durable checkpoint recovery, replay procedures, and
non-destructive retention reporting for one tenant/product scope.

This package is the **orchestration boundary**, not a connector. It owns *when* an
already-composed connector runs, *how* its evidence and cursor reach durable storage,
and *what* an operator is told afterwards. It contains no source knowledge at all: no
HTTP client, no pagination rule, no allowlist, no record construction.

```text
config/products/<product>.json        config/operations/sync.json
        |                                     |
        v                                     v
  @tkl/ingestion  --->  @tkl/sync-coordinator  --->  @tkl/raw-evidence-store
 (composeConnectors,        (this package)             (durable, encrypted,
  ING-104 + ING-101..103)                               atomic commit, ING-105)
                                   |
                                   v
                     @tkl/observability (audit + health)
```

## Guarantees

| Guarantee | How |
| --- | --- |
| Resume after restart | A connector's start position is read back from the durable store (`getCheckpoint`), never from process memory. |
| Atomic progress | Records and the next checkpoint are handed to the store in **one** `commit()`, so a cursor can never move past unpersisted evidence. |
| Never skip on failure | When collection fails mid-stream, already-fetched evidence is still committed, but **without** advancing the checkpoint. |
| Never rewind silently | `commit({ checkpoint: null })` is never issued, and replay modes preserve the stored cursor by default. |
| No overlapping runs (in-process) | A process-wide lock per `tenant/product/connector`. |
| No hidden daemon | One `runOnce()` per external trigger; no timer, no sleep, no supervision loop. |
| Sanitized output | Every summary/report/audit event is redacted and then asserted to contain no credential reference, URL, or filesystem path. |

## Usage

```js
import { createSyncCoordinator } from "@tkl/sync-coordinator";
import { createPersistentRawEvidenceStore } from "@tkl/raw-evidence-store";

const store = await createPersistentRawEvidenceStore({
  tenantId: configuration.tenantId,
  productId: configuration.productId,
  dataDirectory: process.env.TKL_RAW_EVIDENCE_DIR,
  keyRef: process.env.TKL_RAW_EVIDENCE_KEY_REF,   // a reference, never a key
  resolveKey: (reference) => secrets.resolve(reference),
});

const coordinator = createSyncCoordinator({
  configuration,                                   // validated product configuration
  store,
  sync: operationsSettings["fl-titling"],          // config/operations/sync.json
  dependencies: { "connector.github": { resolveCredential } },
  auditLogger,
  healthRegistry,
});

const summary = await coordinator.runOnce();       // one scheduled tick
```

Connectors are composed by `@tkl/ingestion` from `enabledPlugins`. Pre-built
connectors can be injected instead (`connectors: [{ pluginId, instance }]`), which is
what the tests do. Enabling or disabling a connector is a configuration change only.

A connector instance needs exactly three things: `collect(checkpoint)` (async
iterable of raw evidence records), an observable cursor (`currentCheckpoint()` or
`metrics.lastCheckpoint`, which ING-101..103 already maintain), and optionally
`health()`.

## Modes

| Mode | Start position | Checkpoint default | Confirmation |
| --- | --- | --- | --- |
| `incremental` | Durable checkpoint | `advance` | not required |
| `replay-from-checkpoint` | Durable checkpoint, or an explicit `startCheckpoint` | `preserve` | `confirmReplay: true`, one connector, finite record cap |
| `replay-full` | The source's beginning (page zero) | `preserve` | `confirmReplay: true`, one connector, finite record cap |

- Replays are never implicit: an unconfirmed replay throws
  `ReplayConfirmationRequiredError` before any source is contacted.
- Executing a replay requires exactly one connector and a finite
  `maxRecordsPerConnector`. Dry-run plans remain side-effect-free and do not require
  confirmation or execution caps.
- `startCheckpoint` is accepted **only** for `replay-from-checkpoint`; an incremental
  run always resumes from what was durably committed.
- `checkpointPolicy: "advance"` during a replay is allowed but must be asked for
  explicitly.
- `runOnce({ dryRun: true })` and `plan()` contact no source, commit nothing, and take
  no lock. They report what *would* happen, including `wouldClearCheckpoint: false`.
- `maxRecordsPerConnector` is a **safety cap, not a progress mechanism**. When it stops a
  connector early the connector result is `status: "truncated"` and the run is reported
  as `partial` (CLI exit code `1`), because whether the next run gets further depends on
  that connector resuming from a mid-stream cursor. The production Jira and GitHub
  connectors deliberately do **not**: they replay from page zero so a reordered source
  can never permanently skip evidence, which means repeated truncated ticks would
  re-read the same prefix forever. Use `maxDurationMs` and/or a job-runner timeout for
  bounded ticks, and treat a truncated run as something to investigate.
- `maxDurationMs` is an optional per-connector elapsed-time cap. The coordinator passes
  an `AbortSignal` to `collect(checkpoint, { signal })`, so production connector retries
  and HTTP fetch/body reads are cancelled even when collection is blocked before its
  first record. Existing connectors that only implement `collect(checkpoint)` remain
  compatible when no duration cap is configured. A deadline cancellation is reported as
  `truncated` with `truncationReason: "max-duration"` and the run is `partial`; the
  connector finishes unwinding before its run lock is released.

Run and connector summaries include `durationMs`, `throughputRecordsPerSecond`, and
`duplicateRate`. `ingestionLagSeconds` is reported only when the durable connector
checkpoint contains a valid `sourceWatermark`; invalid or missing timestamps produce
`null`, never a guessed lag.

Replay is safe because every record carries a deterministic idempotency key: the store
recognizes an identical record as a duplicate (`duplicateCount`) and stores it once.

## Scheduling semantics

**There is no embedded scheduler.** A scheduled sync is exactly one `runOnce()` per
external trigger (cron, Kubernetes CronJob, CI schedule, cloud scheduled job, or an
operator running the CLI). Retries, backoff, missed-tick policy, and supervision belong
to the deployment platform, which already implements them.

The cadence itself is a **pending external decision** (see the "External Decisions
Register" row *Deployment target, schedule, retention, and audit destination* in
`docs/team/TKL-Delivery-Backlog.md`). `config/operations/sync.json` therefore ships
`configurationStatus: "pending-external-input"` with no cron expression, and
`assertScheduleApproved()` fails closed for any caller that needs an approved cadence.
Manual and CI-triggered runs are unaffected.

## Overlapping runs: what is and is not guaranteed

- **Within one process** (including two coordinator instances), a second run for the
  same tenant/product/connector never starts. `overlapPolicy: "skip"` (default) reports
  a skipped connector with `reason: "run-already-in-progress"`; `"fail"` raises
  `SyncRunConflictError`.
- **Across processes, nothing is guaranteed by this package.**
  `@tkl/raw-evidence-store` has no cross-process lock or database transaction — its
  durable store serializes commits per *instance* only — so two ingestion processes
  writing the same scope directory can still race the atomic rename. **Run one
  ingestion process per tenant/product scope.**
- For deployments that can provide real mutual exclusion, inject an `externalLock`:

  ```js
  createSyncCoordinator({
    externalLock: {
      async acquire({ tenantId, productId, connectorId, runId }) {
        // return null when the lease is held elsewhere, otherwise { release() }
      },
    },
  });
  ```

  A denied lease is reported as `reason: "external-lock-unavailable"`. No lock file is
  emulated here, because an advisory lock file on a network filesystem would imply a
  guarantee this package cannot make.

## Retention: reporting, not pruning

`coordinator.planRetention()` returns a sanitized report of what a retention horizon
*would* cover. It never deletes, and `deletedCount` is `0` by construction.

Deletion is deliberately not implemented:

1. `@tkl/raw-evidence-store` exposes **no deletion API**, and its durable state is a
   single authenticated envelope per scope. Removing records would require an
   out-of-band rewrite that its crash-recovery and one-writer design forbids.
2. Raw evidence **is** the provenance for canonical knowledge (source version,
   timestamps, content hashes, trace links). Pruning a record that a published claim
   cites would silently break traceability.
3. Commit history is the append-only audit trail a restart/replay investigation reads.

`retention.mode` must be `"report-only"`; any other value fails closed. The report is
the input for an approved archival decision (cold storage, scope-directory rotation, or
a longer horizon), not a substitute for one. The horizon itself is the same pending
external decision as the schedule; it ships as `null` ("no bound configured") rather
than an invented number.

## CLI

```bash
npm run sync:run -- --help
npm run sync:run -- --print-schedule
npm run sync:run -- --dry-run
npm run sync:run -- --retention-report
npm run sync:run -- --mode replay-full --confirm-replay \
  --connector connector.github --max-records 10000 --max-duration-ms 300000
```

Credentials are never arguments: both the source credential and the evidence encryption
key are `secret://`/`env://` references resolved at runtime through `@tkl/ops`'s
environment-backed resolver, which fails closed when the variable is missing. The run
summary is printed to stdout as a single JSON document and audit events go to stderr, so
stdout stays machine-parseable; `TKL_AUDIT_DESTINATION=none` disables audit output. Only
sanitized JSON is printed; a raw connector or filesystem error is reduced to an error
name. Exit code `0` means completed, planned, or skipped because a run was already in
progress; `1` means at least one connector failed or stopped before finishing its source,
or the invocation was rejected.

See [`docs/runbooks/scheduled-sync.md`](../../docs/runbooks/scheduled-sync.md) for the
operational procedures (scheduling, restart recovery, replay, retention review).

## Notes

- `@tkl/observability` and `@tkl/ops` publish no package entry point, so they are
  imported by relative source path, matching `apps/api` and `apps/mcp-gateway`.
- Node >= 22.18.0 (inherited from `@tkl/raw-evidence-store`, whose entry point is
  TypeScript source). Below that floor, run with `--experimental-strip-types`, which
  every script in this package and `npm run sync:run` already do.

## Tests

```bash
npm test --workspace @tkl/sync-coordinator
```

Deterministic and offline: fixtures, injected clocks, injected clients, and explicit
promise gates. No sleeps, no timers, no live services. Coverage includes restart
recovery against the real durable encrypted store, replay (full, from-checkpoint,
unconfirmed, dry-run), duplicates, partial failure, concurrent runs, bounded runs,
checkpoint validation, retention reporting, sanitization, and the CLI.
