# Scheduled Sync Runbook (OPS-101)

Owner: Jorge (Source Ingestion). Module: `packages/sync-coordinator` (`@tkl/sync-coordinator`).

This runbook covers running, recovering, replaying, and reviewing retention for the
scheduled incremental sync that feeds the durable raw-evidence store. It does **not**
cover source-specific behavior; see the
[Jira](jira-connector.md), [GitHub](github-connector.md), and
[TestRail](testrail-connector.md) runbooks for those.

## Scheduling model

One external trigger = one process = one `runOnce()` = one exit code. The coordinator
starts no timer, runs no daemon, and leaves nothing running.

```bash
npm run sync:run                      # one incremental tick for fl-titling
npm run sync:run -- --product <id>    # another product scope
npm run sync:run -- --print-schedule  # what cadence is configured, and its status
```

Cron/job-runner requirements:

| Requirement | Reason |
| --- | --- |
| One job instance per tenant/product scope | The durable store supports one *writer process* per scope (see "Concurrency limits"). |
| The runner's own "no concurrent runs" / concurrency-policy `Forbid` setting must be enabled | Defence in depth: the coordinator's lock is in-process only. |
| Bound a tick with the runner's job timeout and optionally `--max-duration-ms` | `--max-records` and `--max-duration-ms` are safety caps: a truncated run is reported as `partial` (exit `1`) because a later run may replay from page one rather than continue from the exact stopped record. The duration cap cooperatively aborts production connector retries and in-flight HTTP work before releasing the run lock. |
| Treat exit code `1` as a failed job | `0` = completed, planned, or skipped because a run was already in progress. |
| Read the run summary from stdout; audit events are on stderr | stdout is a single JSON document so it can be piped into a parser. |

### Cadence is a pending external decision

`config/operations/sync.json` ships with:

```json
{ "schedule": { "cadence": "external-cron", "configurationStatus": "pending-external-input", "timezone": "UTC" } }
```

No cron expression is invented in this repository. When the platform/project owner
approves one (see the "External Decisions Register" row *Deployment target, schedule,
retention, and audit destination* in `docs/team/TKL-Delivery-Backlog.md`):

1. Set `schedule.cron` (five standard fields, validated) and
   `schedule.configurationStatus` to `"ready"`.
2. Re-run `npm run sync:run -- --print-schedule` and confirm the descriptor.
3. Configure the external runner with exactly that expression and timezone.

A `"ready"` status without a trigger definition (or a trigger that contradicts the
cadence) fails closed at startup rather than advertising a schedule that does not exist.

## Required configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Enabled connectors | `config/products/<product>.json` (`enabledPlugins`) | Composition is config-driven; no code change to enable/disable a source. |
| Credential references | `config/products/<product>.json` (`credentialRefs`) | References only (`secret://...`), resolved at runtime. |
| Incremental lookback | `sources.<source>.incrementalLookbackSeconds` | Optional integer from `0` through `31536000`. Omit it to preserve the historical full-scan behavior. |
| Batch size, overlap policy, schedule, retention | `config/operations/sync.json` | Validated, unknown keys rejected. |
| `TKL_RAW_EVIDENCE_DIR` | Environment | Data directory for the durable encrypted store. |
| `TKL_RAW_EVIDENCE_KEY_REF` | Environment | A *reference* (`secret://...` / `env://...`) to AES-256 key material, never the key. |
| `TKL_SECRET__*` / referenced variables | Approved secret manager | Resolved by `@tkl/ops`; a missing variable fails the run closed. |
| `TKL_AUDIT_DESTINATION` | Environment | For the sync CLI, audit events always go to stderr (stdout is reserved for the summary); set `none` only in tests. Long-running services use this variable for their own destination. |

The coordinator refuses to run without a durable data directory and key reference: there
is no in-memory or unencrypted fallback.

When incremental lookback is configured, connectors derive the cutoff from the last
completed `sourceWatermark`. Jira, TestRail, Confluence, and ReportPortal continue
scanning their verified pagination locally because their upstream ordering/cutoff
semantics are not trusted. GitHub restarts at page one and may stop only after a whole
updated-desc page is older than the cutoff. Missing or invalid source timestamps are
always emitted and never advance the watermark. A candidate watermark is persisted
during an incomplete scan and promoted only after the full connector scan completes.

## Health signals

Per run (`sync.run.completed`) and per connector (`sync.connector.completed`):

- Run `status`: `succeeded` / `partial` / `failed` / `skipped` / `planned`.
- Connector `status`: `succeeded` / `truncated` / `failed` / `skipped`.
- `totals`: `recordCount`, `committedCount`, `duplicateCount`, `batches`, and counts of
  `succeeded` / `failed` / `skipped` / `truncated` connectors, plus `durationMs`,
  `throughputRecordsPerSecond`, `duplicateRate`, and `ingestionLagSeconds` when a
  valid source watermark exists.
- Per connector: `resumedFromCheckpoint`, `checkpointAdvanced`, `truncated`,
  `durationMs`, `throughputRecordsPerSecond`, `duplicateRate`,
  `ingestionLagSeconds`, `durabilityWarnings`, optional sanitized `warnings`, and a sanitized `error`
  (`stage`, `name`, `code`, `status`).
- Connector `health()` snapshots are forwarded to the shared health registry, where
  credential references are redacted.

Every emitted object is redacted and then verified to contain no credential reference,
URL, or filesystem path. A raw connector or store error message is never emitted — only
its error name and machine code.

Alert on: `status: "failed"` or `"partial"`; a rising `duplicateCount` with a flat
`committedCount` across ticks (a cursor that is not advancing); any connector reporting
`status: "truncated"`; any `durabilityWarnings`.

## Common failures

| Symptom | Likely cause | Safe action |
| --- | --- | --- |
| `status: "skipped"`, `reason: "run-already-in-progress"` | The previous tick is still running | None. Consider a longer cadence. |
| `status: "skipped"`, `reason: "external-lock-unavailable"` | Another process holds the lease | None. Confirm only one scope owner is scheduled. |
| Connector `status: "truncated"` (run `partial`) | `--max-records`, `maxRecordsPerConnector`, or `--max-duration-ms` stopped the run before the source was exhausted | Remove or raise the cap. Do not assume the next tick continues at the exact stopped record. |
| `warnings: ["external-lock-release-failed"]` | An injected cross-process lease could not be released | The run itself completed and the in-process lock was freed. Check the lease provider; a stale lease may block the next tick. |
| `error.stage: "start"` | The stored checkpoint could not be read (uninitialized, unreadable, or wrong-key store) | Nothing was collected and the scope lock was released. Verify the data directory and key reference. |
| `error.stage: "collect"` | The source failed (see that connector's runbook) | Evidence already fetched is committed; the cursor did not advance. Re-run after the source recovers. |
| `error.stage: "commit"` | The durable store rejected the batch (conflict, scope mismatch, write failure) | The batch was rolled back completely. Check the store's data directory health and key reference before re-running. |
| `error.stage: "checkpoint"` | A connector proposed a non-persistable cursor | A connector defect. The batch failed closed and no cursor was written; report it against that connector. |
| `SyncConfigurationError` at startup | Settings, connector IDs, or store scope mismatch | Fix configuration; nothing was run. |
| `ReplayConfirmationRequiredError` | A replay mode without `--confirm-replay` | Intentional. Confirm explicitly if the replay is wanted. |
| `durabilityWarnings > 0` | A post-commit directory fsync could not be confirmed | The commit **is** durable (see `packages/raw-evidence-store/README.md`). Investigate storage health. |

## Restart and recovery procedure

The cursor lives in the durable encrypted store, not in the process, so recovery is
"start the job again". Concretely:

1. Confirm no other process is writing the scope (one writer per scope).
2. Inspect the intended work without side effects:
   ```bash
   npm run sync:run -- --dry-run
   ```
   Check `storedCheckpointPresent`, `wouldResumeFromStoredCheckpoint`, and
   `wouldClearCheckpoint: false`.
3. Run the normal incremental tick:
   ```bash
   npm run sync:run
   ```
4. Verify `resumedFromCheckpoint: true` and that `committedCount` covers only genuinely
   new evidence (replayed records appear as `duplicateCount`).

A failed run never advances the cursor past the failure, so re-running can duplicate
reads but can never skip evidence. Duplicate reads are deduplicated by idempotency key.

## Replay procedure

Replays re-read a source from an earlier position. They are never implicit and never
reset a cursor.

1. **Plan first.** `--dry-run` contacts no source and commits nothing:
   ```bash
   npm run sync:run -- --mode replay-full --dry-run
   ```
2. **Choose the narrowest mode.**
   - `--mode replay-from-checkpoint` — re-read from the stored cursor (or an explicit
     start checkpoint through the library API).
   - `--mode replay-full` — re-read from the source's beginning.
3. **Confirm explicitly.**
   ```bash
   npm run sync:run -- --mode replay-full --confirm-replay \
     --connector connector.github --max-records 10000 --max-duration-ms 300000
   ```
4. **Expect duplicates, not growth.** A replay of unchanged data reports
   `duplicateCount` equal to the records re-read and `committedCount: 0`; the stored
   record count must not change.
5. **The cursor is preserved by default.** Replay uses `checkpointPolicy: "preserve"`;
   advancing during a replay is opt-in (library option `checkpointPolicy: "advance"`).
   No mode ever clears a checkpoint.
6. **Scope and bound it.** Every executing replay requires exactly one
   `--connector <id>` and a finite `--max-records <n>`. `--max-duration-ms <n>` is
   optional and reports a partial/truncated run if reached.

Restoring a *deliberately earlier* cursor is not offered as a one-flag operation on
purpose: use `replay-from-checkpoint` with an explicit `startCheckpoint` through the
library API, which validates the value and records the decision in the run summary.

## Retention review procedure

```bash
npm run sync:run -- --retention-report
```

The report is **non-destructive**: `pruneSupported: false`, `deletedCount: 0`, and the
store is never mutated. It reports, per connector, the record and history counts, the
oldest/newest observation timestamps, and how much falls beyond the configured horizon.

Nothing is deleted because raw evidence is immutable provenance for canonical knowledge
and the durable store exposes no deletion API (`packages/raw-evidence-store`). Use the
report as input to an approved archival decision — cold storage, scope-directory
rotation under a new key, or a longer horizon — executed as a reviewed operation
outside this job. `retention.mode` must remain `"report-only"`; any other value fails
closed.

The retention horizon itself (`rawEvidenceMaxAgeDays`, `historyMaxEntries`) is the same
pending external decision as the schedule and ships as `null`.

## Concurrency limits (stated exactly)

- **In one process:** overlapping runs for the same tenant/product/connector are
  prevented. Guaranteed and tested.
- **Across processes:** *not* guaranteed by this repository. The durable store has no
  cross-process lock or database transaction; two ingestion processes against the same
  scope directory can race the atomic rename. **Run exactly one ingestion process per
  tenant/product scope.**
- If the deployment can provide a real lease (database row lock, blob lease, job-runner
  concurrency policy), inject it through the `externalLock` seam documented in
  `packages/sync-coordinator/README.md`. A denied lease is reported as a skip.

## Safe rollback

1. Disable the external schedule (the coordinator has no internal one to stop).
2. Let any in-flight run finish; each committed batch is already atomic and durable, so
   there is no partial state to repair.
3. To disable a single source, remove its plugin ID from `enabledPlugins` — no code
   change and no effect on the other connectors.
4. Evidence and checkpoints are immutable and additive: rolling back the coordinator
   deployment never requires deleting evidence, and an older revision resumes from the
   same durable cursor.

## Verification

```bash
npm test --workspace @tkl/sync-coordinator   # includes the restart/replay operational test
npm run test:integration                     # tests/integration/ops-101-scheduled-sync.test.js
```

The restart/replay operational test discards all in-process state between phases and
rebuilds from the encrypted snapshot on disk, covering failure, recovery, no-op re-run,
unconfirmed replay, dry-run plan, confirmed idempotent replay, and post-replay restart.
