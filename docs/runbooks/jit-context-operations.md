# JIT Ticket Context Operations

## Purpose

P5 provides demand-scoped invalidation for retained ticket context. A webhook can make
an existing hot ticket stale and queue refresh work, but it cannot create context for
an unseen Jira issue. The durable coordinator preserves P4 encryption, retries,
full-sync preemption, cancellation, and restart recovery.

## Jira webhook contract

Route: `POST /v1/webhooks/jira`

The route is mapped at startup to the configured product. There is intentionally no
`productId` query parameter or product value trusted from the payload.

Required headers:

```text
content-type: application/json
x-atlassian-webhook-identifier: <bounded unique delivery ID>
x-hub-signature-256: sha256=<HMAC-SHA256 hex digest>
```

Calculate the signature over the exact raw request bytes using the deployment-managed
secret. The digest is 64 lower-case hexadecimal characters. The service uses a
timing-safe comparison and does not parse the body until verification succeeds.

Accepted payload shape:

```json
{
  "webhookEvent": "jira:issue_updated",
  "timestamp": 1789502400000,
  "issue": {
    "key": "STT-3731",
    "fields": {
      "project": { "key": "STT" }
    }
  }
}
```

The body limit is 64 KiB. The issue key is canonicalized to upper case. Its project
prefix and `issue.fields.project.key`, when present, must agree and be allowlisted.

Responses:

- `202 {"disposition":"accepted"}`: a retained ticket was marked stale and one
  coalesced refresh was queued.
- `202 {"disposition":"ignored:duplicate"}`: the delivery ID was already persisted.
- `202 {"disposition":"ignored:obsolete"}`: the event timestamp is not newer than the
  latest successful completion for Jira.
- `202 {"disposition":"ignored:not-hot"}`: no retained ticket job exists; no job or
  source request was created.
- `4xx`: invalid signature, malformed delivery, unsupported event, or project scope
  violation. Errors are sanitized.

## Configuration

The webhook is disabled unless `TKL_JIRA_WEBHOOK_ENABLED=true`.

Production:

```text
TKL_JIRA_WEBHOOK_ENABLED=true
TKL_JIRA_WEBHOOK_ALLOWED_PROJECTS=STT,QA_CORE
TKL_JIRA_WEBHOOK_SECRET_REF=env://TKL_JIRA_WEBHOOK_HMAC_SECRET
TKL_JIRA_WEBHOOK_HMAC_SECRET=<deployment injected, at least 32 bytes>
```

Production refuses startup when an enabled webhook lacks its secret reference or
project allowlist. `TKL_JIRA_WEBHOOK_SECRET` is a development-only explicit secret and
has no default.

Coordinator controls:

```text
TKL_CONTEXT_JOB_RECEIPT_RETENTION_MS=604800000
TKL_CONTEXT_JOB_MAX_RECEIPTS=20000
TKL_CONTEXT_JOB_RETENTION_SWEEP_INTERVAL_MS=3600000
TKL_CONTEXT_JOB_MAX_QUEUE_AGE_MS=300000
TKL_CONTEXT_JOB_MAX_RETRY_BACKLOG=100
```

Existing P4 controls continue to apply, including concurrency, retries, freshness,
terminal retention, capacity, encrypted storage directory, and key reference.

## Operations endpoint

Use an authenticated identity with `connections:read` and access to the requested
product:

```text
GET /v1/context-operations?productId=fl-titling
Authorization: Bearer <verified token>
```

The response contains:

- Durable counts for every job state and retained delivery receipts.
- In-memory queued, active, delayed retry, paused, and oldest queue age.
- Attempt and retry totals.
- Global job capacity used, maximum, and percentage.
- Last successful completion.
- Sanitized last worker and persistence failure.
- Accepted, duplicate, obsolete, not-hot, and rejected invalidation counts.
- Last invalidation disposition/timestamps and last retention sweep.

It does not return issue keys, event IDs, digests, payloads, signatures, credentials,
provider responses, or raw errors.

## Health and alerts

`GET /health` exposes only the aggregate `ticket-context` component status and reason
codes. Investigate these reasons through the authenticated operations endpoint:

- `capacity_high`: durable jobs are at least 90% of configured capacity.
- `queue_age_excessive`: the oldest in-memory queued job exceeds
  `TKL_CONTEXT_JOB_MAX_QUEUE_AGE_MS`.
- `retry_backlog_excessive`: delayed retries exceed
  `TKL_CONTEXT_JOB_MAX_RETRY_BACKLOG`.
- `worker_failure` or `persistence_failure`: a failure has not been followed by a
  successful completion.

A partial or unavailable individual ticket does not by itself degrade service health.

## Retention and shutdown

The coordinator sweeps at startup and on the configured interval. It deletes only
terminal job metadata older than `TKL_CONTEXT_JOB_RETENTION_MS` and delivery receipts
older than `TKL_CONTEXT_JOB_RECEIPT_RETENTION_MS`, while also enforcing
`TKL_CONTEXT_JOB_MAX_RECEIPTS`. It never deletes pending/running jobs or Bronze,
Silver, or Gold evidence.

Sweeps do not overlap. The interval handle is unreferenced and is cleared during
graceful shutdown before active work is cancelled and recovered as pending.

## Incident checks

1. Confirm `/health` reason codes.
2. Query `/v1/context-operations` for the affected product.
3. Check capacity, oldest queue age, delayed retries, and last sanitized failures.
4. Verify the configured project allowlist and secret reference, without printing the
   secret.
5. For duplicate storms, compare Jira delivery behavior with retained receipt counts.
6. Never replay by changing a delivery ID unless Jira is intentionally issuing a new
   event; dedupe is durable across restart.
