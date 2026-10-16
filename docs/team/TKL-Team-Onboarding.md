# TKL Team Onboarding
## Identity-Based Workstream Assignment

This file must be included in the project repository and referenced by `AGENTS.md` or the
repository-level Copilot instructions.

## Team Directory

| Team member | Assigned workstream | Primary plan section |
|---|---|---|
| Miguel Barajas | Architecture and Contracts | `TKL-Team-Work-Plan.md` - Miguel Barajas |
| Jorge Santiago | Source Ingestion | `TKL-Team-Work-Plan.md` - Jorge Santiago |
| Josue Misael Torres | Knowledge and Traceability | `TKL-Team-Work-Plan.md` - Josue Misael Torres |
| Carlos Ramirez | API, MCP, and Security | `TKL-Team-Work-Plan.md` - Carlos Ramirez |
| Clemente Herrera | Dashboard and Evaluation | `TKL-Team-Work-Plan.md` - Clemente Herrera |

## Agent Startup Protocol

When a contributor starts a new session and asks to begin project work:

1. Read `docs/architecture/ADR-001-Modular-TKL-with-MCP.md`.
2. Read `docs/team/TKL-Team-Work-Plan.md`.
3. Read `docs/team/TKL-Phase-2-TestRail-Plan.md`.
4. Read `docs/team/TKL-Workstream-Implementation-Guide.md`.
5. Read `docs/team/TKL-Delivery-Backlog.md`.
6. Ask the contributor to identify themselves if their identity is not already explicit.
7. Match the supplied identity to the Team Directory.
8. Select the first `READY` task assigned to that contributor whose dependencies are
   `DONE`.
9. Summarize only the contributor's assigned workstream, selected task, dependencies,
   current milestone,
   acceptance criteria, and files they are expected to own.
10. Inspect the repository and current work before creating or modifying code.
11. Implement and verify the selected task instead of only explaining it.
12. Update the backlog task status and evidence in the same PR.
13. Do not assign work owned by another workstream unless the user explicitly requests
   cross-workstream support.
14. For shared-contract changes, involve Miguel Barajas and every affected workstream owner.
15. Keep all implementation artifacts, documentation, code, commits, and PR content in
   English.

## Identity Matching

Identity matching should tolerate:

- Different capitalization.
- Dots, spaces, hyphens, or underscores between names.
- Usernames that clearly contain the assigned first and last names.

If the identity is ambiguous or does not match the directory, request clarification rather
than guessing.

## Current Phase 2 Assignment by Contributor

### Miguel Barajas

Continue with:

- Repository architecture.
- Shared contracts and schemas.
- Plugin manifest and registry.
- Canonical ID strategy.
- Contract testkit.
- TestRail entity/configuration compatibility and integration handoffs.
- Contract tests covering TestRail evidence without source-specific core imports.

### Jorge Santiago

Continue with:

- Production-ready TestRail client adapter behind the existing connector contract.
- Environment/secret-reference configuration for base URL, project ID, and suite IDs.
- Suites, cases, runs, and results pagination and incremental checkpoints.
- Retry, idempotency, health, and sanitized connector fixtures.

### Josue Misael Torres

Continue with:

- TestRail suite, case, run, and result normalizers.
- Canonical manual-test and execution entities with full provenance.
- Jira requirement-to-TestRail case and TestRail-to-GitHub automation trace links.
- Manual coverage, execution freshness, conflict analysis, and generated Markdown output.

### Carlos Ramirez

Continue with:

- TKL Application API.
- Read-only MCP gateway.
- Strict tool/resource schemas.
- RBAC and product isolation.
- Audit logging and security controls.
- TestRail-aware query filters and provenance responses.
- Tests proving that TestRail credentials and cross-product data cannot reach agents.

### Clemente Herrera

Continue with:

- Connector health dashboard.
- Story traceability and coverage-gap views.
- Conflict and evaluation views.
- Golden dataset.
- Evaluation harness and stakeholder demo flow.
- TestRail connector-health, manual-coverage, and execution-result views/fixtures.
- Phase 2 golden scenarios that compare Jira requirements, TestRail cases, and GitHub
  automation.

## Shared First Milestone

All assignments converge on the same vertical slice:

```text
STT story
  + TestRail suites/cases/runs/results
  + GitHub automation evidence
  -> canonical requirements, tests, executions, and trace links
  -> TKL Application API
  -> read-only MCP story context and coverage analysis
  -> dashboard review
  -> optional generated Markdown export
```

## External Dependency Protocol

Development must continue with sanitized fixtures until live values are approved. When a
task genuinely requires live TestRail access, the agent must tell the current contributor
exactly which item is missing: base URL, project ID, suite IDs, custom field/status
mappings, read-only credential reference, or VPN/network access.

The agent must never ask for credential values in chat or store them in the repository.
The contributor must configure the value through an untracked environment file or the
approved secret manager and return only the reference or readiness status.

Request source access from the TKL project lead or the corresponding Jira, GitHub, or
TestRail system owner through an approved corporate channel. Request secret-manager
provisioning from the environment owner. If the owner or channel is unknown, record that
dependency explicitly and continue with sanitized fixtures rather than guessing.
