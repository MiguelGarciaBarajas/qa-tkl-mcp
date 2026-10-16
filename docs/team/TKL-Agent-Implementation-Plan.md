# TKL Agent Implementation Plan

## Delivery rule

Agents are delivered one phase at a time. Each phase must pass its automated checks,
produce an auditable browser workflow, and be tested by the FL QA stakeholder before the
next phase starts. A later agent may reuse an approved earlier capability, but it may not
bypass the TKL Application API, canonical knowledge, provenance, or review policy.

The capability audit and product rationale are documented in
[`../analysis/TKL-Product-Capability-Audit.md`](../analysis/TKL-Product-Capability-Audit.md).

## Shared agent contract

Every agent result must contain:

- Agent ID and version.
- Unique run ID and generation timestamp.
- Tenant/product scope and requested work-item scope.
- Status and confidence with a written rationale.
- Evidence-backed findings.
- Proposed actions with rationale.
- Source citations and versions.
- Known limitations and missing sources.
- No source-system credentials or hidden prompts.

Agents are proposal/read-only capabilities until Phase 8. They must not silently publish
tests, modify automation, resolve conflicts, or classify a test as confirmed flaky.

## Phase sequence

| Phase | Agent/capability | Primary outcome | Entry gate | Exit gate |
|---|---|---|---|---|
| 1 | Coverage & Context Analyst | Explain Jira scope, hierarchy, linked tests, executions, gaps, confidence, and missing evidence | Canonical Jira search and coverage/traceability queries | API and dashboard run produce cited findings and explicit limitations |
| 2 | Test Designer | Propose new manual cases from approved requirements and risks | Phase 1 accepted; TestRail cases synchronized | Structured drafts, duplicate checks, evidence mapping, QA review state |
| 3 | TestRail Improvement | Improve existing cases without duplicating intent | Phase 2 accepted; TestRail field/status mapping approved | Case-quality findings and edit proposals with before/after diff |
| 4 | Automation Designer | Propose repository-compliant automation from approved cases/gaps | Phase 2 accepted; repositories synchronized and framework indexed | File plan/code proposal, reused components, targeted validation, review-only delivery |
| 5 | Reliability & Defect Intelligence | Classify repeated failures and propose automation/product/environment improvements | ReportPortal history and stable test identity available | Evidence-backed classification; no single-run flaky claims; review workflow |
| 6 | Knowledge Curator | Propose mappings, merges, stale-rule updates, and conflict resolutions | Earlier agent evidence contracts stable | Reviewable knowledge changes with provenance and no automatic publication |
| 7 | Ask TKL | Answer product and QA questions by orchestrating approved tools | Phases 1-6 accepted and evaluated | Grounded answers with citations, freshness, confidence, conflicts, and abstention |
| 8 | Approved write actions (safe blocked mode complete) | Publish TestRail changes and create GitHub branches/PRs | Read-only phases accepted; separate service credentials and policies approved | Preview, explicit approval, least privilege, audit record, rollback/recovery |

## Phase 1 - Coverage & Context Analyst

### Scope

The first agent is deliberately read-only. It proves the reusable agent contract before
generative or write capabilities are introduced.

Input:

- Product scope.
- Jira work-item key.

Output:

- Jira hierarchy already present in canonical knowledge.
- Linked TestRail manual tests.
- Linked GitHub automation.
- Linked TestRail/ReportPortal execution evidence.
- Coverage and freshness gaps.
- Confidence rationale.
- Missing-source limitations.
- Recommended next actions.

### Implementation

- Agent: `apps/api/src/agents/coverage-context-agent.js`
- Endpoint: `POST /v1/agents/coverage-context/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `coverage:read`
- Mode: read-only

### Acceptance criteria

1. Invalid or out-of-scope requests fail before agent execution.
2. A missing ticket produces `not-found`, not a fabricated answer.
3. Jira-only evidence produces low confidence and lists missing TestRail, GitHub, and
   ReportPortal evidence.
4. Cross-source tests remain visible when Jira is the root source.
5. Findings carry evidence IDs and recommendations explain their rationale.
6. The endpoint is covered by the existing API audit event.
7. The dashboard displays result status, confidence, findings, actions, limitations, and
   citations.

## Phase 2 - Test Designer

### Scope

The Test Designer is proposal-only. It converts explicit Jira acceptance criteria into
reviewable manual test drafts and uses a Jira description only as a low-confidence fallback.
For epics, each proposal remains attributed to the contained requirement that supplied the
evidence.

### Implementation

- Agent: `apps/api/src/agents/test-designer-agent.js`
- Endpoint: `POST /v1/agents/test-designer/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `coverage:read`
- Mode: proposal-only

The duplicate guard compares every draft with all synchronized TestRail manual tests in the
product, including cases that do not yet have a Jira trace link. Open claim conflicts and
non-text Jira fields are excluded and reported as limitations. Generated actions are marked as
reviewer placeholders rather than asserted product steps, and no TestRail write path exists.

### Acceptance criteria

1. A missing Jira work item produces `not-found`.
2. Acceptance-criteria drafts retain requirement IDs, confidence, and citations.
3. Description-only fallbacks are low confidence and explicitly limited.
4. Likely TestRail duplicates produce `review-existing`, not `propose-new`.
5. Epic drafts use only the requested hierarchy and identify their source child requirement.
6. Unresolved claim conflicts are excluded from grounding.
7. The dashboard exposes proposal confidence, placeholders, duplicate candidates, evidence,
   citations, and limitations.
8. No source-system write is available.

## Phase 3 - TestRail Improvement

### Scope

The TestRail Improvement agent is proposal-only. It inspects synchronized TestRail cases
explicitly linked to an exact Jira ticket or epic scope. It reports missing preconditions,
incomplete steps or expected results, overly broad requirement mappings, and likely duplicate
intent only when canonical evidence supports the finding.

### Implementation

- Agent: `apps/api/src/agents/testrail-improvement-agent.js`
- Endpoint: `POST /v1/agents/testrail-improvement/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `coverage:read`
- Mode: proposal-only

The TestRail normalizer retains `custom_preconds`, `custom_steps_separated` action/expected
content, and `custom_expected` when those fields are present and well formed. Edit proposals
show before/after values and preserve existing actions. Missing product-specific content is
represented by an explicit reviewer placeholder rather than invented behavior. Duplicate
intent remains a review signal and never triggers an automatic merge, edit, or deletion.

### Acceptance criteria

1. A missing Jira work item produces `not-found`; a Jira scope without explicitly linked
   TestRail cases produces `insufficient-context`.
2. Only synchronized TestRail cases linked to the requested Jira hierarchy are inspected.
3. Missing preconditions, steps, expected results, and overly broad requirement mappings are
   reported only from the current cited case version.
4. Every proposed edit contains a field-level before/after diff, rationale, confidence, and
   citations.
5. Existing step actions and expected results are preserved; unsupported additions are
   clearly marked as reviewer input and never presented as product facts.
6. Duplicate-intent candidates include the compared case, a bounded similarity score, and
   provenance, and remain subject to human review.
7. Cases with unresolved claim conflicts are excluded and reported as a limitation.
8. The endpoint validates product/Jira scope, requires `coverage:read`, and is covered by the
   standard API audit event.
9. The Agent Workbench displays case findings, before/after diffs, duplicate candidates,
   confidence, citations, and limitations.
10. No TestRail write, merge, or publish path is available.

## Phase 4 - Automation Designer

### Scope

The Automation Designer is proposal-only. It converts approved synchronized TestRail
cases and grounded Test Designer proposals into a repository-aware automation file plan
and behavioral code outline. It uses only the requested Jira hierarchy and synchronized
GitHub evidence from repositories linked to that scope.

GitHub changed-file evidence is retained in a read-only repository index rather than
discarded as auxiliary data. Paths are classified as tests, page objects, fixtures,
utilities, configuration, or other files so the proposal can identify conventions and
reuse candidates. Path classification is not treated as proof of implementation details.
When file contents or package scripts have not been collected, the agent explicitly
abstains from executable code and exact command generation and returns discovery tasks.

### Implementation

- Agent: `apps/api/src/agents/automation-designer-agent.js`
- Context: `knowledgeService.getAutomationDesignContext`
- Endpoint: `POST /v1/agents/automation-designer/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `coverage:read`
- Mode: proposal-only

The result contains a structured file plan, behavioral code outline, reusable component
candidates, required test data, repository-proven validation commands, discovery tasks,
citations, confidence, and limitations. It has no repository writer, branch, commit, or
pull-request capability.

### Acceptance criteria

1. A missing Jira work item produces `not-found`; an incomplete manual-case or GitHub
   evidence set produces `insufficient-context`.
2. Proposals use only the requested Jira hierarchy, approved/pending synchronized
   TestRail cases, and cited Test Designer proposals.
3. GitHub changed-file evidence is indexed and remains available to identify test files,
   page objects, fixtures, utilities, configuration, and repository naming conventions.
4. Target files and reuse candidates cite synchronized GitHub evidence and distinguish
   path-based inference from inspected file content.
5. The output contains a structured file plan and behavioral code outline, never
   fabricated executable code.
6. When repository file contents are unavailable, code generation explicitly reports
   `abstained` and the proposal includes concrete read-only discovery tasks.
7. Required test data is derived from cited manual-case preconditions; unsupported data
   remains reviewer-owned.
8. Validation commands are returned only when a synchronized repository manifest proves
   the corresponding script. Commands are never guessed from framework names.
9. The endpoint validates product/Jira scope, requires `coverage:read`, and is covered by
   the standard API audit event.
10. The Agent Workbench displays file plans, outlines, reuse candidates, test data,
    validation commands, discovery tasks, confidence, citations, and limitations.
11. The capability exposes no repository file write, branch, commit, push, or pull-request
    creation path.

## Phase 5 - Reliability & Defect Intelligence

### Scope

The Reliability & Defect Intelligence agent is read/proposal-only. It analyzes synchronized
ReportPortal test-item history connected to an exact Jira ticket or epic through an explicit
external issue key or a Jira-linked repository path matching the ReportPortal `codeRef`.
Once an identity is in scope, its bounded history is evaluated across launches so passing
runs without a defect link remain visible.

Stable identity uses `codeRef` when present and falls back to an exact normalized test name
with an explicit lower-confidence limitation. Multiple attempts in one launch are collapsed
into one independent run. A same-launch retry, or any single failure, can therefore never
produce a flaky classification.

### Implementation

- Agent: `apps/api/src/agents/reliability-defect-intelligence-agent.js`
- Context: `knowledgeService.getReliabilityIntelligenceContext`
- Endpoint: `POST /v1/agents/reliability-defect-intelligence/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `coverage:read`
- Mode: read/proposal-only

The deterministic classifier emits only:

- `insufficient-history`
- `likely-flaky`
- `consistently-failing-product-risk`
- `environment-infrastructure-signal`
- `healthy`

`likely-flaky` requires recurring pass and failure outcomes across at least four independent
runs and at least two transitions. It is never promoted to `confirmed-flaky`. Healthy
requires at least three independent passing runs and no unknown or non-terminal outcome.
Repeated environment classification requires explicit ReportPortal system/environment
issue types on multiple failed launches. Consistently failing/product risk requires at
least three failures and a failure rate of at least 75%; linked Jira defects strengthen
confidence but do not silently assign ownership.

Each result contains per-identity timelines and aggregates, failure-rate trend, retry and
unknown-status counts, rationale, confidence, citations, linked synchronized Jira defects,
limitations, and review-only improvement/regression-prevention recommendations. History is
bounded to 50 identities and the latest 20 independent runs per identity after deterministic
sorting; the service has a separate 5,000-execution safety bound and reports truncation.

### Acceptance criteria

1. A missing Jira work item produces `not-found`; an unmatched Jira scope produces
   `insufficient-context`.
2. ReportPortal histories are scoped by explicit Jira external issue keys or by a
   Jira-linked repository path matching `codeRef`.
3. `codeRef` is preferred for stable identity; exact normalized name fallback is disclosed.
4. Retries in one launch collapse into one independent run and cannot independently support
   flakiness.
5. A single failure never produces `likely-flaky`; multi-run thresholds are deterministic.
6. Unknown statuses remain visible in timelines and aggregates and are excluded from
   pass/fail rates; they prevent a healthy classification.
7. Jira issues typed as bug, defect, incident, or problem are correlated only when
   synchronized and explicitly linked by key.
8. Every classification includes rationale, confidence, citations, limitations, aggregate
   counts, a chronological timeline, and review-only recommendations.
9. The endpoint validates product/Jira scope, requires `coverage:read`, uses the standard
   audit event, and exposes no source write operation.
10. The Agent Workbench displays classifications, identity basis, timeline, aggregates,
    defects, recommendations, citations, and limitations.

## Phase 6 - Knowledge Curator

### Scope

The Knowledge Curator is proposal-only and read-only. It starts from one exact Jira work
item, expands only through that item's canonical `contains` hierarchy, and remains inside
the authenticated product. It may compare those scoped entities with a bounded set of
same-product candidates to identify possible duplicate entities, repeated intent, and
missing trace mappings.

The curator inspects:

- Open conflicts and their complete claim/provenance options.
- Possible duplicate requirement, manual-test, and automated-test entities.
- Repeated acceptance-criteria or test intent.
- Missing inferred mappings and explicit links whose endpoint is not yet canonical.
- Current claims and provisional business rules whose latest cited source observation is
  older than the configured review threshold.

Staleness is only a review trigger. Similarity is only a candidate signal. Neither proves
that knowledge is wrong or equivalent. Multi-valued conflicts, cross-source disagreements,
and any evidence without a safe preferred outcome cause an explicit abstention.

### Implementation

- Agent: `apps/api/src/agents/knowledge-curator-agent.js`
- Context: `knowledgeService.getKnowledgeCurationContext`
- Endpoint: `POST /v1/agents/knowledge-curator/runs?productId=<id>`
- Dashboard: `Agent Workbench`
- Permission: `conflicts:read`
- Mode: proposal-only/read-only

Every finding carries category, severity, entity/claim/evidence IDs, confidence rationale,
full source provenance, limitations, and a before/after or action preview. Every proposal
contains `approval.required: true` for the `knowledge-reviewer` role. The endpoint does
not call the existing conflict-review operation and has no store/source mutation
capability.

### Acceptance criteria

1. A missing Jira work item produces `not-found` without fabricated proposals.
2. The scope contains only the exact Jira item and descendants reached through canonical
   `contains` links; tenant and product authorization remain fail-closed.
3. Open conflicts include the cited claim options. Ambiguous or multi-valued conflicts
   abstain instead of selecting a winner.
4. Duplicate entity and intent signals use conservative deterministic matching, include
   both evidence sets, and never merge, delete, or alias knowledge.
5. Missing mappings include an inferred link preview and confidence but never create a
   trace link. Explicit unresolved links remain visible.
6. Stale claim/business-rule findings use source `observedAt` timestamps and explicitly
   state that age does not prove invalidity.
7. Every action includes evidence IDs, provenance, confidence, limitations, before/after
   or action preview, and a human-approval requirement.
8. The endpoint validates product/Jira scope, requires `conflicts:read`, and is covered by
   the standard API audit event.
9. The Agent Workbench displays exact scope, proposal category/disposition, preview,
   evidence IDs, confidence, citations, limitations, and approval requirements.
10. Tests prove that running the curator does not change entities, claims, trace links,
    conflicts, or review records.

## Phase 7 - Ask TKL

### Scope

Ask TKL is a deterministic, read-only orchestration layer over the accepted TKL
capabilities. It is not a generic chatbot and does not use model memory. Each request
contains a product-scoped question and an optional Jira key. The orchestrator classifies
the question, selects one bounded read-only agent or canonical search, checks relevant
open conflicts, and synthesizes a concise answer from returned evidence.

Supported intents are coverage/context, manual test design, TestRail improvement,
automation design, reliability/defect intelligence, knowledge curation, and bounded
canonical knowledge search. Specialized intents require an exact Jira key. Unsupported
questions, conflicting Jira scopes, missing required scope, and responses without
citable evidence abstain explicitly.

### Implementation

- Agent: `apps/api/src/agents/ask-tkl-agent.js`
- Endpoint: `POST /v1/ask?productId=<id>`
- Dashboard: `Ask TKL`
- Permission: `ask:read`
- Mode: read-only
- Synthesis: deterministic templates; no external LLM

The response contains the interpreted scope, classified intent, answer, direct source or
TKL provenance links, freshness, confidence rationale, scoped open conflicts,
limitations, suggested next actions, and a record of read-only capabilities invoked.
Every request emits the standard `ask_tkl` API audit event.

### Acceptance criteria

1. Question and optional Jira key are strictly validated before orchestration.
2. Authentication, tenant isolation, product isolation, rate limiting, and audit apply.
3. Intent classification and capability selection are deterministic and bounded.
4. Answers contain citations and freshness or abstain instead of using unsupported facts.
5. Conflicting Jira keys and specialized questions without a Jira key abstain.
6. Open scoped conflicts, confidence, limitations, and suggested next actions are explicit.
7. The dashboard provides a chat-like interface without sending conversation memory.
8. No external LLM, source connector, generic tool, or write operation is available.
9. API, contract, client, and dashboard tests cover grounded and abstaining paths.

## Phase 8 - Approved write actions

### Status and scope

The approval workflow is complete in safe blocked mode. It supports contracts for
TestRail case create/update and GitHub branch/pull-request creation, while deliberately
shipping no external write client, credential, or enabled execution policy. This does
not claim the live-write entry gate is approved.

Preview, approval, and execution are separate authenticated operations. Each action
requires its own explicit permission; an administrator role alone is insufficient. The
immutable preview binds tenant, product, authenticated subject, action type, target,
changes, source versions, and required permission to a SHA-256 hash and expiry.
Approval binds the same subject and exact hash and is one-time and expiring. Execution
requires a distinct idempotency key and source-version match; a local version reader can
also compare the latest synchronized version. No executor exists in this phase.

### Implementation

- Service: `apps/api/src/approved-action-service.js`
- Durable store: `apps/api/src/approved-action-store.js`
- Endpoints: `POST /v1/actions/previews`, `/approvals`, and `/executions`
- Dashboard: `Agent Workbench`
- Mode: blocked/not-configured
- Runbook: `docs/runbooks/approved-write-actions.md`

### Acceptance criteria

1. No approval or execution can change the immutable preview.
2. Product, subject, action, permission, hash, expiry, and source version are verified.
3. Idempotency keys replay the same record or reject conflicting input.
4. Approval can be consumed only once.
5. Durable records and lifecycle audit events contain no source credentials.
6. Stale locally synchronized source data fails before the blocked attempt is recorded.
7. The current environment returns `external_writes_not_configured` and
   `externalCallMade: false`.
8. The dashboard shows risk, required permission, hash, expiry, and block reason, and
   renders no approval button for a blocked preview.

## Feedback checkpoint after each phase

Stakeholder testing should record:

- Correct answer or incorrect answer.
- Missing source/evidence.
- Unsupported inference.
- Useful or unhelpful recommendation.
- Expected action that was absent.
- Terminology or workflow correction.

Accepted feedback becomes a versioned fixture or test before changing prompts, rules, or
models. This prevents one-off prompt tuning from silently regressing other scenarios.

## Evaluation expansion

The existing 25-ticket golden dataset remains the baseline. Each phase adds a reviewed
dataset:

- Phase 1: epic/story context and coverage explanations.
- Phase 2: expected manual case proposals and prohibited duplicates.
- Phase 3: existing-case quality defects and approved edits.
- Phase 4: repository patterns, target files, and expected validation.
- Phase 5: historical execution sequences and approved failure classifications.
- Phase 6: conflicts and approved curation decisions.
- Phase 7: grounded questions, expected citations, and required abstentions.

No phase is accepted from a successful demo alone.
