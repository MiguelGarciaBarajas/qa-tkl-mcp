# STT-3731 analysis

## Product context

TKL is intended to become an evolving quality memory for the product, continuously
aggregating quality information so multiple agents can reuse the same verified context
instead of rediscovering it in every prompt. Target consumers include agents for manual
test design, automated test generation, impact analysis, regression-suite
recommendations, defect triage, coverage-gap analysis, root-cause analysis, and
sprint-level quality intelligence.

The broader target source landscape includes:

- **Jira:** stories, epics, acceptance criteria, components, labels, dependencies, sprint
  assignments, and business rules.
- **TestRail:** test cases, suites, runs, results, and coverage mappings.
- **Automation repositories:** Playwright/API tests, page objects, framework utilities,
  tags, and execution history.
- **Defect systems:** bugs, root causes, severity, failure categories, and recurrence.
- **Delivery artifacts:** pull requests, release notes, builds, and related evidence.
- **Confluence and other documentation:** product workflows, terminology, and domain rules.

These sources should feed an ingestion/ETL layer, raw evidence, canonical knowledge,
traceability, analysis, and controlled agent access. Human review remains required for
inferred knowledge and proposed changes.

The repository now includes injected-client TestRail ingestion for sanitized suites, cases,
runs, and results. TestRail normalization remains owned by Josue Misael Torres in the
Knowledge and Traceability workstream; the connector emits raw evidence only. Accessing
real TestRail data requires an administratively managed credential reference and is not
available from fixtures, agents, or the dashboard.

## Scope and source

This analysis is based on the Jira issue `STT-3731` in the Solera Titling project, its
accessible retest comment dated 15 August 2026, and a Jira search for
`"Epic Link" = STT-3731 OR parent = STT-3731`. It also checks the GitHub repository
`Solera-Engineering/qa-tkl-mcp-f5`. Jira facts below are live observations from the
authenticated session; GitHub facts describe the remote repository state, not local
unpublished work.

## Verified Jira facts

- Key: `STT-3731`
- Summary: `FL Modernization`
- Type: Epic
- Status: In Progress
- Project: Solera Titling
- Description: empty in the Jira API response.
- The retest comment describes a QAE full-lane cohort of 44 cards:
  - 36 passed.
  - 7 required a product decision or fixture.
  - 1 was identified as a real defect, `STT-5291`.
- The reported defect symptom was `GET /api/billing/deals/{uid}` returning HTTP 200
  with `totalBilledAmount=0` and `feeLines=[]` for invoiced deals while the billing
  UI showed fees.
- The comment also records fixture scarcity and missing read-only worker observability
  as broader delivery risks.

## Related Jira inventory

The epic search returned **648 related issues**:

| Type | Count |
|---|---:|
| Bug | 384 |
| Task | 199 |
| Story | 65 |

| Status | Count |
|---|---:|
| Resolved | 294 |
| Closed | 161 |
| Ready for Testing | 82 |
| Performance Test | 41 |
| In Progress | 27 |
| Open | 18 |
| In Testing | 16 |
| In Acceptance | 9 |

There are **152 related issues still in active or testing-oriented statuses**:
Open, In Progress, Ready for Testing, In Testing, or In Acceptance. The most recent
active items include work on billing, DHSMV inquiry/bootstrap, legacy parity, worker
flakiness, release/environment readiness, automation, secrets hygiene, and performance.
This inventory is a scope and prioritization signal; it is not by itself a coverage
decision.

The related issue set is broad enough that a production connector should ingest it
incrementally and preserve each issue's key, type, status, timestamps, assignee,
description/acceptance criteria, comments, links, labels, components, and source
version. A single epic comment is insufficient to infer complete requirements or test
coverage for all 648 items.

## GitHub repository findings

The repository `Solera-Engineering/qa-tkl-mcp-f5` is private, uses `main` as its
protected default branch, and currently has one remote commit:
`chore: initialize modular TKL project` at
`d26367612e6b18dd27428f5da6991901b31eaa09`.

The remote repository search returned:

- No pull requests.
- No GitHub issues matching `STT-3731`.
- No code references to `STT-3731`.
- No code references to `FL Modernization`.

Therefore, no real GitHub PR, commit, changed file, automated test, or explicit
repository-to-Jira relationship can currently be attributed to `STT-3731`. The local
workspace contains the implementation under development, but it is not yet evidence
published to the remote repository.

## Analysis and inferences

The epic is a suitable first TKL ingestion fixture because it contains an issue-level
record plus a high-value operational comment with test outcomes, evidence references,
triage decisions, and explicit uncertainty. The connector must preserve those as raw
evidence; normalization should later separate facts, observations, decisions, and
inferences.

No GitHub pull request, commit, automated test, requirement, or acceptance criterion is
claimed here because no matching remote GitHub records were retrieved. Coverage remains
unevaluated until canonical requirements and approved Jira/GitHub trace links are
available.

## Implemented ingestion baseline

`@tkl/connector-jira` provides an injected-client connector that:

- Emits versioned `RawEvidenceRecord` values for an issue and its comments.
- Preserves source IDs, versions, timestamps, hashes, source URLs, product, and tenant.
- Supports paginated comments, resumable checkpoints, bounded transient retries, and
  deterministic idempotency keys.
- Accepts credential references only; it never stores or emits token values.

The fixture at `tests/fixtures/stt-3731-jira.json` is sanitized and contains no email
addresses, tokens, or restricted production payloads.

## Next vertical-slice steps

The first Jira/GitHub vertical slice is now implemented:

1. GitHub connector for pull requests and changed files, with pagination-compatible
   collection, checkpoints, retries, hashes, idempotency, health, and credential
   references.
2. Jira and GitHub normalizers plus an in-memory canonical knowledge store.
3. Application service operations for story context, coverage status, traceability, and
   conflicts.
4. Read-only HTTP API routes and a thin read-only MCP provider that calls the application
   service rather than source APIs.
5. Integration coverage for Jira + synthetic GitHub evidence through the MCP boundary.

Remaining product extensions are TestRail normalization, automation-repository analysis,
defect intelligence, a persistent knowledge store, authentication/RBAC/audit policy,
the dashboard, and golden-dataset evaluation. These must be added through the existing
contracts and plugin boundaries without changing source-specific core orchestration.
