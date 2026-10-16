# TestRail Run and Result Normalization

## Scope

This document defines the fixture-based behavior implemented for backlog item `KNW-102`.
The TestRail normalizer consumes raw evidence only; it does not call TestRail or resolve
configuration and credentials.

| Raw evidence type | Canonical entity | Explicit claims |
|---|---|---|
| `testrail.run` | `test-execution` | `name` |
| `testrail.result` | `test-execution` | `status_id`, provisional `status` |

The `test-execution` entity and `executed_by` trace-link types are supplied by
`@tkl/contracts` as of `ARCH-101`.

## Status Mapping

The FL Titling QA/product owner has not approved TestRail status semantics. Therefore
every result retains its raw `status_id` and receives `status: "unknown"`. The
normalizer does not infer that any ID means passed, failed, blocked, skipped, retest, or
not run.

The current tests cover multiple numeric status IDs and assert that each remains
`unknown`. A reviewed mapping must replace this behavior before execution status can
contribute to coverage or freshness.

## Explicit Relationships

The normalizer creates these links only when the source result/run payload explicitly
provides the referenced ID:

```text
test-suite:testrail:<suite-id> -> test-execution:testrail:run:<run-id>       (contains)
test-execution:testrail:run:<run-id> -> test-execution:testrail:result:<id> (contains)
manual-test:testrail:<case-id> -> test-execution:testrail:result:<id>       (executed_by)
```

A valid run/result with no parent IDs is still normalized, but produces no links. The
current connector fixture exercises this safe behavior.

## Required Source Ingestion Handoff

Jorge Santiago's TestRail connector knows the current run while collecting results but
does not preserve `run_id` in raw result payloads when TestRail omits it. The result must
also include `case_id` to establish an explicit manual-test-to-execution relationship.
These fields are required for production traceability without inference.

## Exclusions

Final TestRail status semantics, execution freshness thresholds, manual/automated/
combined coverage, Jira requirement links, GitHub automation links, persistence, and
human review workflows are separate backlog items.
