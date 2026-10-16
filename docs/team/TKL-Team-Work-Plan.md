# TKL Team Work Plan
## Ownership, Integration Contracts, and Delivery Rules

## 1. Objective

This document defines how five team members can develop the TKL MVP in parallel without
creating isolated components, duplicated logic, or integration friction.

The delivery baseline is:

- Pilot product: FL Titling.
- Initial sources: Jira and GitHub.
- Primary capability: story context, traceability, and coverage-gap analysis.
- First consumer: read-only Coverage and Traceability Analyst.
- Architecture: modular monorepo with a thin MCP gateway.
- Markdown: optional generated export only.

The active milestone is **Phase 2: TestRail knowledge integration**. It adds suites,
cases, runs, and results to the existing Jira/GitHub flow. Live connection values remain
external and are not required for fixture-based development.

## 2. Team Ownership

Each person owns one workstream and its contracts, tests, documentation, health signals,
and integration support.

| Owner | Workstream | Primary responsibility | MVP output |
|---|---|---|---|
| **Miguel Barajas** | Architecture and Contracts | Protect module boundaries and define shared schemas | Core contracts, canonical IDs, plugin registry, ADRs, integration baseline |
| **Jorge Santiago** | Source Ingestion | Collect Jira, GitHub, and TestRail evidence reliably | Source connector plugins, checkpoints, retries, raw evidence |
| **Josue Misael Torres** | Knowledge and Traceability | Convert evidence into trusted, connected knowledge | Normalizers, canonical entities, claims, trace links, coverage analysis |
| **Carlos Ramirez** | API, MCP, and Security | Expose controlled capabilities to agents | Application API, read-only MCP tools/resources, RBAC, audit |
| **Clemente Herrera** | Dashboard and Evaluation | Make the platform observable and prove its value | Health/traceability dashboard, golden dataset, evaluation harness |

No owner works only on an isolated folder. Every owner is responsible for the complete
quality of the capability they deliver.

### Phase 2 TestRail responsibilities

| Owner | Phase 2 responsibility | Required handoff |
|---|---|---|
| **Miguel Barajas** | TestRail contract/configuration compatibility and integration baseline | Versioned evidence/config contracts and cross-workstream contract tests |
| **Jorge Santiago** | TestRail client adapter, configuration, sync, checkpoints, retries, health, and fixtures | Sanitized `RawEvidenceRecord` streams for suites, cases, runs, and results |
| **Josue Misael Torres** | TestRail normalization, canonical manual tests/executions, and cross-source links | Queries and analyzer output for API/dashboard consumers |
| **Carlos Ramirez** | TestRail-aware API/MCP responses, source filtering, isolation, audit, and secret exclusion | Read-only validated endpoints/tools backed by the application layer |
| **Clemente Herrera** | TestRail health, manual coverage, execution freshness, and evaluation scenarios | Repeatable Phase 2 fixtures, metrics, and stakeholder flow |

The detailed sequence, dependencies, and acceptance criteria are in
`TKL-Phase-2-TestRail-Plan.md`.

---

## 3. Detailed Responsibilities

### Miguel Barajas: Architecture and Contracts

#### Owns

- Modular monorepo structure.
- Shared TypeScript contracts.
- Canonical identifier strategy.
- Plugin manifest and registry.
- Configuration model.
- Architecture Decision Records.
- Compatibility and versioning policy.
- Integration branch health.

#### Deliverables

- `RawEvidenceRecord`
- `CanonicalEntity`
- `Claim`
- `TraceLink`
- `PluginManifest`
- `SourceConnector`
- `Normalizer`
- `Analyzer`
- `KnowledgeStore`
- `McpCapabilityProvider`
- Shared error and result types.
- Contract test harness.

#### Does not own

- Jira or GitHub business logic.
- Coverage calculation implementation.
- MCP tool implementation.
- Dashboard UI.

#### Acceptance criteria

- Source-specific modules depend on shared contracts.
- Core orchestration never imports Jira- or GitHub-specific code directly.
- A fixture connector can be registered through configuration.
- Contract changes are versioned and reviewed by affected owners.

---

### Jorge Santiago: Source Ingestion

#### Owns

- Jira connector plugin.
- GitHub connector plugin.
- TestRail connector plugin.
- Authentication adapters and credential references.
- Pagination and rate-limit handling.
- Incremental synchronization.
- Checkpoint and retry behavior.
- Raw evidence persistence interface usage.
- Connector health reporting.

#### Deliverables

- Jira stories, epics, acceptance criteria, bugs, links, and versions.
- GitHub repositories, test specs, pull requests, changed files, and ticket references.
- TestRail suites, cases, runs, results, and incremental checkpoints.
- Idempotent `RawEvidenceRecord` output.
- Source fixtures and connector contract tests.
- Documented permissions and API scopes.

#### Does not own

- Deciding whether two requirements mean the same thing.
- Calculating coverage.
- Returning data directly to an agent.
- Storing tokens in configuration files or the dashboard.

#### Acceptance criteria

- Re-running the same sync creates no duplicate evidence.
- Interrupted sync resumes from the last valid checkpoint.
- Rate limits and transient failures are visible and retried safely.
- Every raw record includes source, source ID, version, timestamp, hash, product, and
  classification.
- Connectors can be disabled or replaced through configuration.

---

### Josue Misael Torres: Knowledge and Traceability

#### Owns

- Source normalizers.
- Canonical knowledge entities.
- Claims, provenance, confidence, validity, and approval status.
- Requirement-to-test-to-defect relationships.
- Conflict detection.
- Coverage definitions and analyzers.
- Markdown export from approved knowledge.

#### Deliverables

- Jira, GitHub, and TestRail normalizers.
- Canonical store implementation.
- Trace-link repository.
- Coverage and conflict analyzers.
- Queries needed by the API and MCP workstream.
- Generated human-readable feature/story export.

#### Does not own

- Fetching source APIs.
- Agent prompts.
- Authentication or RBAC.
- Manually maintained Markdown as source knowledge.

#### Acceptance criteria

- Every canonical fact can be traced to raw evidence.
- Inferences are distinguishable from explicit source links.
- Conflicting claims remain visible until reviewed.
- Coverage results expose their numerator, denominator, and link confidence.
- Markdown is generated from canonical approved knowledge.

---

### Carlos Ramirez: API, MCP, and Security

#### Owns

- TKL Application API.
- Thin MCP gateway.
- Strict tool and resource schemas.
- Authentication and authorization boundaries.
- Product/tenant isolation.
- Audit logging.
- Input/output validation.
- Read-only agent access for the MVP.

#### Deliverables

- `search_quality_knowledge`
- `get_story_test_context`
- `analyze_requirement_coverage`
- `explain_traceability`
- `list_knowledge_conflicts`
- MCP resources for stories, requirements, and provenance.
- Audit events for every MCP operation.
- Security threat model and permission matrix.

#### Does not own

- Connecting directly to Jira or GitHub.
- Knowledge normalization.
- Dashboard secret management.
- Write operations during the MVP.

#### Acceptance criteria

- MCP capabilities call the application layer, never source APIs directly.
- Strict schemas reject undeclared or invalid parameters.
- A user cannot retrieve another product's knowledge.
- Tool responses include provenance and never include credentials.
- Every operation is auditable.
- No generic SQL, shell, filesystem, or arbitrary URL tools exist.

---

### Clemente Herrera: Dashboard and Evaluation

#### Owns

- Operations dashboard.
- Golden dataset.
- Evaluation harness and metrics.
- End-to-end MVP scenarios.
- Human-review feedback capture.
- Demo data and stakeholder presentation flow.

#### Deliverables

- Connector health page.
- Story traceability page.
- Coverage-gap page.
- Knowledge-conflict page.
- Audit/evaluation view.
- Golden dataset of 20-30 representative FL Titling tickets.
- Precision, recall, provenance, freshness, latency, and QA-acceptance reports.

#### Does not own

- Collecting or storing credential values.
- Defining source-specific API behavior.
- Creating alternate knowledge models in the UI.
- Publishing generated cases automatically.

#### Acceptance criteria

- The dashboard displays credential references/status, never token values.
- Evaluation results are repeatable from committed fixtures.
- Incorrect links and missing links are measured separately.
- Stakeholders can follow one ticket from source evidence to final recommendation.
- QA feedback is captured as approve, reject, or needs correction.

---

## 4. Shared Integration Contracts

These contracts must be approved before source-specific implementation begins.

```typescript
interface PluginManifest {
  id: string;
  version: string;
  contractVersion: string;
  capabilities: string[];
  requiredPermissions: string[];
}

interface RawEvidenceRecord {
  tenantId: string;
  productId: string;
  source: string;
  sourceId: string;
  sourceVersion: string;
  sourceUrl?: string;
  observedAt: string;
  contentType: string;
  contentHash: string;
  payload: unknown;
  classification: "internal" | "confidential" | "restricted";
}

interface SourceConnector {
  manifest: PluginManifest;
  validateConfiguration(): Promise<ValidationResult>;
  collect(checkpoint?: SyncCheckpoint): AsyncIterable<RawEvidenceRecord>;
  health(): Promise<ConnectorHealth>;
}

interface Normalizer {
  supports(record: RawEvidenceRecord): boolean;
  normalize(record: RawEvidenceRecord): Promise<NormalizationResult>;
}

interface Analyzer<TInput, TOutput> {
  manifest: PluginManifest;
  analyze(input: TInput): Promise<TOutput>;
}
```

### Contract ownership

- Miguel Barajas owns the contracts.
- All affected owners approve breaking changes.
- Implementations may extend data through versioned metadata but may not add hidden
  source-specific requirements to shared interfaces.

---

## 5. Recommended Repository Boundaries

```text
tkl/
|-- apps/
|   |-- api/
|   |-- mcp-gateway/
|   `-- dashboard/
|-- packages/
|   |-- contracts/
|   |-- core/
|   |-- plugin-registry/
|   |-- knowledge-store/
|   |-- testkit/
|   `-- markdown-export/
|-- plugins/
|   |-- connectors/
|   |   |-- jira/
|   |   `-- github/
|   |-- normalizers/
|   |   |-- jira/
|   |   `-- github/
|   `-- analyzers/
|       |-- coverage/
|       `-- conflicts/
|-- tests/
|   |-- contract/
|   |-- integration/
|   |-- e2e/
|   `-- fixtures/
|-- docs/
|   |-- architecture/
|   |-- adr/
|   |-- api/
|   `-- runbooks/
`-- config/
    `-- products/
```

This repository uses these boundaries as its initial scaffold. Individual packages are
activated only when their owning workstream begins implementation.

---

## 6. Development Sequence and Dependencies

```text
Miguel: Contracts + testkit + registry
     |
     +----------+------------------+-------------------+
     |          |                  |                   |
Jorge        Josue              Carlos              Clemente
Connectors   Knowledge          API/MCP             UI/Evaluation
     |          |                  |                   |
     +----------+------------------+-------------------+
                         |
                  Integrated vertical slice
                         |
        Jira story -> GitHub tests -> coverage report
```

### Parallel work rule

- Miguel provides versioned contracts and fixtures first.
- Jorge, Josue, Carlos, and Clemente develop against those contracts and shared fixtures.
- No team waits for a live downstream module when a contract test double can be used.
- Integration happens continuously, not during the final week.

---

## 7. Pull Request and Integration Rules

### Branch and PR scope

- One coherent capability per PR.
- Keep PRs small enough to review in one session.
- Do not combine refactoring, dependency upgrades, and feature behavior unless required.
- Every PR identifies its owning workstream and affected contracts.

### Required PR content

- Problem and expected behavior.
- Architectural/module impact.
- Contract changes, if any.
- Security and data-classification impact.
- Validation performed.
- Evidence or screenshots for user-visible changes.
- Follow-up work explicitly excluded from the PR.

### Required checks

- Formatting/linting already configured by the repository.
- Type-check/build.
- Unit tests.
- Contract tests for plugin implementations.
- Targeted integration tests.
- Secret scanning and dependency/security checks available in the repository.

### Review requirements

| Change | Required reviewers |
|---|---|
| Shared contract | Miguel plus every affected owner |
| Connector | Jorge plus Miguel |
| Knowledge schema/migration | Josue plus Miguel |
| API/MCP/security policy | Carlos plus Miguel |
| Dashboard/evaluation metric | Clemente plus relevant data owner |
| Cross-cutting feature | At least two workstream owners |

### Merge rules

- No direct commits to the protected main branch.
- No unresolved review comments.
- No broken contract or integration tests.
- No committed `.env`, credentials, generated reports, `node_modules`, test results, or
  local databases.
- Squash or merge policy must be selected once and applied consistently.

---

## 8. Definition of Done

A capability is done only when:

1. Its contract and expected behavior are documented.
2. Inputs and outputs use shared schemas.
3. Errors are explicit and observable.
4. Unit and contract tests pass.
5. At least one integration path is tested.
6. Security and product isolation are considered.
7. Logs and metrics are available without exposing sensitive data.
8. Documentation and runbook are updated.
9. The capability is registered through configuration.
10. The integrated MVP scenario continues to work.

Code existing in a folder is not sufficient evidence of completion.

---

## 9. Shared Engineering Requirements

### Modularity

- Depend on interfaces from `packages/contracts`.
- No circular dependencies.
- No connector imports from agents, MCP tools, or the dashboard.
- New plugins are registered through manifests/configuration.

### Traceability

- Every knowledge record links to raw evidence.
- Every transformation records the responsible plugin and version.
- Every agent response includes the source relationships it used.
- Human decisions preserve reviewer, timestamp, and reason.

### Security

- No secrets in source control, logs, fixtures, screenshots, Markdown, or browser storage.
- Use credential references and minimum read-only scopes.
- Treat all ingested content as untrusted.
- Validate every boundary.
- Deny cross-product access by default.

### Reliability

- Sync is idempotent and resumable.
- Retries are bounded and observable.
- Failed records are not silently discarded.
- Migrations and contract versions are backward-compatible or explicitly coordinated.

### Evaluation

- Features are evaluated against the shared golden dataset.
- Do not claim improvement without measured results.
- Precision and recall are both required; a high number of returned links is not success.

---

## 10. First Integrated Milestone

The first milestone is complete when the team can demonstrate:

```text
1. Select STT-XXXX.
2. Retrieve the Jira story and acceptance criteria.
3. Find GitHub tests and PRs with explicit or approved relationships.
4. Store all evidence with source versions and hashes.
5. Build canonical requirements and trace links.
6. Call get_story_test_context through MCP.
7. Display covered and uncovered requirements.
8. Explain every result with provenance.
9. Review the result in the dashboard.
10. Export an optional Markdown summary.
```

This vertical slice is the shared integration target for all five workstreams.
