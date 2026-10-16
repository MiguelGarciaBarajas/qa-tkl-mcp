# Source Integration Contract

This document defines the boundary between source plugins and the Carlos Ramirez
workstream.

## Ownership

- Source connector plugins retrieve read-only evidence from Jira, GitHub, TestRail,
  Confluence, ReportPortal, or another approved source.
- Normalizers and knowledge services convert that evidence into canonical entities,
  claims, relationships, and provenance.
- The TKL Application API exposes source-agnostic read-only queries.
- The MCP Gateway delegates to the Application API and never calls a source system.

Connector credentials, pagination, retries, checkpoints, raw evidence persistence, and
normalization are not implemented in the API or MCP packages.

## Source filter contract

The optional `source` filter is one of the registered source IDs:

`jira`, `github`, `testrail`, `confluence`, `reportportal`

When supplied, the API validates the identifier and passes it unchanged to the injected
knowledge service. The MCP Gateway validates the same shared schema and passes the
argument unchanged to the Application API client. No source-specific switch or client
is allowed in either layer.

## Integration checklist

Before enabling a source in a product, the owning teams must provide:

1. A reviewed connector manifest and configuration entry.
2. Read-only credential references managed by an approved secret provider.
3. Raw evidence and provenance conforming to the shared contracts.
4. Normalization and contract tests.
5. Product authorization and audit coverage.
6. An integration test from source evidence through the API and MCP capability.

For Confluence connections, shared spaces should use canonical root-page references
with `tree` or `page` scope. Whole-space ingestion is an explicit option only when the
entire space is approved for the product. Root page URLs are resolved to page IDs before
sync so renamed pages retain stable identity.

TestRail is currently accepted by the shared API/MCP contracts, but its connector,
normalizer, credentials, and product configuration remain owned by the source-ingestion
and knowledge workstreams.
