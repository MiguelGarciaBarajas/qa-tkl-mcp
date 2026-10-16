# Workspace Source Connections

## Purpose

An authorized connection owner can configure Jira, GitHub, TestRail, Confluence, or
ReportPortal for one tenant/product workspace from the dashboard. The browser sends a
credential once; the API validates and encrypts it and returns only non-secret metadata.

MCP does not receive or store source credentials. It reads normalized knowledge through
the Application API.

## Required deployment configuration

| Variable | Purpose |
|---|---|
| `TKL_CREDENTIAL_VAULT_DATA_DIR` | Durable directory for encrypted connection records |
| `TKL_CREDENTIAL_VAULT_KEY` | Base64-encoded 32-byte AES-256 key |
| `TKL_RAW_EVIDENCE_DATA_DIR` | Durable encrypted raw-evidence directory |
| `TKL_RAW_EVIDENCE_KEY` | Base64-encoded 32-byte AES-256 key |
| `TKL_KNOWLEDGE_DATA_DIR` | Durable directory containing the local/default `knowledge-store.sqlite` canonical projection |
| `TKL_KNOWLEDGE_SQLITE_BUSY_TIMEOUT_MS` | Optional SQLite writer wait timeout in milliseconds; defaults to `5000` |
| `TKL_SOURCE_ALLOWED_HOSTS` | Comma-separated approved Jira, TestRail, Confluence, ReportPortal, or GitHub Enterprise hosts |
| `TKL_SOURCE_ALLOWED_INSECURE_HOSTS` | Optional comma-separated exact internal hosts approved to use HTTP; never use wildcards |
| `TKL_SOURCE_ALLOW_INSECURE_LOOPBACK` | Development-only `true` opt-in for loopback HTTP fixtures; ignored in production |

Use different keys for the credential vault and raw-evidence store. Inject both from the
approved deployment secret manager; never commit them or place them in dashboard
configuration. Rotate a source credential with **Reconnect / rotate**. Rotating the vault
master key requires an operator-controlled migration and is not performed by the UI.

SQLite is the implemented single-node backend. It uses WAL and transactional writes.
PostgreSQL is the production scale-out target for multi-node deployments but is not
implemented. Never point multiple hosts at a SQLite file on a network filesystem.

## Permissions

| Permission | Capability |
|---|---|
| `connections:read` | View sanitized connection metadata |
| `connections:write` | Connect, validate, rotate, and disconnect |
| `connections:sync` | Start a source sync |

All operations also require tenant and product authorization. The authenticated subject
becomes the connection owner; the dashboard cannot select another owner.

## Statuses

| Status | Meaning |
|---|---|
| `not-connected` | No credential is stored |
| `validating` | A provider validation request is in progress |
| `connected` | The latest validation succeeded |
| `syncing` | A connector sync is in progress |
| `stale` | Previously connected, but freshness has exceeded policy |
| `authorization-expired` | The provider rejected the credential with `401` or `403` |
| `error` | Configuration, network, provider, or internal operation failed |
| `disabled` | Connection is administratively disabled |

Errors returned to the dashboard contain a bounded code, category, and message. Provider
response bodies, request headers, credentials, and stack traces are never returned.

## Source scope

- **GitHub:** exactly one approved `owner/repository` per connection in the current
  connector implementation. GitHub.com uses the default API and web URLs. GitHub
  Enterprise requires both its API URL (for example, `https://ghe.example/api/v3`) and
  web URL (for example, `https://ghe.example`) so evidence links remain on the approved
  Enterprise host.
- **Jira:** approved project keys and one approved JQL expression.
- **TestRail:** approved project ID and suite IDs.
- **Confluence:** approved space keys; current pages labeled `requirement` are normalized
  into canonical requirements.
- **ReportPortal:** approved project; launches and test items are normalized as execution
  evidence, with defect links only for explicit external issue identities.

Custom source hosts must appear in `TKL_SOURCE_ALLOWED_HOSTS`. GitHub.com uses
`api.github.com` by default. Plain HTTP is rejected unless
`TKL_SOURCE_ALLOW_INSECURE_LOOPBACK=true` is set outside production for a loopback test
environment.

## Recovery

1. For `authorization-expired`, rotate the credential and reconnect.
2. For `source_host_not_allowed`, ask the deployment owner to approve the exact hostname;
   do not broaden the allowlist to wildcards.
3. For network or provider errors, verify DNS/TLS and the source health, then use
   **Test connection**.
4. For targeted retrieval failures, retain encrypted evidence, correct the source issue,
   and repeat the exact artifact search. Do not replace bounded retrieval with a broad sync.
5. For vault decryption/authentication failure, stop the service and restore the correct
   key or encrypted snapshot. Never replace the store with plaintext or silently create a
   new empty vault.
6. For SQLite corruption, unsupported schema, or repeated busy-timeout errors, stop
   writers and restore/repair the database explicitly. The API intentionally does not
   fall back to `knowledge-store.json`.
