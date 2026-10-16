# Shared Packages

Planned shared modules:

- `contracts`: versioned interfaces and schemas.
- `core`: ingestion orchestration and plugin composition. Its deprecated
  `@tkl/core/legacy-jira-queries` subpath exists only as the ARCH-106 compatibility path
  and is removed in `@tkl/core` 0.4.
- `plugin-registry`: manifest discovery and configuration.
- `knowledge-store`: canonical entities, claims, and trace links.
- `raw-evidence-store`: durable, encrypted raw evidence and connector checkpoints.
- `sync-coordinator`: scheduled incremental sync, durable checkpoint recovery, replay
  procedures, and non-destructive retention reporting (`OPS-101`). Runs composed
  connectors per tenant/product scope; owns no source logic.
- `testkit`: fixtures, fakes, and plugin conformance tests.
- `markdown-export`: generated human-readable exports.

Shared packages must remain source-agnostic.
