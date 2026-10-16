# GitHub Connector Runbook

## Configuration validation

Before enabling live sync, verify:

- `GITHUB_API_URL` resolves to the approved GitHub REST endpoint (`api.github.com`, or the
  approved GitHub Enterprise Server host) and uses HTTPS; plain HTTP is rejected unless
  `allowInsecureLoopback` is explicitly enabled for a loopback host in local
  development/tests.
- The configured repository allowlist contains only approved `owner/repo` entries, exactly
  matching the repositories granted to the credential.
- `secret://github/fl-titling` resolves to a read-only credential scoped to only the
  allowlisted repositories.
- For GitHub Enterprise Server, `GITHUB_WEB_BASE_URL` (the connector/client `webBaseUrl`)
  is explicitly configured and validated (HTTPS by default); it is used only to build
  human-facing evidence `sourceUrl` links and is never sent a credential. When omitted,
  evidence links default to `https://github.com` for backward compatibility.

Do not print the resolved credential during validation.

## Health signals

Monitor:

- Connector status: `healthy` or `degraded`.
- Records collected.
- Retry and failure counts.
- Last successful sync timestamp.
- Last valid checkpoint (pull request page/number, changed-file page).
- Credential-reference readiness without its value.

## Sanitized structured logging

An optional `logger` (an object exposing `info(event)`) may be injected into the
constructor; it defaults to a no-op, so logging is opt-in and never required. When
configured, the connector emits `connector.sync.start`, `connector.retry`,
`connector.failure`, and `connector.sync.complete` events carrying only `pluginId`,
`tenantId`, `productId`, counts, status codes, and the last checkpoint -- never the
resolved credential value, pull request/file payloads, or a raw error message. A
logger that throws is swallowed and can never turn a working sync into a failure.

## Common failures

| Symptom | Likely cause | Safe action |
|---|---|---|
| Configuration validation fails | Missing tenant/product/repository/credential reference | Correct non-secret configuration or secret reference |
| `"apiUrl must use HTTPS..."` | `GITHUB_API_URL` uses plain HTTP against a non-loopback host | Use HTTPS, or set `allowInsecureLoopback` only for a local loopback dev/test endpoint |
| `"webBaseUrl must use HTTPS..."` | `GITHUB_WEB_BASE_URL` uses plain HTTP against a non-loopback host | Use HTTPS, or set `allowInsecureLoopback` only for a local loopback dev/test endpoint |
| `"Request URL must be HTTPS and same-origin..."` | A pagination cursor resolved to a different origin or scheme than the configured `apiUrl` | Treat as a potential integrity issue; do not retry against the cursor, restart the sync from the last valid checkpoint |
| `"Request URL does not match the expected GitHub API operation"` | A same-origin pagination cursor resolved to a different repository, a different pull request's files, or an unrelated endpoint | Treat as a potential integrity issue; do not retry against the cursor, restart the sync from the last valid checkpoint |
| `"... not in the configured allowlist"` at the HTTP client | Repository is outside the approved allowlist | Confirm the approved repository scope with the repository/organization owner before widening the allowlist |
| `401` or `403` | Credential unavailable or insufficient read permission | Ask the GitHub/secret owner to verify access; do not request the secret value |
| `404` | Incorrect repository or inaccessible resource | Confirm the approved repository with the repository owner |
| `429` | Rate limit (primary or secondary) | Preserve checkpoint and allow bounded `Retry-After` handling |
| `5xx` or timeout | Temporary GitHub/network failure | Retry within bounds; keep last valid checkpoint |
| Unexpected records | Repository allowlist misconfiguration | Disable live sync and verify configuration before retrying |

## Recovery

1. Disable the GitHub source without disabling Jira/TestRail.
2. Preserve the last valid checkpoint and sanitized error metadata.
3. Correct configuration, permissions, allowlist, or network access.
4. Run connector and HTTP client tests and a sanitized dry run.
5. Resume using the last valid checkpoint. The connector intentionally restarts
   pull-request and changed-file pagination from the first page because GitHub's
   update-descending order can change between attempts.
6. Confirm the raw-evidence store deduplicates replayed records before re-enabling
   scheduled sync.

## Safe rollback

Remove `connector.github` from enabled plugins or set the GitHub source to disabled. Do
not delete Jira/TestRail evidence or canonical knowledge. Preserve audit events and the
checkpoint needed to investigate the failed sync.
