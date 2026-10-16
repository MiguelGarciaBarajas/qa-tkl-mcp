# Plugins

Plugin categories:

- `connectors`: collect raw evidence from source systems.
- `normalizers`: convert source evidence into canonical knowledge.
- `analyzers`: calculate coverage, conflicts, and future quality intelligence.

Plugins implement contracts from `packages/contracts` and are enabled through manifests
and product configuration. Adding a plugin must not require editing core orchestration.
