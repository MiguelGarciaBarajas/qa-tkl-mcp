# ReportPortal Connector

Read-only source connector for ReportPortal launches and test items in one configured
project.

## Contract

- Plugin ID: `connector.reportportal`
- Capabilities: launch read, test item read, incremental sync
- Logical permission: `reportportal.launch.read`
- Output: `reportportal.launch` and `reportportal.test_item` `RawEvidenceRecord` objects

The deployment credential must be limited to the approved FL Titling project and mapped
to a `secret://reportportal/...` reference. Request the least-privilege read scope from
the ReportPortal system owner rather than documenting or storing a token here.

This connector deliberately keeps scope bounded: it does not collect raw execution logs
and does not infer flakiness or root-cause analysis. Test item payloads retain whatever
explicit issue/defect classification and external issue references ReportPortal itself
reports; the connector never derives or adds its own classification.

## Production HTTP adapter

`createReportPortalHttpClient` (in `src/reportportal-http-client.js`, re-exported from
`src/index.js`) is a dependency-free ReportPortal REST API client:

```js
import { createReportPortalHttpClient, ReportPortalConnector } from "@tkl/connector-reportportal";

const client = createReportPortalHttpClient({
  baseUrl: process.env.REPORTPORTAL_BASE_URL,
  project: process.env.REPORTPORTAL_PROJECT, // e.g. "fl_titling"
  credentialRef: "secret://reportportal/fl-titling",
  resolveCredential, // async (ref) => raw API token, injected by the secret provider
});

const connector = new ReportPortalConnector({
  client,
  tenantId,
  productId: "fl-titling",
  credentialRef: "secret://reportportal/fl-titling",
  baseUrl: process.env.REPORTPORTAL_BASE_URL, // used to build evidence sourceUrl
  project: process.env.REPORTPORTAL_PROJECT,
});
```

- `baseUrl` must be HTTPS in production (set `allowInsecureLoopback: true` on the HTTP
  client to permit plain HTTP, and only then for a loopback host --
  `localhost`/`127.0.0.1`/`[::1]` -- for local development or tests).
- Launches are listed from `api/v1/{project}/launch`; test items are listed per launch
  from `api/v1/{project}/launch/{launchId}/testItem`. Every request is scoped to the
  configured `project`, embedded directly in the request path -- there is no allowlist
  parameter to bypass. Returned test items are also checked item-by-item after the
  response is received: any item whose `launchId` does not match the requested launch
  causes the whole page to be rejected (fail closed) rather than silently dropped.
- The credential is resolved through the injected `resolveCredential` function on every
  request (returning the raw API token) and is never stored, logged, or embedded in
  returned data or thrown errors. The client sends `Authorization: Bearer <token>`,
  matching this codebase's existing convention for bearer-token sources (Jira, GitHub).
- HTTP errors surface only the response status, a bounded `Retry-After` hint, and a
  query-free URL; response bodies and headers are never attached to thrown errors.

## Operational behavior

- Pagination uses ReportPortal's `content` array plus zero-based `page` metadata
  (`page.number`, `page.totalPages`). Every request URL is rebuilt locally from the
  caller's own trusted `baseUrl`, `project`, and launch ID -- ReportPortal's page API
  carries no HATEOAS links to normalize or trust, so there is nothing to smuggle a scope
  change through. A page only ever advances when it actually returned records and the
  response's own `page.number`/`page.totalPages` metadata proves another page exists;
  a response missing that metadata fails closed (no further pages) rather than guessing.
  Both launches and test items are requested with a fixed, deterministic sort
  (`startTime,ASC`), so repeated syncs observe a stable order.
- Checkpoints track phase (`launches`, `items`), the in-flight launch ID, and the item
  page; `health().lastCheckpoint` is `{ phase: "complete" }` after a full sync finishes,
  and that exact shape is itself a valid, resumable checkpoint that starts a fresh full
  sync. Replaying launches or items on resume is safe -- their deterministic idempotency
  keys deduplicate anything already collected in a prior run.
- Retries bounded transient failures (`408/425/429/500/502/503/504`) and honors
  `Retry-After`.
- Emits deterministic idempotency keys derived from the project, record type, ID,
  version, and a content hash of the payload.
- Reports health and credential reference without credential values.
- Emits sanitized, structured sync events (`connector.sync.start`, `connector.retry`,
  `connector.failure`, `connector.sync.complete`) to an optional injected `logger`
  (a no-op by default); events never include the resolved credential value, launch/test
  item payloads, or a raw error message.

## External prerequisites

Before enabling live sync, obtain through approved channels:

- ReportPortal base URL and project name.
- Read-only API token stored in the approved secret provider.

Provide only environment/secret references to the application. Never commit actual
credentials.
