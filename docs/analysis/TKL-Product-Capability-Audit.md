# TKL Product Capability Audit

## Decision

TKL should evolve from an operations and traceability dashboard into a **grounded QA
workbench**. The knowledge library remains the source-of-truth layer; generation,
recommendation, and conversational experiences are consumers of that layer and must
never bypass provenance, freshness, or human approval.

## Original objective versus current implementation

| Objective | Current state | Gap |
|---|---|---|
| Reusable context from Jira, TestRail, GitHub, Confluence, and ReportPortal | Connectors, raw evidence, normalizers, canonical storage, and source configuration exist | A connected source contributes no knowledge until it has completed a successful sync |
| Story and epic context | Ticket search and direct traceability exist | Jira issue type, status, parent, and epic relationships were previously discarded; existing knowledge must be re-ingested after the hierarchy fix |
| Manual test design and TestRail improvement | TestRail cases/runs/results can be normalized | No Test Designer, duplicate detector, improvement proposal, review queue, or TestRail publication workflow exists |
| Automated test generation | GitHub PR evidence can link automation to Jira | No repository-aware Automation Designer exists; framework conventions and reusable components are not yet indexed as generation context |
| Flaky-test and automation improvement analysis | ReportPortal launches/items/results can be normalized | No historical stability analyzer correlates retries, code revisions, environments, defects, or Jira scope |
| Coverage and impact intelligence | Coverage and traceability analyzers exist | Cross-source links were incorrectly hidden when the root query selected Jira; this made synchronized GitHub/TestRail evidence invisible in aggregate views |
| Objective evaluation | A 25-ticket golden dataset and repeatable harness exist | The dashboard was deliberately wired to an `EVAL-102` error instead of the harness API |
| Product expert / questions about flows | MCP read tools expose bounded knowledge | No grounded conversational experience exists and no response-quality contract has been defined |

## Corrections in the current change

1. Expose the real golden-dataset evaluation harness through
   `GET /v1/evaluation/metrics`.
2. Preserve Jira issue type, status, parent, and epic identity during normalization.
3. Create explicit `contains` links from an epic/parent to its child work items.
4. Expand epic traceability through child requirements and their linked tests.
5. Apply the Jira source filter only when selecting root work items. Related TestRail,
   GitHub, and ReportPortal evidence remains visible in the cross-source graph.
6. Bound epic expansion to 100 child requirements per response and report when the
   result is truncated.

Existing Jira knowledge predates the hierarchy metadata and must be re-ingested before
live epics such as `STT-3731` can expose their descendants.

## Proposed product: Quality Workbench

### 1. Context Explorer

Input: Jira ticket, epic, sprint, board, feature name, or domain concept.

Output:

- Requirement hierarchy and acceptance criteria.
- Related TestRail cases and latest results.
- Related automated tests and repository components.
- ReportPortal execution history and linked defects.
- Confluence rules and workflow documentation.
- Coverage gaps, conflicts, stale evidence, and explicitly stated unknowns.

This is the prerequisite for every generative capability.

### 2. Test Design Studio

Two proposal modes:

- **Create cases:** propose new manual cases for an approved Jira scope.
- **Improve cases:** review existing TestRail cases for missing preconditions, weak
  expected results, duplicate coverage, obsolete steps, and uncovered negative or
  boundary scenarios.

Every proposal must include:

- Source citations for each scenario.
- Requirement and risk mapping.
- Existing-case similarity and duplicate warning.
- Preconditions, test data, steps, and expected results as separate fields.
- Confidence, missing evidence, and assumptions.
- Human approve/reject/edit workflow.

Publishing to TestRail is a later write capability with preview, least-privilege scope,
and explicit approval. The first version remains proposal-only.

### 3. Automation Design Studio

Input: approved case or coverage gap.

Context:

- Jira and Confluence product behavior.
- Existing TestRail intent.
- Repository framework, page objects, fixtures, utilities, tags, and conventions.
- Historical ReportPortal failures for similar tests.

Output:

- Proposed automation approach and target layer: UI, API, integration, or contract.
- Reusable components and files to modify.
- Generated branch change with requirement citations.
- Validation plan and risks.

The agent must not write directly to `main`. Generated automation is delivered through a
reviewable branch/PR only after compilation and targeted tests pass.

### 4. Reliability Lab

This is the ReportPortal intelligence surface. It should correlate a stable test identity
across launches and classify findings as:

- `insufficient_evidence`
- `likely_product_defect`
- `likely_automation_defect`
- `likely_environment_issue`
- `likely_flaky`
- `confirmed_flaky`
- `human_review_required`

Inputs include repeated outcomes, retries in the same build, duration variance,
environment/browser, code revision, Jira scope, linked defects, and recent test/product
changes. A single failed or retried execution must never be labeled flaky.

Recommendations can propose assertion, wait strategy, selector, fixture, isolation, test
data, or product-observability improvements. Each recommendation must cite the execution
history and explain why competing classifications were rejected.

### 5. Ask TKL

A conversational interface is valuable only if it is a thin, grounded consumer of TKL,
not a generic chat window.

Required response contract:

- Answer.
- Sources and direct links.
- Scope interpreted from the question.
- Evidence freshness.
- Confidence.
- Conflicts or missing sources.
- Suggested next action.

Example questions:

- “Explain the FL title-application happy path and cite the governing Jira and
  Confluence evidence.”
- “What changed under `STT-3731`, which tests cover it, and what remains unverified?”
- “Which billing automation has repeated inconsistent failures and why?”
- “Propose negative TestRail cases for this story without duplicating existing cases.”

The chat must use bounded retrieval and structured TKL tools. It must not answer from
model memory when the requested product fact is absent from TKL.

## Accuracy gates

“100% certain” cannot honestly mean that every generated conclusion is always correct.
It should mean that TKL never hides uncertainty and never presents an unsupported claim
as fact.

Every generated artifact must carry:

1. Source evidence and provenance.
2. Source freshness and synchronization status.
3. Explicit facts separated from inferences.
4. Confidence and known unknowns.
5. Conflicts that require review.
6. Duplicate and existing-coverage checks.
7. Human approval before external writes.
8. Evaluation against reviewed ticket/case/flaky-analysis datasets.

## Recommended delivery order

1. **Knowledge readiness:** complete source syncs, Jira hierarchy, source-specific
   metadata, execution identity, and cross-source links.
2. **Context Explorer:** make a ticket/epic evidence bundle complete and explainable.
3. **Test Design Studio:** proposal-only creation and improvement of TestRail cases.
4. **Reliability Lab:** evidence-backed ReportPortal stability analysis.
5. **Automation Design Studio:** repository-aware automation proposals and reviewed code.
6. **Ask TKL:** conversational orchestration over the stable tools above.
7. **Approved write actions:** TestRail publication and GitHub branch/PR creation with
   separate permissions and human gates.

