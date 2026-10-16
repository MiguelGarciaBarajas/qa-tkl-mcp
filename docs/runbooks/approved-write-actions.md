# Approved Write Actions

## Status

Phase 8 is implemented end-to-end in **safe blocked mode**. The platform can create and
durably record an immutable preview, record an explicit one-time approval, and process an
execution request. This repository does not contain or wire a TestRail/GitHub write
client, approved service credential, or enabled write policy. Every otherwise valid
execution therefore completes with:

```json
{
  "status": "blocked",
  "externalCallMade": false,
  "reason": {
    "code": "external_writes_not_configured"
  }
}
```

## Contracts

All routes require an authenticated subject, exact product membership, and the
action-specific permission.

### 1. Preview

`POST /v1/actions/previews?productId=<id>`

The request supplies one supported `actionType`, an action-specific `target`, proposed
`changes`, immutable `sourceVersions`, and an `idempotencyKey`. The response exposes:

- SHA-256 `previewHash` over tenant, product, subject, action, target, changes, versions,
  and required permission.
- Risk and action-specific permission.
- Creation and expiry timestamps.
- `executable` and an explicit blocking reason.

Secret-like keys (`token`, `password`, `credential`, `authorization`, `apiKey`, and
similar names) are rejected.

### 2. Approval

`POST /v1/actions/approvals?productId=<id>`

Approval names the action type, preview ID, exact preview hash, and a new idempotency key.
The API derives the approver from the authenticated identity. A preview cannot be
approved by another subject or under another product/action scope, and its first
approval atomically prevents any second approval for that preview. Approval expires in
at most five minutes and can be consumed only once.

### 3. Execution

`POST /v1/actions/executions?productId=<id>`

Execution names the approval, exact preview hash, exact source versions, action type, and
an execution idempotency key. Before recording the blocked attempt, the service verifies:

1. Authenticated subject, tenant, and product scope.
2. Action-specific permission.
3. Approval/preview/action/hash binding.
4. Approval expiry and one-time status.
5. Request source versions equal the preview.
6. Current locally synchronized source versions still equal the preview when a local
   version reader is available.
7. Idempotency has not been reused for different input.

The current composition stops at the disabled-policy gate, records the blocked attempt,
consumes the one-time approval, emits an audit event, and makes no external call.

## Durable records and audit

The production composition stores records in
`TKL_APPROVED_ACTION_DATA_DIR` (default `./data/approved-actions`) with tenant/product
isolation, atomic file replacement, and a writer lock. Records contain proposed data and
hashes but no source credentials. Writer locks include process ownership metadata;
locks left by terminated processes are reclaimed, while active lock contention fails
with a retryable busy error. Legacy metadata-free locks are reclaimed only after a
bounded stale-lock TTL.

Audit events:

- `approved_action.preview`
- `approved_action.approval`
- `approved_action.execution`

Execution audit includes `externalCallMade`; it is always `false` in the current
environment.

## Enabling execution in a future approved environment

Do not toggle a configuration value alone. A future change must provide and review:

- Separate least-privilege TestRail/GitHub service identities.
- Product and repository/project allowlists.
- An action-specific executor with no generic HTTP escape hatch.
- A source-version reader used immediately before execution.
- Credential rotation and audit retention.
- Action-specific rollback/recovery procedures.
- Integration tests proving no cross-product or cross-subject use.

Until all controls are approved, do not add or inject an executor.
