# ADR-001: Modular TKL Platform with MCP

- **Status:** Accepted
- **Date:** 2026-09-10
- **Decision owners:** TKL Project Team

## Context

The team needs a reusable Test Knowledge Library that can consolidate and relate quality
information from Jira, GitHub, TestRail, Confluence, ReportPortal, and future sources.

The solution must support multiple products and AI agents while preserving security,
maintainability, provenance, and human review.

Two primary approaches were considered:

1. A Markdown-first knowledge repository consumed directly by GitHub Copilot.
2. A modular TKL platform with connector plugins, a canonical knowledge model, an
   application API, and a thin MCP gateway.

## Decision

We will implement the **modular TKL platform with MCP as the solution architecture**.

The architecture will separate:

- Source connector plugins.
- Raw evidence ingestion.
- Normalization and knowledge curation.
- Canonical knowledge and traceability storage.
- Analysis plugins.
- Application API.
- MCP gateway.
- Dashboard and human-review workflows.
- Agent consumers.

MCP will provide controlled access to TKL knowledge for AI agents. It will not own the
entire ingestion pipeline, persistent storage, or secret management.

Markdown will be supported only as an **optional export and review format**. It will not
be the operational source of truth.

## Rationale

This decision:

- Allows new sources and analyzers to be added through stable plugin contracts.
- Prevents source-specific logic from being duplicated across agents.
- Keeps platform credentials outside agents and the dashboard.
- Maintains provenance, history, confidence, conflicts, and human approval.
- Supports several products without creating separate implementations.
- Allows the MVP to run as a modular monorepo and a single process without becoming a
  tightly coupled monolith.
- Preserves Markdown as a useful human-readable artifact without depending on manually
  maintained files for current knowledge.

## MVP Scope

- **Pilot product:** FL Titling
- **Initial sources:** Jira and GitHub
- **First consumer:** Read-only Coverage and Traceability Analyst
- **Initial search:** Structured and full-text
- **Initial deployment:** Modular monorepo, optionally running as one process
- **Write operations:** Out of scope
- **Markdown:** Generated export for review, sharing, and snapshots

## Current Delivery Phase

Phase 2 activates TestRail as the next read-only source. This is an incremental delivery
step, not an architecture change. TestRail suites, cases, runs, and results must pass
through the same connector, evidence, normalization, canonical knowledge, API, and MCP
boundaries. Live URL, project/suite IDs, field mappings, and credentials remain external
configuration and must not be committed.

## Consequences

### Positive

- Strong modularity and ownership boundaries.
- Better maintainability and traceability.
- Centralized security and audit controls.
- Reusable knowledge across agents and products.
- Future connectors do not require redesigning the core.

### Trade-offs

- More architecture and contract design is required before implementation.
- The first MVP takes longer than a static Markdown proof of concept.
- The team must maintain schemas, plugin compatibility, migrations, and contract tests.

## Implementation Rules

1. Core orchestration depends on interfaces, not source-specific implementations.
2. Adding a connector or analyzer must not require editing core orchestration.
3. Each plugin declares its ID, version, capabilities, permissions, and compatibility.
4. Every source record preserves provenance, version, timestamp, and content hash.
5. Every MCP capability uses strict schemas and least-privilege authorization.
6. Agents do not receive Jira, GitHub, TestRail, Confluence, or ReportPortal credentials.
7. Inferred knowledge is not published as approved truth without human review.
8. Markdown exports are generated from approved canonical knowledge.

## Related Documents

- `TKL-MCP-Proposal.md`
- `TKL-Architecture-Overview.md`
- `TKL-Contract-Versioning.md`
- `../team/TKL-Team-Work-Plan.md`
