# TKL Phase 2: TestRail Knowledge Integration

## Goal

Add TestRail as a read-only quality source so the TKL can relate requirements, manual
tests, automated tests, and execution history without changing the accepted modular
architecture.

```text
Jira requirements
  + TestRail suites, cases, runs, and results
  + GitHub automated tests and pull requests
  -> canonical knowledge and traceability
  -> application API
  -> thin read-only MCP gateway
  -> dashboard and agent consumers
```

## Scope

Phase 2 includes:

- TestRail suites, cases, runs, and results.
- Incremental, resumable, idempotent ingestion.
- Canonical manual-test and execution knowledge.
- Jira-to-TestRail and TestRail-to-GitHub traceability.
- Manual, automated, and execution coverage context.
- API, MCP, dashboard, and evaluation support for TestRail-derived knowledge.
- Sanitized fixtures that allow development before live access is available.

Phase 2 does not include:

- Creating or modifying TestRail artifacts.
- Storing credentials in the repository, dashboard, MCP responses, fixtures, or logs.
- Allowing source connectors to bypass the application layer.
- Treating generated Markdown as operational knowledge.
- Blocking fixture-based development while live connection values are pending.

## Workstream Assignments

### Miguel Barajas - Architecture and Contracts

Deliver:

- Verify that shared evidence, entity, claim, trace-link, manifest, checkpoint, and health
  contracts cover TestRail without source-specific core changes.
- Define non-secret TestRail product configuration and versioning rules.
- Add cross-workstream contract fixtures/tests for suite, case, run, and result evidence.
- Protect the integration baseline and coordinate incompatible contract changes.

Done when:

- TestRail modules use shared contracts and the plugin registry.
- Live values are injected through configuration/credential references.
- All affected owners agree on the canonical TestRail handoff.

### Jorge Santiago - Source Ingestion

Deliver:

- Complete the TestRail API client adapter behind `TestRailConnector`.
- Resolve base URL, project ID, optional selected-suite scope, and credentials outside
  connector business logic.
- Preserve pagination, incremental checkpoints, retries, idempotency, and health.
- Maintain sanitized fixtures and connector/contract tests.
- Document least-privilege TestRail permissions and operational troubleshooting.

Done when:

- Suites, cases, runs, and results emit valid `RawEvidenceRecord` objects.
- Interrupted sync resumes without duplicate evidence.
- No credential value appears in records, errors, metrics, fixtures, or logs.

### Josue Misael Torres - Knowledge and Traceability

Deliver:

- Normalize TestRail suites, cases, runs, and results.
- Model manual tests and executions as canonical entities/claims with provenance.
- Link Jira requirements to TestRail cases using explicit references first.
- Link TestRail cases to GitHub automated tests when explicit or reviewed evidence exists.
- Extend coverage/conflict analysis and Markdown export with TestRail context.

Done when:

- Every TestRail-derived fact resolves to raw evidence.
- Explicit and inferred links remain distinguishable.
- Coverage exposes manual, automated, and recent-execution evidence separately.

### Carlos Ramirez - API, MCP, and Security

Deliver:

- Expose TestRail-derived knowledge through the existing application service.
- Support source/provenance filters without adding direct TestRail calls.
- Preserve strict schemas, product/tenant isolation, read-only authorization, and audit.
- Add tests proving credentials and out-of-scope product data cannot reach consumers.

Done when:

- API/MCP consumers receive TestRail context only through canonical knowledge.
- Every operation is validated, scoped, and audited.
- No new generic or write-capable tool is introduced.

### Clemente Herrera - Dashboard and Evaluation

Deliver:

- Add TestRail connector-health and pending-configuration states.
- Show manual coverage, automated coverage, and execution freshness independently.
- Extend golden scenarios across Jira requirements, TestRail cases, and GitHub tests.
- Measure link precision/recall, provenance completeness, freshness, and QA acceptance.

Done when:

- Dashboard fixtures never contain credentials.
- Stakeholders can trace one requirement through manual test, automation, and execution.
- Evaluation results are repeatable from committed sanitized fixtures.

## External Input Required

The team can complete contracts, adapters, normalization, fixtures, UI states, and tests
without live access. A contributor or agent should request external input only when live
validation or enablement requires:

| Required input | Approved handling |
|---|---|
| TestRail base URL | Non-secret environment/configuration value |
| Project ID | Non-secret environment/configuration value |
| Optional selected suite IDs | Non-secret configuration used only when a project is shared |
| Custom field mappings | Reviewed non-secret configuration |
| Status mappings | Reviewed non-secret configuration |
| API credential | Read-only secret-manager/environment reference; never the value |
| VPN/network access | Contributor confirms readiness; no access material in repository |

The agent must state exactly which item is missing and why. It must never ask a
contributor to paste a token, password, API key, cookie, or secret into chat or a file.
Requests must go through the TKL project lead or TestRail system owner using an approved
corporate channel. Secret provisioning belongs to the environment/secret-manager owner.
If those contacts are unknown, record the dependency and continue with sanitized
fixtures.

## Enablement Gate

Live TestRail sync remains disabled until:

1. The base URL, project ID, and project-wide or selected-suite scope are approved.
2. Field and status mappings are reviewed.
3. A least-privilege credential reference is configured.
4. Connector health succeeds from the approved network.
5. A sanitized dry run confirms pagination, checkpointing, and record classification.
6. Existing Jira/GitHub contract and integration tests remain green.

## Phase 2 Shared Scenario

For one representative FL Titling story, the integrated solution must:

1. Retrieve Jira requirements and acceptance criteria.
2. Find linked TestRail cases and their latest relevant execution results.
3. Find linked GitHub automated tests or identify that automation is missing.
4. Report manual, automated, and execution coverage separately.
5. Explain every link using provenance and confidence.
6. Expose the result through the API, MCP gateway, and dashboard without source
   credentials.
