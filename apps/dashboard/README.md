# TKL Dashboard

Operations dashboard for the Test Knowledge Library (owned by the **Dashboard and
Evaluation** workstream — see `docs/team/TKL-Team-Work-Plan.md`).

Pages:

- **Connector Health** — sync status, error rate, and credential *status* (never values)
  per connector.
- **Story Traceability** — requirement → test links per story, with link confidence and
  human-review state.
- **Coverage Gaps** — requirements with missing/partial test coverage, showing
  numerator/denominator and link confidence, not just a link count.
- **Ask TKL** — chat-like, read-only questions routed to deterministic TKL capabilities,
  with citations, freshness, confidence, conflicts, limitations, and explicit abstention.
- **Knowledge Conflicts** — conflicting claims from different sources, pending human
  review (approve / reject / needs correction).
- **Evaluation** — precision, recall, provenance completeness, freshness, latency, and QA
  acceptance rate against the golden dataset.
- **Approved write actions** — immutable action preview, risk, required permission,
  expiry, and environment readiness. The current environment is visibly blocked and
  never renders an approval control for a non-executable preview.

## Status

The dashboard renders against the **real TKL Application API** whenever
`VITE_TKL_API_BASE_URL` is configured; mock data is limited to isolated tests, development,
and explicit demo mode (`VITE_TKL_DEMO_MODE=true`), and production fails closed when API
configuration is absent. The remaining seams are:

- `src/contracts/types.ts` — temporary UI-facing types. Replace them with compatible
  imports/adapters from `packages/contracts`.
- `src/mocks/fixtures.ts` — small synthetic fixture set used by `MockTklApiClient` for
  isolated tests and offline development only.
- `src/api/client.ts` — defines `TklApiClient`; `getTklApiClient()` selects the real
  `HttpTklApiClient` (`src/api/httpClient.ts`) or the mock. Page components depend on the
  interface, not an implementation.
- Evaluation metrics are not exposed by the API yet (tracked by `EVAL-102`), so that page
  reports a `NotImplementedError` instead of fabricated numbers.

Phase 2 dashboard work adds TestRail connector health, manual-test coverage, execution
freshness, and evaluation fixtures without displaying credential values.

Ask TKL never sends prior conversation history to the API and does not use browser or
model memory to answer product questions. Each turn is independently scoped to the
configured product and optional Jira key. The UI links every returned citation to either
its source URL or the authenticated TKL provenance resource.

Phase 8 is implemented in safe blocked mode. Preview, approval, and execution are
separate API operations. The UI only renders **Approve this exact preview** when the API
returns `executable: true`; the current server and mock client return
`external_writes_not_configured`, so the control is absent and no external call can occur.

## Commands

Run from this directory, or via `npm run <script> --workspace=@tkl/dashboard` from the repo
root:

```
npm run dev         # start Vite dev server
npm run build        # tsc -b && vite build
npm run typecheck    # tsc -b --noEmit
npm run lint         # oxlint
npm run test         # vitest run
```

Run a single test file: `npx vitest run src/App.test.tsx` (from this directory).

Browser-level verification of this app against a real, fixture-seeded API lives in
`tests/e2e` (`npm run test:e2e` from the repo root). See
[`docs/runbooks/dashboard-e2e.md`](../../docs/runbooks/dashboard-e2e.md).
