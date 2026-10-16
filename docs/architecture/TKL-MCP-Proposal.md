# Test Knowledge Library (TKL)
## Accepted Technical Proposal for Reusable Quality Context

> **Accepted direction:** Modular TKL with MCP as the solution architecture. Markdown is
> supported only as an optional generated export and review format.

> Based on patterns already proven in `vs-titling-qa-brain`, redesigned as a secure,
> traceable, multi-product platform that can be consumed through MCP.

---

## 1. Audit Outcome

The initiative addresses a real problem: Jira, TestRail, Confluence, GitHub, and
ReportPortal each contain different parts of quality knowledge, but there is no shared,
traceable representation that an agent can query.

The initial proposal had four material risks:

1. It made MCP a monolith responsible for connectors, ETL, storage, agents, dashboards,
   and secrets.
2. It allowed API keys and PATs to be captured in an HTML page and stored locally.
3. It represented knowledge as one YAML file per feature without distinguishing facts,
   inferences, conflicts, validity, provenance, and human approval.
4. It attempted to implement five connectors and five agents before proving that the
   retrieved knowledge improves a specific task.

### Revised decision

The solution should be a **TKL platform with an MCP interface**, not "an MCP that does
everything."

- **TKL Backend:** ingestion, normalization, traceability, search, versioning, and audit.
- **TKL MCP Gateway:** a thin facade that exposes tools and resources to agents.
- **Dashboard:** administration and observability; it neither stores nor displays secrets.
- **Agents:** consumers decoupled from the backend. The first agent is read-only.

MCP is the access contract for agents. It does not replace the data pipeline or knowledge
store.

---

## 2. What to Retain from `vs-titling-qa-brain`

The existing agent remains a useful reference:

| Existing pattern | Use in TKL |
|---|---|
| `scripts/jira-client.ts` | Starting point for the Jira connector, with pagination, rate limits, checkpoints, and idempotency added |
| `skills/features/*.md` | Example of per-feature context and human-readable knowledge |
| `skills/domain/*.md` | Basis for separating domain rules from operational instructions |
| `skills/knowledge-capture.md` | Reference for the proposal, review, and publication lifecycle |
| `dashboard.py` | Visual inspiration for the dashboard; it must not be reused as a credential store |
| `.github/agents/*.md` | Pattern for specialized consumer agents |

Patterns that should not be generalized:

- Hard-coded values for one project, board, product, or environment.
- Markdown files as the only queryable store.
- Personal PATs as the enterprise authentication model.
- Agent-inferred rules automatically published as truth.

---

## 3. Target Architecture

```text
 Jira       TestRail      Confluence      GitHub      ReportPortal
  |             |              |             |              |
  +-------------+--------------+-------------+--------------+
                                |
                 +--------------v--------------+
                 | Connector Workers           |
                 | - incremental sync          |
                 | - webhook + reconciliation  |
                 | - retries/rate limits       |
                 | - checkpoints/idempotency   |
                 +--------------+--------------+
                                |
                 +--------------v--------------+
                 | Raw Evidence Store          |
                 | source payload + hash + time|
                 | immutable/auditable         |
                 +--------------+--------------+
                                |
                 +--------------v--------------+
                 | Normalization and Curation  |
                 | entities, claims, links,    |
                 | conflicts, confidence       |
                 +--------------+--------------+
                                |
          +---------------------+----------------------+
          |                     |                      |
 +--------v---------+  +--------v---------+  +---------v--------+
 | Canonical Store  |  | Traceability     |  | Search Index     |
 | entities/claims  |  | Graph / edges    |  | keyword first;   |
 | temporal history |  | req-test-defect  |  | vector optional  |
 +--------+---------+  +--------+---------+  +---------+--------+
          +---------------------+----------------------+
                                |
                    +-----------v-----------+
                    | TKL Application API   |
                    | RBAC + audit + policy |
                    +-------+--------+------+
                            |        |
             +--------------v-+   +--v----------------+
             | TKL MCP Gateway |   | Admin Dashboard  |
             | tools/resources |   | config/status/QA |
             | read-only MVP   |   | no secret values |
             +----------+------+   +-------------------+
                        |
              +---------v----------------------------------+
              | Copilot / Claude / QA Agents               |
              | Coverage Analyst -> Test Designer -> others|
              +--------------------------------------------+
```

### Why MCP is separated

The MCP specification defines a protocol for exchanging context through tools, resources,
and prompts. It does not prescribe how that context is created or persisted. A separate
gateway enables TKL to:

- Reuse the backend from MCP, the dashboard, CI, and internal APIs.
- Scale ingestion independently from agent sessions.
- Apply RBAC and audit policy in one application layer.
- Prevent an MCP session from running long ETL jobs or directly manipulating storage.
- Change AI clients without rebuilding connectors.

For the MVP, these modules may run in one process. Their code-level boundaries and
contracts must remain explicit.

---

## 4. Modularity and Extensibility Requirements

Modularity is an architectural requirement, not a future refactor. TKL must support adding
a connector, normalizer, store, analyzer, MCP capability, or consumer agent without
editing the core orchestration. The core coordinates contracts; it must not contain
source-specific or analyzer-specific branching.

This does **not** require an MVP microservice architecture. The initial implementation
should use a modular monorepo and may deploy as one process with one database. Clean
interfaces, ownership, tests, and telemetry boundaries preserve the option to extract a
module only when scale, security, or operational evidence justifies it.

### 4.1 Plugin contracts

The exact language may change, but the responsibilities must remain stable:

```typescript
interface PluginManifest {
  id: string;                    // e.g. "connector.jira"
  version: string;               // independently versioned plugin
  contractVersion: string;       // supported TKL contract version
  capabilities: string[];        // e.g. "issues.read", "webhooks"
  configSchema: object;          // validated; never includes secret values
  requiredCredentialRefs?: string[];
}

interface SourceConnector {
  manifest(): PluginManifest;
  validateConfig(config: unknown): Promise<ValidationResult>;
  sync(context: SyncContext, checkpoint?: Checkpoint): AsyncIterable<RawEvidenceRecord>;
  health(context: HealthContext): Promise<PluginHealth>;
}

interface NormalizerExtractor {
  manifest(): PluginManifest;
  supports(record: RawEvidenceRecord): boolean;
  normalize(
    record: RawEvidenceRecord,
    context: NormalizationContext
  ): Promise<NormalizationResult>; // entities, claims, links, warnings
}

interface KnowledgeStore {
  manifest(): PluginManifest;
  saveEvidence(record: RawEvidenceRecord): Promise<void>;
  upsertCanonical(batch: CanonicalBatch): Promise<WriteResult>;
  query(request: KnowledgeQuery, auth: AuthContext): Promise<KnowledgeResult>;
  transact<T>(operation: StoreOperation<T>): Promise<T>;
}

interface SearchProvider {
  manifest(): PluginManifest;
  index(batch: SearchDocumentBatch): Promise<IndexResult>;
  search(request: SearchRequest, auth: AuthContext): Promise<SearchResult>;
}

interface Analyzer {
  manifest(): PluginManifest;
  supports(request: AnalysisRequest): boolean;
  analyze(
    request: AnalysisRequest,
    context: AnalysisContext
  ): Promise<AnalysisResult>; // findings must include evidence and provenance
}

interface McpCapabilityProvider {
  manifest(): PluginManifest;
  tools(): McpToolDefinition[];
  resources(): McpResourceDefinition[];
  invoke(
    capability: string,
    input: unknown,
    context: McpInvocationContext
  ): Promise<unknown>;
}

interface AgentConsumer {
  manifest(): PluginManifest;
  requiredCapabilities(): string[];
  execute(task: AgentTask, client: TklClient): Promise<AgentResult>;
}
```

`NormalizerExtractor` may be implemented as separate `Normalizer` and `Extractor`
interfaces if ownership or processing needs diverge. `KnowledgeStore` and
`SearchProvider` are separate because canonical persistence and retrieval/indexing have
different consistency and evolution needs, even if one database implements both in the
MVP.

### 4.2 Dependency inversion and orchestration

- Core use cases depend on the interfaces above, never on Jira, PostgreSQL, or a specific
  MCP SDK.
- Infrastructure plugins implement the interfaces and are injected at startup.
- Registries resolve plugins by manifest ID and declared capability, not by hard-coded
  `if source === "jira"` branches.
- Configuration controls which plugins are enabled for each environment, tenant, and
  product.
- The orchestration pipeline operates on `RawEvidenceRecord`, canonical entities, claims,
  trace links, and typed requests/results.
- Cross-cutting policies such as authorization, audit, redaction, retries, and telemetry
  wrap plugins consistently rather than being reimplemented by each plugin.

Illustrative enablement configuration:

```yaml
plugins:
  connectors:
    - id: connector.jira
      enabled: true
      products: [fl-titling]
      credentialRef: kv://tkl/prod/jira/fl-titling
  normalizers:
    - id: normalizer.jira-quality
      enabled: true
  stores:
    canonical: store.postgres
    search: search.postgres-fts
  analyzers:
    - id: analyzer.coverage
      enabled: true
  mcpCapabilities:
    - id: mcp.quality-read
      enabled: true
```

The configuration contains secret references only, never secret values.

### 4.3 Manifests, compatibility, and independent versioning

Each plugin ships a manifest declaring:

- Stable plugin ID, plugin version, and supported core contract version.
- Capabilities provided and permissions required.
- Configuration schema and required credential references.
- Input/output schema versions and migration notes.
- Data classifications handled and telemetry emitted.
- Ownership, support contact, and operational maturity.

Plugins are independently versioned. Contract evolution follows semantic versioning:
backward-compatible fields are additive; breaking changes require a new contract major
version and an explicit migration window. Startup fails safely when a plugin is
incompatible, duplicated, unauthorized, or missing a required capability.

### 4.4 Contract tests and quality gates

The repository provides reusable conformance suites for every contract:

- Connector tests cover pagination, checkpoints, idempotency, retries, rate limits,
  stable IDs, evidence hashes, classifications, and failure reporting.
- Normalizer tests verify deterministic canonical output, provenance preservation,
  conflict handling, tombstones, and untrusted-content treatment.
- Store/search tests verify tenant isolation, authorization filters, temporal behavior,
  indexing consistency, and explainable results.
- Analyzer tests verify evidence-backed findings, deterministic fixtures, uncertainty,
  and no unsupported promotion of inferred facts.
- MCP provider tests validate strict schemas, RBAC, audit events, bounded output, and safe
  error handling.
- Agent consumer tests verify declared capabilities, source citation, and adherence to
  read/write policy.

Every plugin must pass its contract suite plus plugin-owned tests before registration.
Golden-dataset tests validate behavior across module boundaries.

### 4.5 Why this boundary matters

Explicit contracts improve:

- **Maintainability:** source-specific changes remain local.
- **Ownership:** each team owns a module, manifest, tests, and operational health.
- **Observability:** metrics and traces identify the responsible plugin and version.
- **Traceability:** every claim and finding records the producing plugin, version, source,
  and processing run.
- **Extensibility:** a new connector or analyzer is registered through its manifest and
  configuration without changing core orchestration.
- **Risk control:** modules can be disabled, rolled back, or isolated independently.

### 4.6 Suggested modular monorepo

```text
tkl/
|-- apps/
|   |-- api/                    # TKL Application API composition root
|   |-- mcp-gateway/            # MCP transport and capability registry
|   `-- dashboard/              # Operations and review UI
|-- packages/
|   |-- contracts/              # Versioned interfaces, schemas, shared types
|   |-- core/                   # Use cases and orchestration; no vendor imports
|   |-- policy/                 # RBAC, redaction, classification, audit policy
|   |-- observability/          # Logs, metrics, traces, correlation IDs
|   |-- plugin-runtime/         # Manifests, registries, config, compatibility checks
|   `-- test-kits/              # Contract suites, fixtures, golden-dataset harness
|-- plugins/
|   |-- connectors/
|   |   |-- jira/
|   |   `-- github/
|   |-- normalizers/
|   |   |-- jira-quality/
|   |   `-- github-quality/
|   |-- stores/
|   |   `-- postgres/
|   |-- search/
|   |   `-- postgres-fts/
|   |-- analyzers/
|   |   `-- coverage/
|   |-- mcp-capabilities/
|   |   `-- quality-read/
|   `-- agents/
|       `-- coverage-analyst/
|-- config/
|   |-- base.yaml
|   |-- local.yaml
|   `-- environments/
|-- migrations/
|-- docs/
|   |-- adr/
|   `-- plugin-authoring/
`-- tests/
    |-- integration/
    |-- security/
    `-- golden/
```

Repository tooling should enforce dependency direction: plugins may depend on contracts
and approved shared utilities; core must not import plugin implementations.

### 4.7 Extension flow for a new module

Example: a team adds a TestRail connector or a new risk analyzer.

1. Select the relevant contract and capability IDs; propose a contract change only if the
   existing abstraction cannot represent the use case.
2. Create the plugin package with its manifest, owner, configuration schema, and
   credential references.
3. Implement the contract without editing core orchestration.
4. Add plugin fixtures and pass the shared contract test kit.
5. Add integration and golden-dataset cases, including provenance, security, failure, and
   telemetry expectations.
6. Register the plugin package in the build and enable it through environment/product
   configuration.
7. Deploy disabled or in shadow mode, observe health and output, then enable it for the
   pilot product.
8. Version and release the plugin independently; roll back by configuration if needed.

If adding a connector or analyzer requires a core `switch` statement, the extension has
violated the architecture and must be redesigned around the registry and contracts.

---

## 5. Revised Knowledge Model

A feature must not be one document that mixes confirmed facts, historical results, and
model inferences. The fundamental unit is a traceable **`Claim`**.

### Canonical entities

- `Product`
- `Feature`
- `Requirement`
- `BusinessRule`
- `TruthTableRow`
- `TestCase`
- `AutomationTest`
- `TestExecution`
- `Defect`
- `Release`
- `SourceArtifact`
- `Claim`
- `TraceLink`
- `ReviewDecision`

### Conceptual example

```yaml
claim:
  id: claim-fl-vessel-plate-001
  subject: feature:fl-create-deal-vessel
  predicate: requires
  object: field:registration-number
  value: true
  status: approved
  confidence: 1.0
  validFrom: 2026-08-01
  validTo: null
  observedAt: 2026-09-09T18:00:00Z
  approvedBy: qa-lead-id
  sources:
    - type: jira
      id: STT-4770
      version: "2026-09-08T14:21:30Z"
      contentHash: sha256:...
    - type: confluence
      id: page-123456
      version: "42"
      contentHash: sha256:...
```

### Model principles

1. **Provenance per claim:** a feature-level source list is insufficient.
2. **Temporality:** a rule may be valid before one release and invalid afterward.
3. **Visible conflicts:** when Jira and Confluence disagree, both claims are retained and
   the conflict is sent for review.
4. **Confidence is separate from approval:** a high-confidence inference is not an
   approved rule.
5. **Data is separate from instructions:** ingested text is never interpreted as an agent
   instruction.
6. **Soft deletes/tombstones:** source deletion retains history.
7. **Processor lineage:** normalized output records the plugin and contract versions that
   produced it.

### Recommended storage

For the MVP:

- SQLite is the implemented local/default single-node adapter; PostgreSQL remains the
  production scale-out target and is not yet implemented.
- Canonical tables for entities and claims.
- A `trace_links` table to represent the graph without introducing a graph database.
- Normalized conflict, review, deferred-link, provenance, migration-metadata, and
  operation-history tables with tenant/product scope on every row.
- Field-based and full-text search.
- YAML/Markdown export for human review and snapshots, not as the primary operational
  source.

After the pilot:

- Add a vector index only if evaluations prove that it improves retrieval.
- Add a graph database only if real multi-hop queries exceed `trace_links` capabilities.

This avoids introducing GraphRAG and vector storage before they are justified.

---

## 6. Ingestion and Synchronization

Every connector produces the same raw evidence contract:

```typescript
interface RawEvidenceRecord {
  tenantId: string;
  productId: string;
  source: "jira" | "testrail" | "confluence" | "github" | "reportportal";
  sourceId: string;
  sourceVersion: string;
  sourceUrl?: string;
  observedAt: string;
  contentType: string;
  contentHash: string;
  payload: unknown;
  classification: "internal" | "confidential" | "restricted";
  producerPluginId: string;
  producerPluginVersion: string;
}
```

### Mandatory connector requirements

- Pagination and explicit rate-limit handling.
- Incremental checkpoints by source/project.
- Idempotency using `source + sourceId + sourceVersion/contentHash`.
- Retries with exponential backoff and jitter.
- A dead-letter queue or visible record of unprocessed items.
- Webhooks where reliable, plus reconciliation polling.
- Freshness, error, and last-successful-checkpoint metrics.
- Sanitization and classification before indexing.
- Preservation of the original payload for audit.
- Compliance with the `SourceConnector` contract and shared conformance suite.

### Implementation order

1. Jira: requirements, stories, bugs, and relationships.
2. GitHub: automation specifications, PRs, and changes.
3. TestRail: cases, suites, runs, and results.
4. ReportPortal: launch/item history and existing classification.
5. Confluence: rules/documentation; added later because of greater noise, duplication, and
   indirect prompt-injection risk.

---

## 7. MCP Gateway

The MVP gateway is **read-only** and exposes specific operations rather than generic SQL,
URL, or shell access.

### Resources

- `tkl://products/{productId}/features/{featureId}`
- `tkl://requirements/{requirementId}`
- `tkl://traceability/{requirementId}`
- `tkl://sources/{source}/{sourceId}/provenance`

### Tools

| Tool | Purpose |
|---|---|
| `search_quality_knowledge` | Search features, requirements, tests, defects, and rules with filters |
| `get_story_test_context` | Build a traceable context package for a ticket |
| `analyze_requirement_coverage` | Identify requirements without linked tests or with stale evidence |
| `explain_traceability` | Explain why two artifacts are related, including sources |
| `list_knowledge_conflicts` | Show contradictory rules or rules awaiting approval |
| `get_test_failure_history` | Retrieve execution history and classification without automatically declaring a cause |

These capabilities are supplied through `McpCapabilityProvider` plugins. The gateway owns
transport, authentication, schema validation, policy, and audit; providers own bounded
business capabilities.

### Tools outside the MVP

- Create or modify TestRail cases.
- Modify Jira tickets.
- Create PRs or commits.
- Automatically mark a test as flaky.
- Publish a business rule without approval.
- Execute commands or query arbitrary URLs.

Write operations may be added later as independent tools with dedicated scopes, change
preview, human approval, and audit logs.

---

## 8. Security and Governance

### Credentials

The dashboard **must not request, display, or persist tokens**.

Valid options:

- Local development: environment-injected values or Windows Credential Manager.
- Shared service: Azure Key Vault, HashiCorp Vault, or another approved secret manager.
- Separate service accounts by connector and product.
- Read-only, least-privilege scopes during the MVP.
- Rotation, expiration, and access auditing.

A gitignored `.env` may be used for a local experiment, but it remains plaintext and is
not the enterprise secret-management mechanism.

### MCP authorization

- Local `stdio`: credentials come from the environment, not agent parameters.
- Remote Streamable HTTP: MCP-aligned OAuth, TLS, Protected Resource Metadata, minimum
  scopes, and audience/resource validation.
- A token used to call MCP must not be forwarded to Jira, GitHub, or another source.
- RBAC applies by user, product, and operation.
- Plugin capabilities are checked against their declared permissions before activation.

### AI risks

All content from Jira, Confluence, GitHub, TestRail, and ReportPortal is **untrusted**:

- It may contain indirect prompt injection.
- It may be stale or incorrect.
- It may include secrets or restricted information.
- It may attempt to induce an agent to call another tool.

Controls:

- Extract structured content; do not return raw HTML.
- Clearly label data versus instructions.
- Detect and quarantine suspicious patterns.
- Filter secrets and PII before indexing or logging.
- Validate input and output schemas with `additionalProperties: false`.
- Allowlist products, repositories, and hosts.
- Audit every tool call, user, filter, plugin version, and retrieved artifact.
- Do not log tokens or complete sensitive payloads.
- Require human confirmation for any future write action.

---

## 9. Coverage and Traceability

The ambiguous field `coverageScore: 82%` is removed.

TKL reports separate metrics:

| Metric | Definition |
|---|---|
| Requirement trace coverage | Approved requirements with at least one linked test |
| Automated requirement coverage | Requirements with at least one linked automation test |
| Execution freshness | Linked tests successfully executed within a defined window |
| Negative-path coverage | Requirements with at least one relevant negative case |
| Trace confidence | Link quality: explicit, inferred, or approved |
| Code coverage | External pipeline metric; not equivalent to test quality |
| Mutation score | Ability of tests to detect artificial changes, when the project already uses mutation testing |

An inferred link does not count the same as an explicit or approved link. The UI exposes
the numerator, denominator, and criteria for each metric.

Target traceability:

```text
Epic/Feature
  `-- Requirement / Acceptance Criterion
       |-- Manual Test Case
       |    `-- Test Run / Result
       |-- Automation Test
       |    `-- CI or ReportPortal Execution
       `-- Defect
            `-- Fix PR / Release
```

---

## 10. Flaky-Test Intelligence

TKL must not reimplement ReportPortal's auto-analyzer or declare a failure flaky after a
single execution.

It consumes:

- Result history by stable test identity.
- Reruns in the same commit/build.
- Code changes between results.
- Environment, browser, node, duration, and external dependencies.
- Existing defect type or classification from ReportPortal.
- Relationship to PRs and test/product changes.

Recommended states:

- `insufficient_evidence`
- `likely_product_defect`
- `likely_automation_defect`
- `likely_environment_issue`
- `likely_flaky`
- `confirmed_flaky`
- `human_review_required`

Only an approved policy or human review may promote `likely_flaky` to `confirmed_flaky`.
The result must include evidence, not only a score. Any flaky analyzer must implement the
`Analyzer` contract and preserve the evidence and plugin version behind each finding.

---

## 11. Agents and Quality Gates

### Recommended sequence

1. **Coverage and Traceability Analyst (MVP):** read-only; identifies gaps and explains
   sources.
2. **Test Designer:** proposes manual cases without automatically publishing them.
3. **Automation Designer:** creates a change in a branch/PR, never directly in `main`.
4. **Defect Intelligence:** correlates failures and historical defects.
5. **Knowledge Curator:** proposes merges, conflicts, and updates for approval.

Agents are `AgentConsumer` plugins. They depend on the stable TKL client and declared MCP
capabilities, not on storage or connector implementations.

### Gates for generated test cases

- Every case links requirements and sources.
- Preconditions, data, steps, and expected results are distinct.
- Applicable happy paths, negative paths, and boundaries are covered.
- TestRail duplicates are detected before a new case is proposed.
- A human approves before publication.

### Gates for generated automation

- Compiles/type-checks.
- Passes the target test and related tests.
- Passes repeated executions when flakiness risk exists.
- Reuses repository page objects, fixtures, and conventions.
- Introduces no secrets or known fragile selectors.
- Demonstrates incremental value: covered requirement, reproduced defect, meaningful
  assertion, additional coverage, or killed mutation.
- Is delivered as a PR for human review.

---

## 12. Revised Dashboard

The dashboard is an operations console, not a password manager.

### MVP views

- **Products:** active project/product and enabled sources.
- **Connector Health:** last sync, checkpoint, freshness, rate limits, and errors.
- **Traceability:** requirement -> manual test -> automation -> execution -> defect.
- **Coverage Gaps:** explainable, filterable gaps.
- **Conflicts:** contradictory claims or claims awaiting approval.
- **Audit:** MCP queries and review decisions, with sensitive-data redaction.
- **Evaluation:** golden-dataset results and human acceptance/rejection.
- **Plugins:** enabled plugin IDs, versions, capabilities, owners, compatibility, and
  health; never secret values.

### Visible configuration

References only:

- `credentialRef: kv://tkl/prod/jira/fl-titling`
- Status: `configured`, `expired`, or `unavailable`.
- Authorized scopes.
- Last validation.

The secret value is never returned to the browser.

---

## 13. Realistic MVP for Five People

### Scope

**Pilot product:** FL Titling.

**Sources:** Jira + GitHub.

**Demonstrable capability:** given a Jira ticket, retrieve requirements/acceptance
criteria, related automated tests, historical defects, and coverage gaps with source
traceability.

**Consumer:** one read-only Coverage and Traceability Analyst.

**Initial deployment:** local or controlled internal environment. Use one process where
practical, while preserving contracts compatible with a later remote service or selective
module extraction.

### MVP non-goals

- Do not create five agents.
- Do not write to Jira, TestRail, or GitHub.
- Do not manage tokens through the dashboard.
- Do not use a graph database or vector database by default.
- Do not generate a definitive truth table solely with AI.
- Do not include all five connectors.
- Do not perform automatic regression selection for releases.
- Do not automatically classify failures as flaky.
- Do not split every module into a separately deployed service.
- Do not build a dynamic third-party plugin marketplace; the MVP registry loads reviewed,
  first-party packages from the monorepo.

### Six-week plan

| Week | Outcome |
|---|---|
| 1 | Architecture, threat model, versioned plugin contracts, `RawEvidenceRecord`, canonical entities, IDs, and golden dataset |
| 2 | Jira plugin incremental sync + raw evidence + checkpoint/idempotency + connector contract tests |
| 3 | GitHub plugin ingestion + normalization + explicit ticket/test/PR links |
| 4 | Canonical store + traceability queries + conflicts/provenance + analyzer contract |
| 5 | Read-only MCP capability provider + Coverage Analyst + health/traceability dashboard |
| 6 | Golden-dataset evaluation, security hardening, plugin observability, demo, and TestRail go/no-go decision |

---

## 14. Team Split

Splitting the team only by connector would create silos and defer integration, security,
and evaluation. The revised split assigns vertical ownership:

| Person | Primary ownership | Deliverables |
|---|---|---|
| **1. Architecture and Contracts Lead** | Architecture, canonical model, plugin contracts, ADRs, integration | Contracts, IDs, schemas, compatibility policy, storage decisions, final integration |
| **2. Ingestion Engineer** | Jira/GitHub plugins and raw evidence | Incremental sync, checkpoints, idempotency, rate limits, connector health |
| **3. Knowledge and Traceability Engineer** | Normalization, claims, links, conflicts, store/search plugins | Canonical store, provenance, trace queries, coverage definitions |
| **4. MCP and Security Engineer** | Application API, MCP gateway/provider, auth/RBAC/audit | Read-only tools/resources, strict schemas, policies, audit trail |
| **5. UX and Evaluation Engineer** | Dashboard, golden dataset, test kits, and measurement | Health/traceability/gap UI, plugin status, evaluation harness, acceptance metrics |

### Ways of working

- All five people agree on contracts and the golden dataset in week one.
- Person 1 reviews integration but does not become a bottleneck.
- Persons 2 and 3 pair on the first Jira -> requirement -> trace flow.
- Persons 4 and 5 develop against contract fixtures until the backend is available.
- Module owners maintain manifests, contract tests, dashboards, and runbooks.
- Each week ends with one integrated demo, not five isolated demos.

---

## 15. Evaluation and Success Criteria

Before building generative agents, create a **golden dataset** of 20-30 representative
tickets reviewed by product QAs:

- Expected requirements/acceptance criteria.
- Related manual and automated tests.
- Relevant defects.
- Relationships that must not exist.
- Known gaps.

### MVP metrics

| Metric | Initial target |
|---|---|
| Precision of retrieved links | >= 90% |
| Recall of known links | >= 80% |
| Responses with verifiable provenance | 100% |
| Published claims without a source | 0 |
| Time to generate ticket context | < 10 seconds after synchronization |
| Jira/GitHub freshness | < 24 hours in batch; lower if webhooks are enabled |
| QA acceptance of identified gaps | >= 70% |
| Cross-product data-leakage incidents | 0 |
| Enabled plugins passing contract suites | 100% |
| Findings with producer plugin/version lineage | 100% |

Operational metrics are segmented by plugin ID and version: throughput, latency, error
rate, retry count, checkpoint lag, rejected records, and trace correlation ID.

Also measure a human task:

> Time and quality of impact/coverage analysis for a ticket with and without TKL.

If TKL does not measurably improve that task, do not add more connectors or agents.

---

## 16. Evolution After the MVP

### Phase 2 - TestRail

- Cases, suites, runs, and results.
- Duplicate detection.
- Requirement <-> manual-test traceability.
- Test Designer in proposal mode.
- TestRail added as a connector/normalizer plugin without core orchestration changes.

### Phase 3 - ReportPortal

- Execution history.
- Failure correlation.
- Reuse of existing classification/auto-analysis.
- Evidence for flaky-test auditing.

### Phase 4 - Confluence and semantic search

- Selective ingestion of approved spaces/pages.
- Claims with human review.
- Keyword versus hybrid/vector retrieval evaluation.
- Proposed truth table, never automatically published.

### Phase 5 - Actions and automation

- Write tools with separate scopes.
- Preview/dry-run.
- Human approval.
- Test/Automation Designer with quality gates.
- PR-based knowledge changes and versioned library releases.

Every phase extends the platform through reviewed plugins, capabilities, and configuration.
Deployment boundaries may change only when measurements justify separate scaling or
isolation.

---

## 17. Final Recommendation

The strongest version of this initiative is not a universal agent that stores tokens and
queries five systems in real time. It is a **trusted quality knowledge layer** with:

- Incremental, auditable ingestion.
- A canonical model of claims and relationships.
- Traceability to source and processor version.
- Separation of facts, inferences, and human decisions.
- A central API with security and governance.
- A thin MCP interface that any authorized agent can consume.
- Contract-based plugins that can be enabled without changing core orchestration.
- A pragmatic modular monorepo and single-process MVP, not premature microservices.
- Objective evaluation before scope expansion.

The proposal should be presented as:

> **Build a trusted Quality Context Platform once, expose it through MCP, and reuse it
> across agents and products.**

---

## 18. Sources

- Model Context Protocol, Architecture:
  https://modelcontextprotocol.io/docs/learn/architecture
- Model Context Protocol, Authorization:
  https://modelcontextprotocol.io/specification/draft/basic/authorization
- OWASP MCP Security Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
- OWASP LLM06:2025 Excessive Agency:
  https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- OWASP Top 10 for LLM Applications:
  https://genai.owasp.org/llm-top-10/
- OAuth 2.0 Protected Resource Metadata, RFC 9728:
  https://datatracker.ietf.org/doc/html/rfc9728
- OAuth 2.0 Security Best Current Practice, RFC 9700:
  https://datatracker.ietf.org/doc/html/rfc9700
- ISO/IEC/IEEE 29119-3:2021, Test Documentation:
  https://www.iso.org/standard/79429.html
- Automated Unit Test Improvement using Large Language Models at Meta:
  https://arxiv.org/abs/2402.09171
- ReportPortal documentation:
  https://reportportal.io/docs/
- ReportPortal Auto Analyzer:
  https://github.com/reportportal/service-auto-analyzer
