# TKL Product Reasoning Audit — 2026-09-18

## Scope

This audit covers Phase 0 of the Product Reasoning Agent plan:

1. Locate the real TKL repository, chat/orchestrator, and MCP gateway.
2. Verify the response contract.
3. Verify source boundaries and provenance.
4. Verify authentication, authorization, and read/write boundaries.
5. Identify blockers before implementing broader product reasoning.

## Repository and runtime inventory

| Area | Location | Status | Finding |
|---|---|---:|---|
| TKL monorepo | `qa-tkl-mcp-f5/` | PASS | Real implementation found under `C:\Users\Miguel.Barajas\source\repos`. |
| Chat/orchestrator | `apps/api/src/agents/ask-tkl-agent.js` | PASS | Ask TKL is implemented as a deterministic, product-scoped orchestrator. |
| API route | `apps/api/src/app.js` (`POST /v1/ask`) | PASS | Request parsing, authorization, intent permission checks, and audit operation exist. |
| MCP gateway | `apps/mcp-gateway/` | PASS | Thin Streamable HTTP gateway delegates to the Application API. |
| Dashboard | `apps/dashboard/` | PASS | Ask TKL and operational pages are present. |
| Durable knowledge | `packages/knowledge-store/`, local SQLite demo | PASS | Canonical knowledge and serving projections are implemented. |
| Source connectors | `plugins/connectors/` | PASS | Jira, GitHub, TestRail, Confluence, and ReportPortal plugins exist. |

## Contract audit

The Ask TKL response contract is already stronger than a plain chat response. It requires:

- `answer`
- `intent`
- `scope`
- `citations`
- `freshness`
- `confidence`
- `conflicts`
- `limitations`
- `nextActions`
- `toolCalls`

This is defined in `packages/contracts/src/index.js` under `ask_tkl` and is covered by
`apps/api/test/ask-tkl-agent.test.js`.

### Contract result: PASS with one extension required

The existing contract supports grounded product answers, but it does not yet distinguish
the source mode that produced the answer. The next contract revision should add optional
metadata for:

- `evidenceMode`: `documented | code | live-observed | combined`
- `investigation`: planned tools, executed tools, and stop reason
- `claims`: fact/inference/unknown classification

These fields should be additive and remain optional until all consumers are migrated.

## Source and provenance audit

### Implemented

- Raw evidence and canonical normalization are separate.
- Source-specific provenance is preserved.
- Ask TKL builds authenticated TKL provenance resource links.
- Freshness is calculated from citation timestamps.
- Open conflicts lower confidence.
- Product scope is carried through API and MCP calls.
- Source credentials are kept behind the credential vault and are not returned to the
  dashboard or MCP caller.

### Gaps

1. The current Ask TKL search is bounded canonical search, not entity/relationship-aware
   product reasoning.
2. The source context is used by specialized agents, but there is no generic planner that
   decides when Jira, GitHub, TestRail, Confluence, ReportPortal, or live UI evidence is
   required.
3. GitHub is available as a source connector, but Ask TKL has no code-intelligence
   investigation step for finding symbols, references, or implementation behavior.

## Security and MCP audit

### Implemented

- Ask TKL requires `ask:read`.
- Downstream capabilities use separate read permissions.
- The MCP gateway exposes only allowlisted tools/resources.
- The gateway rejects unknown methods, tools, resource URIs, and implied writes.
- MCP receives no source credentials.
- Gateway sessions are bound to an authorization fingerprint.
- Gateway and API emit structured audit events.
- Approved writes are separated into an explicit action path.

### Gap

The current MCP gateway is intentionally read-only and does not expose Playwright/CDP
investigation tools. This is correct for the current MVP, but it means TKL cannot verify
the live product when synchronized evidence is incomplete or stale.

Any future CDP capability must be a separate allowlisted provider with:

- explicit product/environment scope;
- read-only default behavior;
- bounded navigation and request limits;
- screenshot/network/console redaction;
- no credential readback;
- an audit event for every investigation action;
- explicit human approval for mutations.

## Ask TKL capability audit

| Capability | Current state | Result |
|---|---|---:|
| Exact Jira summary | Implemented | PASS |
| Coverage/context question | Implemented | PASS |
| Test design | Implemented through specialized agent | PASS |
| TestRail improvement | Implemented through specialized agent | PASS |
| Automation design | Implemented as proposal flow | PASS |
| Reliability/defect intelligence | Implemented as bounded capability | PASS |
| Knowledge curation | Implemented as read/review flow | PASS |
| General product question | Bounded canonical search only | PARTIAL |
| Current live behavior question | No CDP investigator | MISSING |
| Code implementation question | No generic code-intelligence planner | PARTIAL |
| Unsupported question abstention | Implemented | PASS |
| Confidence and limitations | Implemented | PASS |
| Conflict reporting | Implemented | PASS |

## Test verification

The targeted API suite completed successfully:

```text
npm test --workspace @tkl/api
```

This includes Ask TKL routing, exact-key grounding, citation/freshness behavior,
conflict handling, unsupported-question abstention, and specialized capability scoping.

## Phase 0 decision

**Status: COMPLETE — implementation baseline for Phases 1–5 is in place.**

The repository and contracts are not missing; the earlier assumption that only the
manual and screenshots were available was incorrect because the executable TKL lives in
`qa-tkl-mcp-f5`.

The highest-value next implementation is not another connector. It is a **Product
Reasoning Planner** that:

1. classifies intent and product domain;
2. selects the minimum source set;
3. detects when canonical evidence is insufficient;
4. creates a bounded investigation plan;
5. delegates to code or live-UI providers when enabled;
6. returns evidence mode, claims, confidence, conflicts, and limitations.

Phase 1 should remain read-only and should not add external writes or unrestricted
browser automation. The implementation now includes:

- a domain-aware Product Reasoning Plan;
- source selection and evidence-mode metadata;
- claim classification (`fact`, `finding`, `inference`);
- a governed investigation-provider boundary with an explicit unavailable state;
- a review-only Ask feedback queue that never mutates canonical knowledge automatically.

The remaining deployment work is wiring an approved code-search provider and an approved
Playwright/CDP provider into the investigation boundary. Their absence is explicit in
the response rather than silently treated as evidence.

## Dashboard audit

### Result: PASS with a targeted usability improvement

`apps/dashboard/src/pages/AskTklPage.tsx` already presented the core trust signals:
status, confidence, scope, freshness, citations, conflicts, limitations, next actions,
and read-only capabilities. The new backend metadata was not visible, however, which
made it difficult for a user to tell whether an answer was documented, code-grounded,
or waiting for live investigation.

The dashboard now renders the following optional fields without breaking older API
responses:

- `evidenceMode`;
- investigation status and bounded investigation steps;
- claim classification for facts, findings, and inferences.

The additions use the existing card, badge, details, and warning patterns. No full visual
redesign is needed at this stage.

Validation completed:

```text
npm test --workspace @tkl/dashboard       # 128 tests passed
npm run typecheck --workspace @tkl/dashboard
npm run build --workspace @tkl/dashboard
npm run lint --workspace @tkl/dashboard  # existing useAsync exhaustive-deps warning only
```

The feedback queue is not shown in the UI yet because the current backend feedback
service is an internal review-queue abstraction and has no authenticated API route.
Exposing a feedback control should be a separate change with reviewer identity,
authorization, persistence, and audit semantics.
