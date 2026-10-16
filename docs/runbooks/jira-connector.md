# Jira Connector Runbook

## Configuration validation

Before enabling live sync, verify:

- `JIRA_BASE_URL` resolves to the approved Jira instance and uses HTTPS; plain HTTP is
  rejected unless `allowInsecureLoopback` is explicitly enabled for a loopback host in
  local development/tests. The connector's own `baseUrl` (used to build evidence
  `sourceUrl`) should match the HTTP client's configured base URL.
- The configured project allowlist contains only approved FL Titling project keys.
- The configured JQL allowlist contains only reviewed, exact JQL strings (JQL is matched
  by exact string, not by pattern, so an unlisted query is always rejected).
- `secret://jira/fl-titling` resolves to a read-only credential.
- Either a fixed `issueKey` (legacy mode) or an allowlisted `jql` (search mode) is
  configured, but not both.

Do not print the resolved credential during validation.

## Health signals

Monitor:

- Connector status: `healthy` or `degraded`.
- Records collected.
- Retry and failure counts.
- Last successful sync timestamp.
- Last valid checkpoint (issue/comments in legacy mode, issues/comments in search mode).
  JQL-search checkpoints carry an explicit `mode: "search"` field so resume always
  routes back through the search path (including when captured mid-comments); legacy
  single-issue checkpoints omit `mode` and resume through the legacy single-issue path,
  exactly as before. A checkpoint's `mode` is validated against this connector
  instance's actual configured scope: a `mode: "issue"` checkpoint is rejected for a
  JQL-only connector, and a `mode: "search"` checkpoint is rejected for an issue-only
  connector. Search checkpoints also carry a deterministic `jqlFingerprint`; a resumed
  checkpoint whose fingerprint no longer matches the connector's currently configured
  JQL is rejected rather than resumed against a changed query.
- Credential-reference readiness without its value.

## Sanitized structured logging

An optional `logger` (an object exposing `info(event)`) may be injected into the
constructor; it defaults to a no-op, so logging is opt-in and never required. When
configured, the connector emits `connector.sync.start`, `connector.retry`,
`connector.failure`, and `connector.sync.complete` events carrying only `pluginId`,
`tenantId`, `productId`, counts, status codes, and the last checkpoint -- never the
resolved credential value, issue/comment payloads, or a raw error message. A logger
that throws is swallowed and can never turn a working sync into a failure.

## Pagination cursors

Search and comment pagination advances by a **cumulative absolute offset** taken from
each response (`startAt` echoed by the server plus the number of records actually
returned), never by `page * pageSize`. Jira caps `maxResults` server-side, so a
requested page of 100 is routinely served as 50; advancing by the requested page size
would permanently skip the withheld records and leave a silent evidence gap. Cursors
are therefore `{ startAt: <absolute offset> }` and appear verbatim in a checkpoint's
`page` and `commentPage` fields. Legacy numeric page-index cursors in older
checkpoints are still accepted (resolved as `page * pageSize`), so no checkpoint
migration is needed. Paging stops when a response reports `isLast`, returns no
records, would not advance the cursor, reaches the reported `total`, or carries no
`total`/`isLast` to prove more records exist.

## Common failures

| Symptom | Likely cause | Safe action |
|---|---|---|
| Configuration validation fails | Missing tenant/product/credential reference, or neither `issueKey`, `jql`, nor a legacy `client.issueKey` configured | Correct non-secret configuration or secret reference |
| `"A pagination cursor must ..."` | A checkpoint's `page`/`commentPage` cursor is malformed (negative, fractional, or a non-integer `startAt`) | Restart the sync from a fresh or last-known-good checkpoint; do not hand-edit the cursor |
| `"Checkpoint mode ... is not valid for this connector..."` | A `mode: "issue"` checkpoint resumed against a JQL-only connector, or a `mode: "search"` checkpoint resumed against an issue-only connector | Confirm the checkpoint belongs to this connector's configuration; do not force a mode mismatch |
| `"Checkpoint JQL fingerprint does not match..."` | The connector's configured JQL changed since the checkpoint was saved | Restart the sync from a fresh (or matching) checkpoint after a JQL/allowlist change |
| `"Checkpoint issueKey ... does not match..."` | A single-issue checkpoint's `issueKey` does not match this connector's configured/fallback `issueKey` | Confirm the checkpoint belongs to this connector's configuration |
| `"baseUrl must use HTTPS..."` | `JIRA_BASE_URL` uses plain HTTP against a non-loopback host | Use HTTPS, or set `allowInsecureLoopback` only for a local loopback dev/test endpoint |
| `"... not in the configured allowlist"` at the HTTP client | Issue key's project, JQL, or a search result's project is outside the approved allowlist (search results are validated after the response is received and rejected/fail-closed if any are out of scope or missing a valid key) | Confirm the approved project/JQL scope with the Jira source owner before widening the allowlist |
| `401` or `403` | Credential unavailable or insufficient read permission | Ask the Jira/secret owner to verify access; do not request the secret value |
| `404` | Incorrect issue key or inaccessible resource | Confirm the approved issue key or JQL with the Jira owner |
| `429` | Rate limit | Preserve checkpoint and allow bounded `Retry-After` handling |
| `5xx` or timeout | Temporary Jira/network failure | Retry within bounds; keep last valid checkpoint |
| Unexpected records | Project/JQL allowlist misconfiguration | Disable live sync and verify configuration before retrying |

## Recovery

1. Disable the Jira source without disabling GitHub/TestRail.
2. Preserve the last valid checkpoint and sanitized error metadata.
3. Correct configuration, permissions, allowlist, or network access.
4. Run connector and HTTP client tests and a sanitized dry run.
5. Resume from the last valid checkpoint.
6. Confirm idempotency before re-enabling scheduled sync.

## Safe rollback

Remove `connector.jira` from enabled plugins or set the Jira source to disabled. Do not
delete GitHub/TestRail evidence or canonical knowledge. Preserve audit events and the
checkpoint needed to investigate the failed sync.
