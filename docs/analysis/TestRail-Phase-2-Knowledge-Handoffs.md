# TestRail Phase 2 Knowledge and Traceability Handoffs

## Status

Knowledge and Traceability fixture-based normalization is complete for the following
TestRail evidence:

| Raw evidence | Canonical knowledge |
|---|---|
| `testrail.suite` | `test-suite` entity and explicit name claim |
| `testrail.case` | `manual-test` entity and explicit case metadata claims |
| `testrail.run` | `test-execution` entity and explicit name claim |
| `testrail.result` | `test-execution` entity with raw `status_id` and provisional `status: "unknown"` claims |

All normalized entities, claims, and explicit trace links preserve source provenance and
tenant/product scope. The implementation is covered by unit, contract, and fixture-based
tests in backlog items `KNW-101` and `KNW-102`.

## Completed Behavior

The TestRail normalizer creates only relationships that raw evidence explicitly supports:

```text
test-suite:testrail:<suite-id>
  -> manual-test:testrail:<case-id>       (contains, when case.suite_id exists)
  -> test-execution:testrail:run:<run-id>      (contains, when run.suite_id exists)

test-execution:testrail:run:<run-id>
  -> test-execution:testrail:result:<result-id> (contains, when result.run_id exists)

manual-test:testrail:<case-id>
  -> test-execution:testrail:result:<result-id> (executed_by, when result.case_id exists)
```

No relationship is inferred from titles, source URLs, collection order, or missing
parent context. Valid records missing these fields still normalize safely, but no link is
created.

## Required Handoffs and Decisions

| Needed input | Owner to consult | Blocks |
|---|---|---|
| Preserve or enrich `suite_id` in `testrail.case` raw evidence when the source response omits it | Jorge Santiago, Source Ingestion | Production suite-to-manual-test links |
| Preserve or enrich `run_id` and `case_id` in `testrail.result` raw evidence when the source response omits them | Jorge Santiago, Source Ingestion | Production run-to-result and result-to-manual-test links |
| Shared typed contracts for `test-suite`, `manual-test`, `test-execution`, `contains`, `executed_by`, claims, provenance, and history | Miguel Barajas, Architecture and Contracts | Complete: `ARCH-101`/`ARCH-102` are merged; use `@tkl/contracts` |
| TestRail custom field containing Jira requirement/story references | FL Titling QA/Product owner | Live configuration for the implemented `KNW-103` mapping |
| Approved TestRail-case to GitHub automation reference convention | FL Titling QA/Product owner and Jorge Santiago | Live configuration for the implemented `KNW-104` mapping |
| Result status mapping for passed, failed, blocked, skipped, retest, and not-run outcomes | FL Titling QA/Product owner | Final execution semantics and `KNW-106` coverage/freshness |
| Manual, automated, execution-freshness, and combined coverage policy | FL Titling QA/Product owner | `KNW-106` |
| Product-scoped query/result schemas for manual tests and executions | Carlos Ramirez, API/MCP and Security | API/MCP exposure after canonical link and coverage shapes are stable |
| TestRail manual/execution/freshness expectations in golden scenarios | Clemente Herrera, Dashboard and Evaluation | Dashboard integration and evaluation of `KNW-106` |

## Current Constraints

- Result status IDs remain explicit raw facts. The normalized business status is
  `unknown` until the QA/product owner approves mappings.
- Canonical TestRail entity and link types use the shared `@tkl/contracts` declarations.
- The in-memory store is suitable for fixture integration only. It is not a persistent
  production knowledge store.
- API/MCP and dashboard surfaces must consume canonical knowledge through their
  application-layer contracts; they must not call TestRail directly.

## Remaining Knowledge and Traceability Sequence

1. Configure the implemented `KNW-103` Jira-reference mapping after the live custom
   field is approved.
2. Configure the implemented `KNW-104` GitHub automation mapping after the live
   convention is approved.
3. Configure the implemented `KNW-106` status mapping, freshness window, and combined
   weights after the product policy is approved.
4. Complete `KNW-107`; `KNW-103` through `KNW-106` now provide the required TestRail
   knowledge, persistence, and configurable coverage context.

## Live Enablement

Live TestRail validation remains outside the fixture-based tasks. It requires an
approved base URL, project ID, suite allowlist, reviewed field/status mappings, a
read-only credential reference, approved network access, and a sanitized dry run.
Credential values must never be added to this repository, fixtures, logs, Markdown
exports, API/MCP responses, or dashboard data.
