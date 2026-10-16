# TestRail Connector

Read-only source connector for TestRail suites, cases, runs, and results.

## Configuration

The connector receives resolved configuration through dependency injection:

```js
new TestRailConnector({
  client,
  tenantId: "tenant-id",
  productId: "fl-titling",
  baseUrl: process.env.TESTRAIL_BASE_URL, // optional; falls back to the client's own validated baseUrl
  allowInsecureLoopback: false, // set true only for a loopback dev/test baseUrl override
  projectId: process.env.TESTRAIL_PROJECT_ID,
  suiteIds: process.env.TESTRAIL_SUITE_IDS.split(","),
  credentialRef: "secret://testrail/fl-titling",
});
```

The API client is responsible for resolving the credential reference through the
approved credential provider. Do not pass tokens to `TestRailConnector`, write them to
product configuration, include them in fixtures, or expose them through health data.

- The connector's own `baseUrl` (used to build evidence `sourceUrl` links) must be
  HTTPS in production, exactly like the HTTP client's `baseUrl`: plain HTTP is rejected
  by `validateConfiguration` unless `allowInsecureLoopback: true` is set and the host is
  a loopback host (`localhost`/`127.0.0.1`/`[::1]`).
- When no connector-level `baseUrl` is provided, the connector prefers the injected
  client's own already-validated `baseUrl` metadata (exposed by
  `createTestRailHttpClient`) over any other fallback, so the same HTTPS/loopback
  guarantee automatically extends to the evidence links even when the connector is not
  configured with an explicit `baseUrl` of its own.

## Production HTTP adapter

`createTestRailHttpClient` (in `src/testrail-http-client.js`, re-exported from
`src/index.js`) is a dependency-free TestRail REST API v2 client:

```js
import { createTestRailHttpClient, TestRailConnector } from "@tkl/connector-testrail";

const client = createTestRailHttpClient({
  baseUrl: process.env.TESTRAIL_BASE_URL,
  credentialRef: "secret://testrail/fl-titling",
  resolveCredential, // async (ref) => base64("email:api_key") Basic auth token
});

const connector = new TestRailConnector({
  client,
  tenantId,
  productId: "fl-titling",
  baseUrl: process.env.TESTRAIL_BASE_URL,
  projectId: process.env.TESTRAIL_PROJECT_ID,
  suiteIds: process.env.TESTRAIL_SUITE_IDS.split(","),
  credentialRef: "secret://testrail/fl-titling",
});
```

- The client implements every capability the connector requires:
  `fetchSuites`, `fetchCases`, `fetchRuns`, and `fetchResults`.
- `baseUrl` must be HTTPS in production; set `allowInsecureLoopback: true` to permit
  plain HTTP, and only then for a loopback host (`localhost`/`127.0.0.1`/`[::1]`), for
  local development or tests.
- Cases, runs, and results paginate using TestRail's native `offset`/`limit` API. Each
  page's `_links.next` link is carried as the next opaque cursor, and TestRail emits it
  in the vendor-relative form `/api/v2/get_cases/128&limit=250&offset=250` — the
  API-router pseudo-path *without* the `/index.php?` prefix a real request needs, and
  (for `get_cases`) *without* the `suite_id` the original request was scoped to. The
  client therefore normalizes a cursor to `${baseUrl}/index.php?<cursor>` and then
  **rebuilds the request from trusted values** rather than sending the cursor verbatim:
  the operation segment and every scope parameter (`suite_id`) come from the caller's
  own already-validated identifiers, only `offset`/`limit` are carried forward from the
  cursor (each validated as a bounded integer, with `limit` never exceeding the
  configured `pageSize`), and any other parameter the cursor carries is dropped.
  Accepted cursor shapes: `/api/v2/...`, `?/api/v2/...`, `/index.php?/api/v2/...`, and
  an absolute same-origin URL. `get_suites` is not paginated by TestRail and always
  returns a single page. Before resolving any credential, every outgoing request URL —
  freshly built or rebuilt from a resumed cursor (including one replayed from a
  checkpoint) — is validated as HTTPS (or loopback HTTP when explicitly allowed) and
  same-origin with the configured `baseUrl`, and re-validated against the expected
  operation and scope, so a cross-origin, downgraded-scheme, or cross-scope cursor can
  never cause credentials to be sent outside the configured origin or scope. A cursor
  that names a different project, suite, run, or operation is rejected outright, never
  silently corrected.
- `resolveCredential` must return the pre-encoded HTTP Basic Auth token (the base64
  encoding of `email:api_key`); the client never performs its own base64 encoding of a
  secret.
- The credential is resolved through the injected `resolveCredential` function on every
  request and is never stored, logged, or embedded in returned data or thrown errors.
- HTTP errors surface only the response status, a bounded `Retry-After` hint, and a
  query-free URL; response bodies and headers are never attached to thrown errors. The
  per-request timeout stays armed through response body consumption/parsing (not just
  the initial connection), and is always cleared exactly once.
- The connector retries recognized network/timeout failures (which surface without a
  status code) within the bounded retry budget, in addition to transient
  `408/425/429/500/502/503/504` statuses; ordinary non-transient `4xx` responses are not
  retried.

Live FL Titling values are intentionally pending. Development and contract tests use
`tests/fixtures/testrail-project-128.json`, which contains sanitized synthetic data.

## Capabilities

- Suite, case, run, and result collection.
- Paginated resource collection.
- Incremental checkpoints by phase and page.
- Bounded retries for transient errors and rate limits.
- Deterministic idempotency keys.
- Connector health without credential values.
- Sanitized, structured sync events (`connector.sync.start`, `connector.retry`,
  `connector.failure`, `connector.sync.complete`) emitted to an optional injected
  `logger` (a no-op by default); events never include the resolved credential value,
  suite/case/run/result payloads, or a raw error message.

## Checkpoint resumability

`health().lastCheckpoint` is `{ phase: "complete" }` after a full sync finishes. That
exact shape is itself a valid, resumable checkpoint: feeding it back into `collect()`
starts a fresh full sync (equivalent to an empty/omitted checkpoint) rather than being
rejected as an invalid phase. Any other checkpoint must use one of the four resumable
phases (`suites`, `cases`, `runs`, `results`); any other `phase` value is rejected.

## External prerequisites

Before enabling live sync, obtain through approved channels:

- TestRail base URL.
- Project ID and approved suite scope. The default `all` scope includes every current
  and future suite; `selected` requires an explicit suite ID allowlist.
- Custom field and status mappings.
- Read-only API credential stored in the approved secret provider.
- Required VPN or corporate network access.

Provide only environment/secret references to the application. Never commit actual
credentials.
