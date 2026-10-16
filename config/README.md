# Product Configuration

This directory contains non-secret product configuration, such as enabled plugin IDs,
project mappings, repository allowlists, and feature flags.

Credential values must never be stored here. Configuration may contain only secret
references managed by an approved credential provider.

## Layout

- `products/<product>.json` — the versioned product configuration contract validated by
  `assertProductConfiguration` (`@tkl/contracts`). Its top-level keys are a closed
  allowlist; unknown keys are rejected.
- `operations/sync.json` — operational settings for the scheduled sync coordinator
  (`@tkl/sync-coordinator`, `OPS-101`), keyed by product ID. Kept separate from the
  product configuration contract precisely because that contract is closed and owned by
  the Architecture and Contracts workstream.

## Scheduled sync operations (`operations/sync.json`)

| Key | Meaning |
| --- | --- |
| `batchSize` | Records per atomic commit of evidence plus checkpoint. |
| `maxRecordsPerConnector` | Optional safety cap for a single run. A capped run is reported as `truncated` (a non-success status), because the production connectors replay from page zero rather than resuming from a mid-stream offset. |
| `overlapPolicy` | `skip` (default) or `fail` when a run for the same scope is already in progress in this process. |
| `schedule.cadence` | `external-cron`, `external-interval`, or `manual`. There is no embedded scheduler; one run per external trigger. |
| `schedule.configurationStatus` | `pending-external-input` until a platform/project owner approves a cadence; `ready` requires an actual trigger definition. |
| `schedule.cron` / `schedule.intervalMinutes` | The approved trigger definition, validated on load. |
| `retention.mode` | Must be `report-only`; the durable evidence store exposes no deletion API and raw evidence is immutable provenance. |
| `retention.rawEvidenceMaxAgeDays` / `retention.historyMaxEntries` | Optional horizon used for *reporting only*; `null` means no bound is configured. |

The shipped FL Titling entry intentionally has no cron expression and no retention
horizon: both are pending external decisions (see the "External Decisions Register" in
`docs/team/TKL-Delivery-Backlog.md`). Unknown keys fail closed. Storage location and
encryption key are environment references (`TKL_RAW_EVIDENCE_DIR`,
`TKL_RAW_EVIDENCE_KEY_REF`), never stored here. See
`docs/runbooks/scheduled-sync.md`.

## Jira allowlist

The FL Titling Jira source remains disabled and planned until the source owner approves
the project allowlist and JQL query. Runtime configuration must provide
`allowedProjects`, `allowedJql`, and either an allowlisted `jql` or `issueKey` before
`connector.jira` can move to `enabledPlugins` with `configurationStatus: "ready"`.

## TestRail Phase 2

The FL Titling TestRail source is intentionally disabled until the team receives the
approved read-only connection values. Runtime configuration must resolve:

- `TESTRAIL_BASE_URL`
- `TESTRAIL_PROJECT_ID`
- The `secret://testrail/fl-titling` credential reference

The default `suiteScope` is `all`, so every current and future suite in the approved
project contributes knowledge. Configure `suiteScope: "selected"` with `suiteIds` only
when a TestRail project is shared and the workspace requires an explicit subset.

Do not replace the reference with a token, password, or API key. Local values belong in
an untracked `.env` file; shared environments must use the approved secret manager.

## Confluence content scope

Configure Confluence from one or more approved root page URLs. Page discovery resolves
the canonical IDs and space keys; runtime configuration stores these as
`rootPageRefs` in `pageId:spaceKey` form.

Authentication is stored as `authMode: "basic"` for Atlassian Cloud API tokens or
`authMode: "bearer"` for personal access tokens on company-hosted Confluence. The
dashboard derives the mode from the page URL.

- `contentScope: "tree"` reads each root and all descendants and is the recommended
  default for product areas inside a shared space.
- `contentScope: "page"` reads only the exact roots.
- `contentScope: "space"` reads every current page in the approved spaces and preserves
  legacy configurations that predate page scoping.

## MCP gateway transport configuration

The MCP gateway reads its transport configuration from environment variables, not from
this directory, because the values are deployment-specific and must never be committed:

| Variable | Purpose |
| --- | --- |
| `TKL_API_URL` | Application API base URL the gateway delegates to. |
| `TKL_MCP_RESOURCE_URI` | Canonical public URI of the `/mcp` endpoint, published as OAuth protected-resource metadata. |
| `TKL_MCP_AUTHORIZATION_SERVERS` | Comma-separated approved authorization server issuer URL(s). |
| `TKL_MCP_SCOPES_SUPPORTED` | Optional comma-separated scopes advertised to MCP clients. |
| `TKL_MCP_RESOURCE_DOCUMENTATION` | Optional documentation URL advertised to MCP clients. |

These values are non-secret discovery metadata only. A partial configuration fails at
startup in every environment, and a production gateway refuses to start without it. See
`apps/mcp-gateway/README.md` and `docs/runbooks/mcp-gateway.md`.

## Canonical knowledge storage

The API reads `TKL_KNOWLEDGE_DATA_DIR` and creates
`knowledge-store.sqlite` there by default. `TKL_KNOWLEDGE_SQLITE_BUSY_TIMEOUT_MS`
optionally sets the SQLite writer wait timeout (default `5000`). These deployment values
remain environment configuration rather than product JSON because they describe
infrastructure, not product behavior. SQLite is the implemented local/single-node
backend; PostgreSQL remains the unimplemented production scale-out target.
