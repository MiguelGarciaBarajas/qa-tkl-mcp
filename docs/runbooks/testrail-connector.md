# TestRail Connector Runbook

## Configuration validation

Before enabling live sync, verify:

- `TESTRAIL_BASE_URL` resolves to the approved TestRail instance and uses HTTPS; plain
  HTTP is rejected unless `allowInsecureLoopback` is explicitly enabled for a loopback
  host in local development/tests. This applies both to the HTTP client and to the
  connector's own `baseUrl` (used to build evidence `sourceUrl` links); when the
  connector omits an explicit `baseUrl`, it falls back to the HTTP client's own
  already-validated `baseUrl` metadata rather than an unvalidated value.
- `TESTRAIL_PROJECT_ID` is the approved FL Titling project.
- `TESTRAIL_SUITE_IDS` contains only approved suites.
- `secret://testrail/fl-titling` resolves to a read-only credential.
- Required corporate network or VPN access is active.

Do not print the resolved credential during validation.

## Health signals

Monitor:

- Connector status: `healthy` or `degraded`.
- Records collected.
- Retry and failure counts.
- Last successful sync timestamp.
- Last valid checkpoint. A `{ phase: "complete" }` checkpoint (emitted after a full
  sync finishes) is itself resumable: it is accepted as a fresh full-sync state, not
  rejected as an invalid phase.
- Credential-reference readiness without its value.

## Sanitized structured logging

An optional `logger` (an object exposing `info(event)`) may be injected into the
constructor; it defaults to a no-op, so logging is opt-in and never required. When
configured, the connector emits `connector.sync.start`, `connector.retry`,
`connector.failure`, and `connector.sync.complete` events carrying only `pluginId`,
`tenantId`, `productId`, counts, status codes, and the last checkpoint -- never the
resolved credential value, suite/case/run/result payloads, or a raw error message. A
logger that throws is swallowed and can never turn a working sync into a failure.

## Pagination cursors

Cases, runs, and results resume from an opaque `_links.next` cursor. Real TestRail
deployments emit it in the vendor-relative form
`/api/v2/get_cases/128&limit=250&offset=250` (no `/index.php?` prefix and, for
`get_cases`, no `suite_id`). The client normalizes that to
`${baseUrl}/index.php?<cursor>` and rebuilds the request from trusted values: the
operation and every scope identifier (project/suite/run) are re-applied from the
connector's own configuration, only `offset`/`limit` are carried forward from the
cursor (validated integers, `limit` capped at the configured `pageSize`), and any
other parameter is dropped. A cursor that names a different project, suite, run, or
operation is rejected, not corrected — treat such a rejection as an integrity signal
(see below), never as a transient error to retry against.

## Common failures

| Symptom | Likely cause | Safe action |
|---|---|---|
| Configuration validation fails | Missing/invalid URL, project, suite scope, selected-suite allowlist, or credential reference | Correct non-secret configuration or secret reference |
| `"baseUrl must use HTTPS..."` | `TESTRAIL_BASE_URL` (connector or HTTP client) uses plain HTTP against a non-loopback host | Use HTTPS, or set `allowInsecureLoopback` only for a local loopback dev/test endpoint |
| `"Request URL must be HTTPS and same-origin..."` | A `_links.next` pagination cursor resolved to a different origin or scheme than the configured `baseUrl` | Treat as a potential integrity issue; do not retry against the cursor, restart the sync from the last valid checkpoint |
| `"Request URL does not match the expected TestRail API operation"` | A same-origin `_links.next` cursor resolved to a different project, suite, run, or an unrelated TestRail operation than requested | Treat as a potential integrity issue; do not retry against the cursor, restart the sync from the last valid checkpoint |
| `"Pagination cursor offset/limit must be a ... integer"` | A cursor carried a malformed or out-of-range `offset`/`limit` (tampered, truncated, or a non-TestRail cursor) | Restart the sync from the last valid checkpoint; do not hand-edit the cursor |
| `401` or `403` | Credential unavailable or insufficient read permission | Ask the TestRail/secret owner to verify access; do not request the secret value |
| `404` | Incorrect project/suite ID or inaccessible resource | Confirm approved IDs with the TestRail owner |
| `429` | Rate limit | Preserve checkpoint and allow bounded `Retry-After` handling |
| `5xx` or timeout | Temporary TestRail/network failure | Retry within bounds; keep last valid checkpoint |
| Unexpected records | Project-wide scope, selected-suite allowlist, or source mapping problem | Disable live sync and verify configuration before retrying |

## Recovery

1. Disable the TestRail source without disabling Jira/GitHub.
2. Preserve the last valid checkpoint and sanitized error metadata.
3. Correct configuration, permissions, mapping, or network access.
4. Run connector contract tests and a sanitized dry run.
5. Resume from the last valid checkpoint.
6. Confirm idempotency before re-enabling scheduled sync.

## Safe rollback

Remove `connector.testrail` from enabled plugins or set the TestRail source to disabled.
Do not delete Jira/GitHub evidence or canonical knowledge. Preserve audit events and the
checkpoint needed to investigate the failed sync.
