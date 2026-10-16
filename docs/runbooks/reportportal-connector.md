# ReportPortal Connector

## Scope

The connector reads launches and test items from one explicitly approved ReportPortal
project. It stores execution status, timing, code reference, retry data, and provider
defect classification as explicit evidence.

A canonical defect is created only when ReportPortal supplies an explicit external issue
identity. Failed status or a provider classification alone never produces an inferred
defect, root cause, or flaky-test conclusion.

Required connection values:

- `baseUrl`.
- `project`.
- A project-readable API token stored only in the workspace credential vault.

## Operation and recovery

Requests use bearer authentication resolved per request. Launch and item pagination uses
validated zero-based page metadata and locally rebuilt same-origin URLs. Checkpoints move
through launch and item phases; stable provider IDs and payload versions make replay
idempotent.

For authorization failures, rotate the credential. For host-policy failures, approve the
exact hostname through `TKL_SOURCE_ALLOWED_HOSTS`. The connector intentionally does not
collect unrestricted logs because they can be high-volume and contain sensitive data.
