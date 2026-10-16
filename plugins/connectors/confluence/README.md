# Confluence Connector

Read-only source connector for current Confluence pages in approved page trees, exact
page sets, or entire spaces.

## Contract

- Plugin ID: `connector.confluence`
- Capabilities: page read, incremental sync
- Logical permission: `confluence.page.read`
- Output: `confluence.page` `RawEvidenceRecord` objects

The deployment credential must be limited to the approved FL Titling spaces and mapped
to a `secret://confluence/...` reference. Request the least-privilege read scope from
the Confluence system owner rather than documenting or storing a token here.

## Production HTTP adapter

`createConfluenceHttpClient` (in `src/confluence-http-client.js`, re-exported from
`src/index.js`) is a dependency-free Confluence REST API client:

```js
import { createConfluenceHttpClient, ConfluenceConnector } from "@tkl/connector-confluence";

const client = createConfluenceHttpClient({
  baseUrl: process.env.CONFLUENCE_BASE_URL, // e.g. "https://company.atlassian.net/wiki"
  username: process.env.CONFLUENCE_USERNAME, // account email
  authMode: "basic", // "basic" for Atlassian Cloud; "bearer" for self-hosted PATs
  credentialRef: "secret://confluence/fl-titling",
  resolveCredential, // async (ref) => raw API token, injected by the secret provider
  allowedSpaceKeys: process.env.CONFLUENCE_SPACE_KEYS.split(","), // e.g. ["QA", "TITLETEC"]
});

const connector = new ConfluenceConnector({
  client,
  tenantId,
  productId: "fl-titling",
  credentialRef: "secret://confluence/fl-titling",
  baseUrl: process.env.CONFLUENCE_BASE_URL, // used to build evidence sourceUrl
  spaceKeys: process.env.CONFLUENCE_SPACE_KEYS.split(","),
  contentScope: "tree",
  rootPageRefs: ["123456:QA"], // canonical pageId:spaceKey references
});
```

- `baseUrl` must be HTTPS in production (set `allowInsecureLoopback: true` on the HTTP
  client to permit plain HTTP, and only then for a loopback host --
  `localhost`/`127.0.0.1`/`[::1]` -- for local development or tests).
- Every `fetchSpacePages` call is checked against the configured space-key allowlist
  *before* any network call, so out-of-scope spaces never leave the process. Returned
  pages are also checked page-by-page after the response is received: any page whose
  `space.key` does not match the requested space causes the whole page of results to be
  rejected (fail closed) rather than silently dropped.
- `tree` scope retrieves each canonical root page directly, then uses a scoped CQL
  `ancestor` query for its descendants. `page` scope retrieves only the configured
  roots. `space` preserves the legacy whole-space behavior and must be chosen
  explicitly for shared spaces.
- Pages are collected from the path-prefix-preserving `rest/api/content` endpoint (so a
  `baseUrl` that itself carries a path prefix, for example `.../wiki`, is preserved
  rather than overwritten), filtered to `type=page&status=current`, and expanded with
  `space,version,body.storage,metadata.labels`.
- The credential is resolved through the injected `resolveCredential` function on every
  request and is never stored, logged, or embedded in returned data or thrown errors.
  Use `basic` for Atlassian Cloud account-email/API-token authentication and `bearer`
  for a self-hosted Confluence personal access token.
- HTTP errors surface only the response status, a bounded `Retry-After` hint, and a
  query-free URL; response bodies and headers are never attached to thrown errors.

## Operational behavior

- **Pagination uses a cumulative absolute offset, not `start + limit`.** A Confluence
  instance can return fewer `results` than the requested `limit`; advancing by the
  requested limit in that case would silently skip everything the server withheld. The
  client instead advances by the number of records actually returned, and returns that
  as a `{ start }` cursor. Confluence signals "more pages exist" only through a
  `_links.next` entry; that entry is required to resolve to a same-origin URL that
  still targets the `rest/api/content` operation before it is trusted as a continuation
  signal at all -- its query parameters are never carried forward verbatim; only the
  `start` offset (derived from the actual returned count) is used to build the next
  request, which is always rebuilt from the caller's own trusted `baseUrl` and
  allowlisted `spaceKey`.
- Whole-space checkpoints identify the in-flight space by index and key. Page-tree
  checkpoints identify the canonical root by index and `pageId:spaceKey`; changed
  scopes are rejected rather than silently resumed against different content.
- `health().lastCheckpoint` is `{ phase: "complete" }` after a full sync finishes; that
  exact shape is itself a valid, resumable checkpoint that starts a fresh full sync.
- Retries bounded transient failures (`408/425/429/500/502/503/504`) and honors
  `Retry-After`.
- Emits deterministic idempotency keys derived from the space key, page ID, page
  version, and a content hash of the payload.
- Reports health and credential reference without credential values.
- Emits sanitized, structured sync events (`connector.sync.start`, `connector.retry`,
  `connector.failure`, `connector.sync.complete`) to an optional injected `logger`
  (a no-op by default); events never include the resolved credential value, page
  payloads, or a raw error message.

## External prerequisites

Before enabling live sync, obtain through approved channels:

- One or more approved root page URLs. Discovery resolves their base URL, canonical
  page IDs, and space keys before the connection is stored.
- Account email and the approved `tree`, `page`, or `space` content scope.
- Read-only API token stored in the approved secret provider.

Provide only environment/secret references to the application. Never commit actual
credentials.
