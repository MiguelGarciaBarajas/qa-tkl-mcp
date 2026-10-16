# GitHub Connector

Read-only source connector for pull requests and changed files.

## Contract

- Plugin ID: `connector.github`
- Capabilities: pull-request read, changed-files read, test read, incremental sync
- Logical permission: `github.repository.read`
- Output: `github.pull_request` and `github.changed_file` `RawEvidenceRecord` objects

For a GitHub App, prefer repository metadata, contents read, and pull requests read for
only the configured repositories. For another approved authentication method, request
the equivalent least-privilege read access from the repository or organization owner.
Configuration stores only `secret://github/fl-titling`, never the credential value.

## Production HTTP adapter

`createGitHubHttpClient` (in `src/github-http-client.js`, re-exported from `src/index.js`)
is a dependency-free GitHub REST client:

```js
import { createGitHubHttpClient, GitHubConnector } from "@tkl/connector-github";

const client = createGitHubHttpClient({
  apiUrl: process.env.GITHUB_API_URL, // defaults to https://api.github.com
  credentialRef: "secret://github/fl-titling",
  resolveCredential, // async (ref) => bearer token, injected by the secret provider
  allowedRepositories: process.env.GITHUB_ALLOWED_REPOS.split(","), // e.g. ["org/fl-titling"]
});

const connector = new GitHubConnector({
  client,
  tenantId,
  productId: "fl-titling",
  credentialRef: "secret://github/fl-titling",
  repository: "org/fl-titling",
});
```

- `apiUrl` is fully configurable (GitHub Enterprise Server compatible) and must be
  HTTPS in production; set `allowInsecureLoopback: true` to permit plain HTTP, and only
  then for a loopback host (`localhost`/`127.0.0.1`/`[::1]`), for local development or
  tests.
- Every `fetchPullRequests`/`fetchChangedFiles` call is checked against a strict
  `owner/repo` allowlist *before* any network call, so out-of-scope repositories never
  leave the process.
- Pull requests and changed files paginate using GitHub's `Link: rel="next"` header as an
  opaque cursor, never by hand-reconstructing offsets. Before resolving any credential,
  every outgoing request URL -- including a resumed cursor -- is validated as HTTPS (or
  loopback HTTP when explicitly allowed) and same-origin with the configured `apiUrl`, so
  a cross-origin or downgraded-scheme cursor can never cause credentials to be sent
  outside the configured origin.
- A resumed synchronization restarts pull-request and changed-file pagination from the
  first page. GitHub orders pull requests by most recently updated, so replay plus the
  raw-evidence store's deterministic idempotency keys prevents reordered records from
  moving ahead of a stored cursor and being skipped permanently.
- Requests send only the least-privilege headers required for read-only access
  (`Authorization`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version`, and
  `User-Agent`); no other header is sent.
- The credential is resolved through the injected `resolveCredential` function on every
  request and is never stored, logged, or embedded in returned data or thrown errors.
- HTTP errors surface only the response status, a bounded `Retry-After` hint, and a
  query-free URL; response bodies and headers are never attached to thrown errors. The
  per-request timeout stays armed through response body consumption/parsing (not just
  the initial connection), and is always cleared exactly once.

## Operational behavior

- Paginates pull requests and changed files.
- Retries bounded transient failures (including recognized network/timeout failures) and
  honors `Retry-After`; ordinary non-transient `4xx` responses are not retried.
- Emits deterministic idempotency keys using the native `updated_at` timestamp GitHub
  returns in production, falling back to a legacy `updatedAt` field for injected/test
  clients.
- Reports health and credential reference without credential values.
- Restricts collection to the configured, allowlisted repository.
- Emits sanitized, structured sync events (`connector.sync.start`, `connector.retry`,
  `connector.failure`, `connector.sync.complete`) to an optional injected `logger`
  (a no-op by default); events never include the resolved credential value, pull
  request/file payloads, or a raw error message.

Use sanitized fixtures and tests until approved source access is available.
