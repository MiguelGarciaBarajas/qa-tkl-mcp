# TKL Application API

This package is the composition root for the TKL application API. It exposes HTTP routes
and delegates knowledge operations to injected services. Knowledge routes are read-only
except for local human-review records. Phase 8 also records immutable action previews,
one-time approvals, and execution attempts locally, but the production composition has
external execution disabled and contains no TestRail or GitHub write adapter. The default
composition uses the shared in-memory
store, Jira/GitHub/TestRail normalizers, and coverage/conflict analyzers. Their
implementations remain in their owning packages and can be replaced through
`createKnowledgeService` dependencies.

## Run

From the repository root:

```bash
npm run start --workspace @tkl/api
```

The server listens on `http://localhost:3000` by default. Set `PORT` to use another
valid port.

## Routes

All knowledge routes require a `productId` so product isolation is explicit at the API
boundary:

- `GET /health`
- `GET /v1/knowledge/search?productId=<id>&query=<text>&limit=<1-100>`
- `GET /v1/story/test-context?productId=<id>&storyId=<id>`
- `GET /v1/requirements/coverage?productId=<id>&requirementId=<id>`
- `GET /v1/traceability?productId=<id>&requirementId=<id>`
- `GET /v1/knowledge/conflicts?productId=<id>`
- `POST /v1/knowledge/conflicts/review?productId=<id>`
- `GET /v1/resources/read?productId=<id>&uri=<tkl-resource-uri>`
- `POST /v1/agents/coverage-context/runs?productId=<id>`
- `POST /v1/agents/test-designer/runs?productId=<id>`
- `POST /v1/agents/testrail-improvement/runs?productId=<id>`
- `POST /v1/agents/automation-designer/runs?productId=<id>`
- `POST /v1/agents/reliability-defect-intelligence/runs?productId=<id>`
- `POST /v1/agents/knowledge-curator/runs?productId=<id>`
- `POST /v1/ask?productId=<id>`
- `POST /v1/actions/previews?productId=<id>`
- `POST /v1/actions/approvals?productId=<id>`
- `POST /v1/actions/executions?productId=<id>`
- `GET /v1/context-jobs/:issueKey?productId=<id>`
- `POST /v1/context-jobs/:issueKey/refresh?productId=<id>`
- `DELETE /v1/context-jobs/:issueKey?productId=<id>`
- `GET /v1/context-operations?productId=<id>`
- `POST /v1/webhooks/jira`

### GitHub source and repository targets

One product has one GitHub source connection and one shared PAT. The PAT remains only in
the encrypted `github` credential-vault record and is never copied into repository state
or returned by the API. Existing `config.repositories` values remain supported as either
one string or an array of up to 50 unique `owner/name` strings. They are migrated
deterministically to typed targets without replacing the current credential.

The source connection response includes `repositories`. Every target contains:
`id`, `repository`, `url`, `purpose`, `lifecycle`, `enabled`,
`validationStatus`, `syncStatus`, `lastValidatedAt`, `lastSyncAt`,
`lastSuccessfulSyncAt`, `recordsCollected`, and a sanitized `error`.

Repository routes are product-scoped:

- `GET|POST /v1/source-connections/github/repositories`
- `GET|PUT|PATCH|DELETE /v1/source-connections/github/repositories/:repositoryId`
- `POST /v1/source-connections/github/repositories/:repositoryId/test`
- `POST|DELETE /v1/source-connections/github/repositories/:repositoryId/sync`

Reads require `connections:read`, configuration/test writes require
`connections:write`, and sync/cancel requires `connections:sync`. Create accepts
optional lower-case `id`, required `repository`, optional matching `url`, `enabled`,
`purpose` (`application`, `test-automation`, `quality-evidence`, `documentation`,
`shared-library`, or `other`), and `lifecycle` (`active`, `maintenance`, `deprecated`,
or `archived`). Update accepts the same mutable fields except `id`. Secret-like and
operational metadata fields are rejected.

Source-level GitHub test and sync operate on all enabled, non-archived targets. An
inaccessible repository is recorded on that target and does not prevent other targets
from validating or synchronizing. Repository syncs use independent Bronze checkpoint
namespaces under `connector.github.repository.<safe-id>` and independently cancellable
abort signals. Durable non-secret operational metadata is stored beneath
`TKL_GITHUB_REPOSITORY_DATA_DIR` (default `./data/source-repositories`).

All agent run routes accept `{ "workItemId": "STT-123" }` and are audited. Phases 1-5
require `coverage:read`; the Knowledge Curator requires `conflicts:read`. The Automation
Designer is proposal-only: it returns a file plan,
behavioral code outline, reuse candidates, required data, repository-proven validation
commands, discovery tasks, citations, confidence, and limitations. It has no repository,
branch, commit, push, or pull-request write path.

The Knowledge Curator is also proposal-only. It inspects canonical evidence within the
exact requested Jira work-item hierarchy and product, while using bounded product
candidates only to identify possible duplicates or missing mappings. It returns
evidence-backed findings and before/after or action previews for:

- Open claim conflicts.
- Possible duplicate canonical entities and repeated intents.
- Missing or unresolved trace links.
- Claims and provisional business rules whose latest source observation is stale.

Every proposal preserves evidence IDs, provenance, confidence, limitations, and an
explicit human-approval requirement. Ambiguous conflicts return an `abstain`
disposition. This endpoint cannot call conflict review, mutate the knowledge store,
create trace links, merge entities, update claims, or write to a source system.

### Jira read-through retrieval

Ticket-scoped reads are local-first. When a valid Jira key is missing or older than
`TKL_ON_DEMAND_FRESHNESS_MS` (15 minutes by default), the API retrieves only that
issue and a bounded set of comments from the configured Jira connection. Concurrent
requests for the same product/key share one retrieval, and targeted retrieval never
overlaps a full product synchronization.

Remote collection has a 10-second and 100-record budget. It commits evidence under the
separate `connector.jira.on-demand` Bronze namespace without reading or advancing the
full-sync checkpoint, then projects that bounded evidence to Silver before completing
the initiating read. A failed refresh falls back to existing stale context; if no local
context exists, the request returns a sanitized source error.

After Jira succeeds, deterministic bounded enrichment from connected TestRail and
GitHub is queued durably and the initiating ticket read returns without waiting for
either secondary source. TestRail queries
only configured suites with the exact Jira `refs` filter (up to 20 suites and 100
cases). GitHub fans out across all enabled allowlisted targets for pull requests
containing the exact Jira key, with aggregate limits of 10 pull requests and 50 changed
files. Per-repository failures produce a partial result instead of discarding successful
repositories. Results are stored under independent `connector.testrail.on-demand` and
`connector.github.on-demand.repository.<safe-id>` Bronze namespaces, so full-sync
checkpoints remain unchanged.

Secondary sources run through a bounded asynchronous coordinator with one active job
per product, global concurrency, single-flight by canonical product/key, cancellation,
and bounded exponential retry for transient failures. Full source sync has foreground
priority: it preempts active enrichment and deferred jobs resume afterward without
touching full-sync checkpoints. Their failures are isolated: Jira context remains
available, while each enrichment source reports `complete`, `partial`, `unavailable`,
or `not-connected`. Search
results are verified locally before ingestion, and relationships are created only
from explicit Jira references rather than text similarity.

### Durable ticket context jobs

The public job contract is:

```json
{
  "productId": "fl-titling",
  "issueKey": "STT-3731",
  "state": "pending|running|complete|partial|unavailable|cancelled",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "queuedAt": "ISO-8601",
  "startedAt": "ISO-8601|null",
  "completedAt": "ISO-8601|null",
  "cancelledAt": "ISO-8601|null",
  "attemptCount": 0,
  "nextRetryAt": "ISO-8601|null",
  "sources": {
    "jira": {
      "state": "local|refreshed|pending|running|complete|partial|unavailable|not-connected|cancelled",
      "startedAt": "ISO-8601|null",
      "completedAt": "ISO-8601|null",
      "attemptCount": 0,
      "recordsCollected": 0,
      "truncated": false,
      "error": { "code": "sanitized_code", "message": "Sanitized message." }
    },
    "testrail": {},
    "github": {}
  },
  "completeness": {
    "status": "pending|complete|partial|unavailable|cancelled",
    "complete": false,
    "reasons": ["testrail_budget_exhausted"]
  }
}
```

TestRail and GitHub source objects use the same fields. `error` is `null` when no
sanitized error applies. A budget, timeout, incomplete repository fanout, unavailable
source, or disconnected source always keeps `completeness.complete` false.

`GET` requires `knowledge:read`. Forced refresh and cancellation require
`connections:sync`; refresh returns `202`. All routes validate the canonical Jira key,
apply the normal subject rate limit, and enforce product authorization.

Jobs and positive/negative Jira receipts are encrypted with AES-256-GCM and atomically
replaced beneath `TKL_CONTEXT_JOB_DATA_DIR` (default `./data/context-jobs`). The store
contains operational metadata only—no credentials, source payloads, query results, or
connector checkpoints. Pending/running jobs recover at startup; terminal jobs are
retained and pruned. An empty store makes no source call.

Configuration:

- `TKL_CONTEXT_JOB_KEY_REF` (default `env://TKL_CONTEXT_JOB_KEY`; its resolved
  AES-256 key is required and must be distinct from credential-vault/raw-evidence keys
  in production)
- `TKL_CONTEXT_JOB_FRESHNESS_MS` (default `900000`)
- `TKL_CONTEXT_JOB_MAX_ATTEMPTS` (default `3`)
- `TKL_CONTEXT_JOB_RETRY_BASE_MS` (default `1000`)
- `TKL_CONTEXT_JOB_RETRY_MAX_MS` (default `30000`)
- `TKL_CONTEXT_JOB_CONCURRENCY` (default `2`)
- `TKL_CONTEXT_JOB_RETENTION_MS` (default `604800000`)
- `TKL_CONTEXT_JOB_MAX_JOBS` (default `10000`)

Run focused coverage with `npm run test:context-jobs --workspace @tkl/api`.

### Demand-scoped invalidation and Jira webhooks

`POST /v1/webhooks/jira` is a signature-authenticated ingress route. It has no
caller-supplied product selector: the deployment maps the one route to
`TKL_PRODUCT_ID`/the loaded product configuration, so a signed payload cannot route
itself into another product. Only `jira:issue_updated` is accepted, and the canonical
issue-key project must be in `TKL_JIRA_WEBHOOK_ALLOWED_PROJECTS`.

Jira must send:

- `x-hub-signature-256: sha256=<64 lower-case hex characters>`, computed as HMAC-SHA256
  over the exact raw HTTP request bytes.
- `x-atlassian-webhook-identifier: <1-128 safe characters>`, used as the durable
  delivery ID.
- `content-type: application/json`.
- A body no larger than 64 KiB containing `webhookEvent`, Jira's millisecond
  `timestamp`, and `issue.key`.

The signature is timing-safely verified before JSON parsing. Valid deliveries return
`202` with one disposition: `accepted`, `ignored:duplicate`, `ignored:obsolete`, or
`ignored:not-hot`. A delivery for an unseen ticket is acknowledged as not hot, persists
only a bounded dedupe receipt/digests, creates no job, and makes no source call.
Accepted deliveries stale the source and queue one coalesced refresh; events received
during a run persist one refresh-after-run rather than starting concurrent work.

Webhook configuration:

- `TKL_JIRA_WEBHOOK_ENABLED=true` enables the route. It is disabled by default.
- `TKL_JIRA_WEBHOOK_ALLOWED_PROJECTS=STT,QA_CORE` is the required project allowlist
  (or supply `sources.jira.allowedProjects` in the loaded product configuration).
- `TKL_JIRA_WEBHOOK_SECRET_REF=env://TKL_JIRA_WEBHOOK_HMAC_SECRET` is required in
  production when enabled and is resolved through the deployment credential resolver.
- `TKL_JIRA_WEBHOOK_SECRET` may be used explicitly only outside production.

There is no hardcoded secret or fallback. The resolved HMAC secret must contain at
least 32 bytes. Invalid signatures, malformed payloads, unsupported events, and scope
violations fail closed with sanitized errors. Payloads, signatures, credentials, and
provider responses are never logged or stored by the webhook path.

### JIT context operations

`GET /v1/context-operations?productId=<id>` requires `connections:read`, normal
product authorization, request rate limiting, and an exact query shape. It returns
sanitized product-scoped durable job-state and receipt counts; in-memory queued,
active, delayed-retry, and paused state; oldest queue age; attempt/retry totals;
global job capacity; last successful completion and sanitized failure metadata;
invalidation disposition counts; last invalidation; and the last retention sweep.
Issue keys and delivery digests are not returned.

`GET /health` registers a `ticket-context` component dynamically. Public output
contains only aggregate `healthy`/`degraded` status and reason codes. It degrades for
90% or greater job capacity, excessive queue age, excessive delayed retries, or an
unrecovered worker/persistence failure—not because a ticket is partial or unavailable.

Additional configuration:

- `TKL_CONTEXT_JOB_RECEIPT_RETENTION_MS` (default `604800000`)
- `TKL_CONTEXT_JOB_MAX_RECEIPTS` (default `20000`)
- `TKL_CONTEXT_JOB_RETENTION_SWEEP_INTERVAL_MS` (default `3600000`)
- `TKL_CONTEXT_JOB_MAX_QUEUE_AGE_MS` (default `300000`)
- `TKL_CONTEXT_JOB_MAX_RETRY_BACKLOG` (default `100`)

Terminal jobs and delivery receipts are swept periodically and at startup. Pending or
running jobs are never deleted; the timer is unreferenced and is stopped during
graceful shutdown. See
[`../../docs/runbooks/jit-context-operations.md`](../../docs/runbooks/jit-context-operations.md).

### Ask TKL

`POST /v1/ask?productId=<id>` accepts:

```json
{
  "question": "What changed under STT-3731, which tests cover it, and what remains unverified?",
  "workItemId": "STT-3731"
}
```

`workItemId` is optional when the question contains one unambiguous Jira key. The
endpoint requires `ask:read`, applies normal product/tenant isolation and rate
limits, and emits the `ask_tkl` audit operation.

Ask TKL is a deterministic read-only orchestrator, not a general-purpose chat model. It
classifies the question and delegates to the existing Coverage, Test Designer,
TestRail Improvement, Automation Designer, Reliability, or Knowledge Curator capability,
or performs a bounded canonical search. Its response includes the interpreted scope,
answer, direct TKL provenance links, freshness, confidence, open conflicts, limitations,
next actions, and the capabilities used. It abstains when a question is unsupported,
requires a missing Jira scope, has conflicting Jira keys, or lacks citable evidence.
No external LLM or source-system write path is used.

### Approved actions (Phase 8)

Approved actions use three deliberately separate contracts:

1. **Preview** validates an action-specific target and proposed changes, rejects
   secret-like fields, captures immutable source versions, and returns a SHA-256
   `previewHash`, risk, required permission, expiry, and executability.
2. **Approval** records the authenticated subject's explicit approval of that exact
   preview ID and hash. It is product-, subject-, action-, permission-, and expiry-bound.
3. **Execution** requires that one-time approval, the exact preview hash, an idempotency
   key, and the exact source versions. A local source-version reader, when available,
   verifies the synchronized version again before the blocked execution is recorded.

Supported contracts are `testrail.case.create`, `testrail.case.update`,
`github.branch.create`, and `github.pull-request.create`. Each has a distinct permission:

- `actions:testrail-case-create`
- `actions:testrail-case-update`
- `actions:github-branch-create`
- `actions:github-pull-request-create`

No role or local development token receives these permissions automatically. No external
executor, write credential, or write HTTP client exists in this implementation. A valid
approved execution therefore
returns `status: "blocked"`, reason `external_writes_not_configured`, and
`externalCallMade: false`. The one-time approval is consumed by that attempt so replay
cannot become an action after configuration changes.

Preview, approval, and execution records are durable JSON under
`TKL_APPROVED_ACTION_DATA_DIR` (default `./data/approved-actions`), scoped by tenant and
product and written through atomic replacement. They contain no source credentials.
Lifecycle-specific audit events record subject, product, action type, IDs, immutable hash,
outcome, and whether an external call occurred. See
[`../../docs/runbooks/approved-write-actions.md`](../../docs/runbooks/approved-write-actions.md).

`GET /health` returns `{ status, service, correlationId, dependencies }`, where
`dependencies` is a correlated health report (see `packages/observability`) built from
an injected `healthRegistry`. Deployments can record connector/application health there
so operators see one correlated status across connectors, the API, and the MCP gateway.

Knowledge queries may include the optional source filter `source=testrail` (or another
registered source such as `jira`, `github`, `confluence`, or `reportportal`). The API
passes this source identifier to the injected knowledge service; source connector and
normalization logic remain outside the API.

Product-scoped resource reads validate the `tkl://` URI and delegate content to the
injected knowledge service. They remain read-only and require `knowledge:read`.

### Conflict review (`UI-104`)

`POST /v1/knowledge/conflicts/review?productId=<id>` records a human reviewer's decision
on an open knowledge conflict; the MCP gateway exposes read-only capabilities only and
never this action. It
requires the `conflicts:review` permission (in addition to product access) and a JSON
request body:

```json
{
  "conflictId": "conflict:...",
  "approvedClaimIds": ["claim:..."],
  "note": "optional reviewer note"
}
```

`approvedClaimIds` must be a non-empty array (at most 50 entries) naming the claim(s)
the reviewer approves; every other claim referenced by the conflict is rejected. `note`
is optional and, when present, must be a non-empty string of at most 2000 characters.
The `reviewerId` and `reviewedAt` recorded against the review are always derived
server-side from the authenticated subject and the server clock — the client cannot
supply or override them, preserving the integrity of the durable review audit trail in
`packages/knowledge-store`.

Conflicts can only move from `open` to `reviewed`; there is no supported "reopen"
operation. Reviewing a conflict that is already reviewed returns
`409 conflict_already_reviewed`; reviewing an unknown or out-of-scope conflict returns
`404 conflict_not_found`; an invalid `approvedClaimIds` selection returns
`400 invalid_request`.

`createKnowledgeService` exposes `ingest(records)` for fixture-backed integration and
implements all read operations against canonical knowledge. The server starts with an
empty in-memory store until connector orchestration supplies evidence; it does not call
source systems directly. Each service instance is bound to one `tenantId` and maintains
an isolated store per product so identical source identifiers cannot overwrite another
product's knowledge. Set `TKL_TENANT_ID` for the local server when the tenant is not
`solera`. Every authenticated knowledge request must carry the same tenant in its
verified authorization context; a missing or different tenant fails closed.

Ingestion batches normalize all supported records before writing entities, claims, and
trace links, so cross-source relationships do not depend on record order. Jira comments
remain reported as ignored until a dedicated normalizer is available. GitHub changed-file
records are instead retained in a product-scoped read-only repository evidence index for
the Automation Designer; file paths can establish test/page-object/fixture/utility
conventions, while executable code and exact commands are withheld until corresponding
file or manifest contents are synchronized. Any other unsupported content type fails the
batch.
Links whose referenced entity has not arrived yet are held inside the product-scoped
in-memory composition and materialized when a later ingestion batch adds the endpoint.
Each ingestion result reports unresolved link IDs and endpoints. Pending links are
bounded by `maxPendingTraceLinks` (default `1000`); exceeding the limit fails ingestion
instead of silently consuming unbounded memory.

## Authentication and product isolation

`/health` is public. All `/v1/*` knowledge routes require an `Authorization: Bearer
<token>` header. The resolved context must include `subject`, `roles`, `permissions`, and
`productIds`; the requested `productId` must be assigned to the subject or be covered by
`"*"` for an authorized administrator.

For local development, the server can resolve opaque tokens from `TKL_AUTH_TOKENS`.
This is a composition-root test resolver, not a production identity provider.
Production authentication must use an approved identity platform, such as Entra ID,
and production secrets must use an approved secret manager such as Azure Key Vault.
The provider-neutral OIDC/JWKS verifier is wired in one place,
`createIdentityVerifier()` in `packages/ops/src/identity-provider.js`, and is passed to
`createConfiguredAuthenticator({ verifyToken, mapClaims })`. It requires an explicit HTTPS
issuer and audience, verifies the JWT signature and temporal claims, and maps only
deployment-selected authorization claims. Without complete configuration, production
startup fails rather than trusting claims a caller asserted about itself.

API requests emit structured audit events with a correlation ID, operation, subject,
product, outcome, status, and duration. Sensitive fields are redacted before the
configured audit sink receives them.

The deployment must terminate HTTPS/TLS 1.2 or 1.3 before exposing the API. The local
HTTP listener is intended only for development and smoke testing.
