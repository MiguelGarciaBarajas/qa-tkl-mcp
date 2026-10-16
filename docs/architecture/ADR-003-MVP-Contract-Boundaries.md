# ADR-003: MVP Contract Boundaries

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decision owners:** TKL Project Team

## Context

The proposal describes a broad future platform: a rich feature-centered knowledge model,
fully plugin-driven processing, generic MCP resource paths, and direct browser access to
the API. The delivered MVP must remain secure, auditable, and versionable without
pretending that every future capability already exists.

## Decision

The MVP uses the following explicit boundaries:

1. The canonical model remains the currently versioned set of requirements, tests,
   executions, defects, claims, conflicts, and trace links. Product, Feature,
   BusinessRule, TruthTableRow, Release, SourceArtifact, and ReviewDecision remain future
   contract additions that require versioning and migration.
2. Connector discovery is plugin-driven. Normalizers, analyzers, and MCP tools remain
   statically composed in the trusted application roots for the MVP.
3. MCP resources remain tenant/product scoped. This is intentionally narrower than the
   proposal's generic example URIs and prevents accidental cross-product discovery.
4. The dashboard and API are deployed behind the same-origin reverse proxy. The API does
   not enable permissive browser CORS; any future cross-origin deployment must introduce
   an explicit origin allowlist and preflight tests.
5. Raw-evidence producer plugin lineage and `get_test_failure_history` are deferred
   capabilities. They must be delivered as versioned contract changes rather than
   inferred from existing source fields.

## Consequences

- Current consumers have a stable and smaller contract.
- Security-sensitive routing and browser access stay fail closed.
- Future model expansion, producer lineage, failure-history queries, and generalized
  plugin composition require dedicated backlog items, migrations, and compatibility
  tests.
- The proposal remains the product vision, while this ADR states what the MVP actually
  guarantees.
