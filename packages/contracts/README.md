# TKL Contracts

This package contains the versioned runtime and TypeScript contracts shared by connectors,
normalizers, storage, analyzers, the Application API, MCP Gateway, and dashboard adapters.
It defines the MVP tool schemas, response shapes, canonical knowledge types, connector
checkpoints/health, and application result contracts.

The contracts are intentionally source-agnostic. Changes should be reviewed by the
Architecture and Contracts workstream before they become integration contracts for
connectors, normalizers, storage, analyzers, or agents.

Registered source identifiers currently include `jira`, `github`, `testrail`,
`confluence`, and `reportportal`. Adding a source requires a connector/normalizer
registration, not a change to API or MCP business logic.

Runtime values are exported from `src/index.js`; TypeScript declarations are exported
from `src/index.d.ts`. Consumers should import shared types from `@tkl/contracts` instead
of creating local mirrors. The former knowledge-store mirror was removed by `ARCH-102`.

Compatibility and migration rules are defined in
`docs/architecture/TKL-Contract-Versioning.md`.
