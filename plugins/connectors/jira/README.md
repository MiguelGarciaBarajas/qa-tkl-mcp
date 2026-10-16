# Jira Connector

Read-only source connector for Jira issues and comments.

## Contract

- Plugin ID: `connector.jira`
- Capabilities: issue read, issue search, comment read, incremental sync
- Logical permission: `jira.issue.read`
- Output: `jira.issue` and `jira.comment` `RawEvidenceRecord` objects

The deployment credential must be limited to the approved FL Titling projects/filters and
mapped to `secret://jira/fl-titling`. The exact Jira OAuth/API scope depends on the
organization's approved authentication method; request the least-privilege read scope
from the Jira system owner rather than documenting or storing a token here.

## Production HTTP adapter

`createJiraHttpClient` (in `src/jira-http-client.js`, re-exported from `src/index.js`) is a
dependency-free Jira REST v2 client:

```js
import { createJiraHttpClient, JiraConnector } from "@tkl/connector-jira";

const client = createJiraHttpClient({
  baseUrl: process.env.JIRA_BASE_URL,
  credentialRef: "secret://jira/fl-titling",
  resolveCredential, // async (ref) => bearer token, injected by the secret provider
  allowedProjects: process.env.JIRA_ALLOWED_PROJECTS.split(","), // e.g. ["STT"]
  allowedJql: process.env.JIRA_ALLOWED_JQL.split("|"), // exact allowlisted JQL strings
});

const connector = new JiraConnector({
  client,
  tenantId,
  productId: "fl-titling",
  credentialRef: "secret://jira/fl-titling",
  baseUrl: process.env.JIRA_BASE_URL, // used to build evidence sourceUrl; defaults to DEFAULT_JIRA_BASE_URL for legacy injected clients
  issueKey: "STT-3731", // legacy single-issue mode, or:
  jql: "project = STT AND status = Open", // JQL search mode (mutually exclusive with issueKey)
});
```

- `baseUrl` is fully configurable; it no longer defaults to a fixed connector constant,
  and must be HTTPS in production (set `allowInsecureLoopback: true` on the HTTP client
  to permit plain HTTP, and only then for a loopback host --
  `localhost`/`127.0.0.1`/`[::1]` -- for local development or tests).
- Every `fetchIssue`/`fetchComments`/`searchIssues` call is checked against the configured
  project and JQL allowlists *before* any network call, so out-of-scope requests never
  leave the process. Search results are also checked issue-by-issue after the response is
  received: any returned issue outside the allowed projects, or missing a valid issue key,
  causes the whole page to be rejected (fail closed) rather than silently dropped.
- The `JiraConnector`'s evidence `sourceUrl` is derived from its own configured `baseUrl`
  (defaulting to `DEFAULT_JIRA_BASE_URL` for legacy injected clients that omit it), never
  from a hard-coded host.
- The credential is resolved through the injected `resolveCredential` function on every
  request and is never stored, logged, or embedded in returned data or thrown errors.
- HTTP errors surface only the response status, a bounded `Retry-After` hint, and a
  query-free URL; response bodies and headers are never attached to thrown errors. The
  per-request timeout stays armed through response body consumption/parsing (not just
  the initial connection), and is always cleared exactly once.

## Operational behavior

- Legacy mode reads one fixed issue and its optional paginated comments (`startAt`/
  `maxResults`), preserved for backward compatibility, including the legacy
  `client.issueKey` fallback when neither a connector `issueKey` nor `jql` is configured.
- Search mode paginates JQL search results and collects paginated comments for every
  matched issue.
- **Pagination uses a cumulative absolute offset, not `page * pageSize`.** Jira caps
  `maxResults` server-side (for example serving 50 records for a requested 100), so
  advancing by the *requested* page size silently skips everything the server withheld.
  The client instead advances by the `startAt` the response echoes back plus the number
  of records actually returned, and returns that as a `{ startAt }` cursor; paging stops
  when the response reports `isLast`, returns nothing, fails to move the cursor forward,
  reaches the reported `total`, or carries no `total`/`isLast` at all (fail closed
  rather than page unbounded). Connector checkpoints carry that cursor verbatim in their
  `page`/`commentPage` fields, and legacy numeric page-index cursors from older
  checkpoints are still accepted (resolved as `page * pageSize`) so existing checkpoints
  keep resuming.
- Checkpoints are bound to this connector instance's configured collection mode and
  scope, never trusted to redirect it: a `mode: "issue"` checkpoint is rejected for a
  JQL-only connector (no `issueKey` configured), a `mode: "search"` checkpoint is
  rejected for an issue-only connector (no `jql`/`searchIssues` configured), and a
  single-issue checkpoint's `issueKey` must match the connector's configured/fallback
  `issueKey`.
- Every search checkpoint carries a deterministic fingerprint (`jqlFingerprint`) of the
  configured JQL. Resuming a checkpoint whose fingerprint no longer matches the
  connector's currently configured JQL (for example after the allowlisted JQL changed)
  is rejected rather than silently resumed against the wrong query. Checkpoints saved
  before this field existed omit it and are still resumed.
- Retries bounded transient failures (`408/425/429/500/502/503/504`) and honors
  `Retry-After`.
- Emits deterministic idempotency keys using the native Jira `fields.updated` timestamp
  in legacy issue mode, falling back to a legacy flat `updated`/`version` field for
  older fixtures/injected clients.
- Reports health and credential reference without credential values.
- Supports resuming at the comments phase (legacy mode) or mid-search/mid-comments
  (search mode).
- Emits sanitized, structured sync events (`connector.sync.start`, `connector.retry`,
  `connector.failure`, `connector.sync.complete`) to an optional injected `logger`
  (a no-op by default); events never include the resolved credential value, issue/comment
  payloads, or a raw error message.

Use sanitized fixtures and tests until approved source access is available.
