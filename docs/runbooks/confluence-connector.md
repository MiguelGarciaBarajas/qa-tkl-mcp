# Confluence Connector

## Scope

The connector reads current pages from explicitly approved Confluence spaces. Only pages
with a case-insensitive `requirement` label become canonical requirement knowledge.
Other pages remain encrypted raw evidence but produce no canonical entity.

Required connection values:

- `baseUrl`, including any path prefix such as `/wiki`.
- `username`.
- One or more approved `spaceKeys`.
- A user API token stored only in the workspace credential vault.

The credential is resolved per request and sent as HTTP Basic
`base64(username:token)`. It is never returned by the API or stored in dashboard state.

## Operation and recovery

Pages are read from `rest/api/content` with current-page filters and bounded pagination.
Pagination URLs are rebuilt from trusted configuration, remain same-origin, and advance
by the number of records actually returned. Checkpoints bind the offset to the configured
space key and index.

For authorization failures, rotate the workspace credential. For host-policy failures,
approve the exact hostname through `TKL_SOURCE_ALLOWED_HOSTS`. A completed checkpoint
starts a safe full replay; durable idempotency prevents unchanged pages from duplicating.

Known limitation: deleted or archived pages do not currently create tombstones.
