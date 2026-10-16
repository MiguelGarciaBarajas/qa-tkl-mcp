# Test Knowledge Library

Repository: `Solera-Engineering/qa-tkl-mcp-f5`

The Test Knowledge Library (TKL) is a modular quality-context platform that collects,
normalizes, relates, and exposes trusted testing knowledge across products.

The accepted architecture uses source connector plugins, canonical knowledge and
traceability, a TKL application API, and a thin MCP gateway. Markdown is an optional
generated export and review format, not the operational source of truth.

## Delivery Status

- Pilot workspace: Solera / Vehicle Solutions / TitleTec / Titling / FL (`fl-titling`)
- Implemented sources: Jira, GitHub, TestRail, Confluence, and ReportPortal
- First capability: story context, traceability, and coverage-gap analysis
- First consumer: read-only Coverage and Traceability Analyst
- Deployment: modular monorepo, initially runnable as one process

The complete source path uses the same architecture:

```text
Jira / GitHub / TestRail / Confluence / ReportPortal
  -> connector raw evidence
  -> canonical test and execution knowledge
  -> links to Jira requirements and GitHub automation
  -> API and read-only MCP context
  -> dashboard coverage and evaluation
```

All connectors can be demonstrated with sanitized fixtures. Live sync requires an
authorized owner to provide the relevant source URL, scope, and credential through Source
Connections.

## Unified JIT Intelligence

The dashboard starts at **Search & Investigate**. Jira keys, TestRail case IDs, prefixed
ReportPortal identities (`rp:<uniqueId-or-codeRef>`), and names are resolved local-first.
On an exact local miss, TKL performs only the smallest permitted remote lookup:

- Jira: one issue plus bounded related evidence.
- TestRail: one `get_case/:id` request.
- ReportPortal: one bounded history lookup by exact `uniqueId` and `codeRef`.
- Confluence: one CQL result page per allowlisted space, only for a text miss.
- QA brain: optional local, allowlisted Markdown and JSON knowledge loaded from
  `TKL_QA_BRAIN_PATH`; credentials, test data, binaries, generated artifacts, and
  attachments are excluded.

The selected artifact becomes the investigation anchor. Its bounded Evidence Graph exposes
grounded links and explicitly leaves missing relationships unresolved. Guided actions then
offer the applicable workflow: test-case improvement, reliability/flaky analysis, coverage
review, test design, or an evidence-grounded TKL question. These paths do not trigger a
full source synchronization.

## Repository Map

```text
apps/       Deployable entry points: API, MCP gateway, and dashboard
packages/   Shared contracts, core orchestration, storage, registry, and testkit
plugins/    Source connectors, normalizers, and analyzers
config/     Product configuration without secrets
scripts/    Repository tooling: CI quality gate, secret scan, dependency audit
tests/      Contract, integration, end-to-end tests, and fixtures
docs/       Architecture decisions, proposal, team ownership, and runbooks
```

## Start Here

1. Read `AGENTS.md`.
2. Read `docs/architecture/ADR-001-Modular-TKL-with-MCP.md`.
3. Read `docs/team/TKL-Team-Work-Plan.md`.
4. Read `docs/team/TKL-Phase-2-TestRail-Plan.md`.
5. Read `docs/team/TKL-Workstream-Implementation-Guide.md`.
6. Read `docs/team/TKL-Delivery-Backlog.md`.
7. Identify your assigned workstream.
8. Implement the first ready task assigned to you against shared contracts and the common
   vertical slice.

For the real local API/dashboard demonstration, see
[`docs/runbooks/local-demonstration.md`](docs/runbooks/local-demonstration.md).
For the end-to-end Jira, TestRail, ReportPortal, Confluence, and Evidence Graph test flow,
see [`docs/runbooks/unified-intelligence-testing.md`](docs/runbooks/unified-intelligence-testing.md).

## Verification

```bash
npm run gate              # aggregate quality gate: everything below, in CI order
```

Individual commands:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run test:contract
npm run test:integration
npm run scan:secrets      # committed-credential scan (Node + git only)
npm run audit:deps        # npm advisory policy; fails closed if the registry is unreachable
npm run test:e2e          # browser slice; first run: npm run test:e2e:install
```

`npm run test:e2e` drives a real Chromium browser through the dashboard against a local
TKL Application API seeded with sanitized Jira, GitHub, and TestRail fixtures - navigation,
traceability, coverage, provenance, and an approved conflict review through the real HTTP
review endpoint. See [`docs/runbooks/dashboard-e2e.md`](docs/runbooks/dashboard-e2e.md).

## Quality Gate

`.github/workflows/pr-quality-gate.yml` runs on every pull request against `main` with
read-only permissions, a Node version pinned in `.nvmrc`, `npm ci` against the committed
lockfile, and every action pinned to an immutable commit SHA. It runs lint, typecheck,
build, unit, contract, integration, and real-Chromium end-to-end checks in one job (a
single `npm ci`), plus a parallel supply-chain job that scans for committed credentials and
enforces the dependency advisory policy. A single aggregated `Required checks` status is the
one name to protect on `main`.

`npm run gate` is the local equivalent. It propagates real exit codes, never reports a
skipped step as a pass (`--skip-e2e` yields `INCOMPLETE`, exit 2), and keeps the live-source
smoke test opt-in (`--with-live-smoke`, never run by CI). See
[`docs/runbooks/ci-quality-gate.md`](docs/runbooks/ci-quality-gate.md) for the dependency
policy, waiver rules, and branch-protection setup.

## Scheduled Sync

Incremental sync is a single bounded run per external trigger - there is no embedded
scheduler, daemon, or timer. A cron/job runner invokes:

```bash
npm run sync:run -- --print-schedule   # configured cadence and its approval status
npm run sync:run -- --dry-run          # plan only: no source contact, no commits
npm run sync:run                       # one incremental tick for fl-titling
npm run sync:run -- --retention-report # non-destructive retention report
```

Checkpoints are durable, so a restarted run resumes from the last committed cursor; a
failed run never advances the cursor past the failure, and replays require explicit
confirmation and never rewind a checkpoint. Run exactly one ingestion process per
tenant/product scope. See [`packages/sync-coordinator/README.md`](packages/sync-coordinator/README.md)
and [`docs/runbooks/scheduled-sync.md`](docs/runbooks/scheduled-sync.md).

## Official Documents

- [Architecture decision](docs/architecture/ADR-001-Modular-TKL-with-MCP.md)
- [Architecture overview](docs/architecture/TKL-Architecture-Overview.md)
- [Detailed proposal](docs/architecture/TKL-MCP-Proposal.md)
- [Team work plan](docs/team/TKL-Team-Work-Plan.md)
- [Team onboarding](docs/team/TKL-Team-Onboarding.md)
- [Phase 2 TestRail plan](docs/team/TKL-Phase-2-TestRail-Plan.md)
- [Workstream implementation guide](docs/team/TKL-Workstream-Implementation-Guide.md)
- [Complete delivery backlog](docs/team/TKL-Delivery-Backlog.md)
- [MCP gateway transport and runbook](docs/runbooks/mcp-gateway.md)
- [Dashboard end-to-end slice runbook](docs/runbooks/dashboard-e2e.md)
- [CI quality gate runbook](docs/runbooks/ci-quality-gate.md)

## MCP Access

Agent consumers connect to the gateway at `POST /mcp` using JSON-RPC 2.0 over Streamable
HTTP: `initialize` negotiates the protocol revision and returns an `Mcp-Session-Id`,
`notifications/initialized` completes the handshake, and `DELETE /mcp` terminates the
session. The exposed surface stays read-only - five allowlisted tools and four
product-scoped resource templates, all served by the TKL Application API. Authentication
is required on every request, and the gateway publishes OAuth protected-resource metadata
at `/.well-known/oauth-protected-resource` from configured issuer/resource values only.
See [`apps/mcp-gateway/README.md`](apps/mcp-gateway/README.md).

## Current Status

The five Phase 1 workstreams have implementation scaffolds. Phase 2 is active and adds
TestRail as a read-only source while preserving Jira/GitHub behavior. Live TestRail
configuration is intentionally pending authorized external input.
