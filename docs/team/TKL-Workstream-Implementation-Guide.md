# TKL Workstream Implementation Guide

## Purpose

This guide tells each contributor exactly where to work, what to do first, what is
already available, and which handoffs are still pending. It supplements the ownership
and acceptance criteria in `TKL-Team-Work-Plan.md`. The authoritative task order and
completion state are maintained in `TKL-Delivery-Backlog.md`.

## Branch and Integration Status

- Integration base: `main`.
- Phase 1 connector, knowledge, API/MCP/security, and dashboard scaffolds are merged.
- Phase 2 preparation from PR #5 is merged.
- The typed contract foundation is in PR #7, with composition and configuration
  stabilization stacked in PR #8. Work that needs those APIs may branch from the
  corresponding feature branch until both PRs merge.
- Rebase or merge current `main` before opening a PR. Do not copy another owner's
  implementation into your package.

Current handoffs:

| Area | Available | Pending |
|---|---|---|
| Contracts | Shared typed domain contracts, product configuration validation, plugin registry, and composition root | Review and merge PRs #7 and #8 |
| Ingestion | Jira, GitHub, and TestRail collection logic and sanitized fixtures | Production HTTP clients and approved live configuration |
| Knowledge | Jira/GitHub normalizers, in-memory store, coverage/conflict analyzers | TestRail normalizers and production application wiring |
| API/MCP | Read-only API/MCP modules, real fixture-backed knowledge composition, policy, security, and observability | Complete knowledge queries and one consistent MCP scope |
| Dashboard | Health, traceability, gaps, conflicts, and evaluation pages with mocks | HTTP API client and TestRail-specific data |

## Shared Start Procedure

1. Confirm your identity and assigned workstream.
2. Pull the integration base and inspect open changes in your owned paths.
3. Run the smallest existing tests for your packages before editing.
4. Select the first `READY` item for your owner in `TKL-Delivery-Backlog.md`.
5. Use sanitized fixtures when live source access is unavailable.
6. Coordinate before changing a shared contract or another owner's path.
7. Finish with package tests, affected contract/integration tests, updated docs, and the
   backlog item marked `DONE` with evidence.

## Miguel Barajas - Architecture and Contracts

Owned paths:

- `packages/contracts/`
- `packages/plugin-registry/`
- `packages/core/`
- `config/`
- `docs/architecture/`
- `tests/contract/`

First tasks, in order:

1. Complete review and merge of the typed contracts in PR #7.
2. Complete review and merge of configuration, composition, and versioning in PR #8.
3. Review connector and normalizer changes that alter shared evidence or canonical
   contracts.
4. Add cross-workstream TestRail contract fixtures/tests when sanitized source payloads
   are available.
5. Approve any contract version change with all affected owners.

Handoffs:

- To Jorge: stable connector/configuration contracts.
- To Josue: typed canonical entities, claims, provenance, and trace links.
- To Carlos and Clemente: stable application result schemas.

Do not implement source clients, normalization decisions, MCP handlers, or dashboard UI.

## Jorge Santiago - Source Ingestion

Owned paths:

- `plugins/connectors/jira/`
- `plugins/connectors/github/`
- `plugins/connectors/testrail/`
- Source fixtures under `tests/fixtures/`
- Connector runbooks under `docs/runbooks/`

First tasks, in order:

1. Implement the TestRail HTTP client adapter behind the existing connector interface.
2. Resolve base URL, project ID, suite allowlist, and credential reference through
   configuration rather than source constants.
3. Verify suites, cases, runs, results, pagination, checkpoints, retries, and
   idempotency against sanitized fixtures.
4. Add health/error scenarios and a TestRail operational runbook.
5. Re-run Jira/GitHub connector tests to preserve existing behavior.

Handoff to Josue:

- Valid `RawEvidenceRecord` streams for `testrail.suite`, `testrail.case`,
  `testrail.run`, and `testrail.result`.
- Payload/version/checkpoint examples and known source-field mappings.

Do not normalize knowledge, calculate coverage, expose MCP tools, or store credentials.

## Josue Misael Torres - Knowledge and Traceability

Owned paths:

- `packages/knowledge-store/`
- `packages/markdown-export/`
- `plugins/normalizers/`
- `plugins/analyzers/`
- Knowledge fixtures/tests under `tests/fixtures/` and `tests/contract/`
- `docs/analysis/`

First tasks, in order:

1. Agree with Miguel on canonical TestRail types and remove local contract duplication.
2. Add normalizers for suites, cases, runs, and results.
3. Add explicit Jira requirement-to-TestRail case links.
4. Add reviewed TestRail case-to-GitHub automation links.
5. Extend coverage, conflict, and Markdown output with manual/execution evidence.

Handoff to Carlos and Clemente:

- Product-scoped queries for requirements, manual tests, automated tests, executions,
  provenance, conflicts, and separate coverage dimensions.

Do not fetch source APIs, define authentication, or maintain Markdown as source data.

## Carlos Ramirez - API, MCP, and Security

Owned paths:

- `apps/api/`
- `apps/mcp-gateway/`
- `packages/security/`
- `packages/policy/`
- `packages/observability/`
- `docs/security/`

First tasks, in order:

1. Integrate the production identity adapter, RBAC, and credential-reference resolver.
2. Complete TestRail-aware knowledge queries after `KNW-106`.
3. Unify MCP inputs around `tenantId`, `productId`, and `storyId`.
4. Test the real gateway rather than an alternate provider implementation.
5. Prove through tests that credentials and cross-product data never reach consumers.

Production dependencies to request through approved owners:

- Identity provider/application registration.
- Secret-manager access and credential-reference resolver.
- Deployment environment and audit-log destination.

Do not call Jira, GitHub, or TestRail directly from API/MCP code.

## Clemente Herrera - Dashboard and Evaluation

Owned paths:

- `apps/dashboard/`
- Evaluation and golden fixtures under `tests/fixtures/`
- Dashboard/evaluation documentation under `docs/analysis/`

First tasks, in order:

1. Add TestRail pending-configuration and connector-health fixtures/states.
2. Display manual coverage, automated coverage, and execution freshness separately.
3. Add Jira-TestRail-GitHub golden scenarios using sanitized records.
4. Implement the HTTP-backed `TklApiClient` while retaining mocks for isolated tests.
5. Measure precision, recall, provenance completeness, freshness, latency, and QA
   acceptance.

Current integration seam:

- `apps/dashboard/src/contracts/types.ts`
- `apps/dashboard/src/mocks/fixtures.ts`
- `apps/dashboard/src/api/client.ts`

Request representative FL Titling ticket selection from the QA/product owner. Do not
copy production ticket content into committed fixtures without sanitization.

## External Access Procedure

| Need | Request from | Safe response |
|---|---|---|
| Jira project/repository scope | Jira system owner or TKL project lead | Approved project/filter and credential reference |
| GitHub repository scope | Repository/org owner or TKL project lead | Approved repository list and read-only app/token reference |
| TestRail project/suites | TestRail system owner or TKL project lead | Base URL, project/suite IDs, mappings, credential reference |
| Secret provisioning | Environment/secret-manager owner | Secret URI/name and readiness status only |
| VPN/network | Corporate access support or project lead | Confirmation that access is available |
| FL Titling domain rules | QA/product owner | Reviewed non-secret rules or sanitized examples |

Never request or accept raw credentials in chat, commits, fixtures, logs, screenshots, or
dashboard fields. If access is unavailable, record the dependency and continue with
sanitized fixtures.
