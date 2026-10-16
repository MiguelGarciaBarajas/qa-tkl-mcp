# Dashboard End-to-End Slice (INT-102)

Browser-level verification of the shared vertical slice: sanitized Jira, GitHub, and
TestRail fixtures -> canonical knowledge -> TKL Application API -> dashboard -> human
conflict review -> updated state.

A real Chromium browser drives the real dashboard against a real local Application API.
Nothing in this suite stubs the application layer, and no external source system is
contacted.

## Commands

```bash
npm run test:e2e:install   # one-time: download the Chromium build Playwright pins
npm run test:e2e           # run the browser slice
npx playwright test --ui   # interactive debugging
npx playwright test --headed --project=chromium
```

Both commands work identically on Windows, macOS, and Linux: every path is resolved from
`import.meta.url`, processes are spawned with `process.execPath` (no shell), and no
OS-specific command appears in `package.json`.

Typecheck the harness with `tsc -p tests/e2e/tsconfig.json` (already included in
`npm run typecheck`).

## What the run does

| Step | File | Behavior |
|---|---|---|
| Reserve ports | `tests/e2e/support/servers.ts` | Binds `127.0.0.1:0`, records the port, releases it, then starts the child on that port. No fixed port is ever assumed, so parallel checkouts/CI jobs do not collide. |
| Mint a token | `tests/e2e/support/servers.ts` | Generates a random per-run bearer token and the matching development auth context (`reviewer` role; `knowledge/coverage/traceability/conflicts` read plus `conflicts:review`; product `fl-titling` only). |
| Start the API | `tests/e2e/harness/api-server.mjs` | Test-only composition root: seeds the knowledge service with committed fixtures, records fixture-derived connector health, then serves the production application/transport/policy/audit stack. |
| Start the dashboard | `tests/e2e/support/servers.ts` | Starts a real Vite server for `apps/dashboard` on a reserved port, with a per-instance temporary `.env` directory providing `VITE_TKL_API_BASE_URL`, `VITE_TKL_API_TOKEN`, and `VITE_TKL_PRODUCT_ID`. |
| Drive the browser | `tests/e2e/dashboard-vertical-slice.e2e.spec.ts` | Navigates with accessible selectors and asserts user-observable content and the persisted review. |
| Tear down | worker fixture teardown | Stops the Vite server, terminates the API child process, and deletes the temporary env directory - including when a test fails. |

### Seeded fixtures

`tests/e2e/harness/fixtures.mjs` reads only committed, sanitized fixtures:

- `tests/fixtures/golden-dataset/tickets/FLT-2001` - Jira story plus the GitHub pull
  request that explicitly references it (fully covered requirement).
- `tests/fixtures/golden-dataset/tickets/FLT-2023` and `FLT-2024` - two Jira revisions
  that disagree, so the conflict analyzer raises reviewable conflicts.
- `tests/fixtures/testrail/*.json` - suite, case, run, and result, re-pointed at
  `FLT-2001` through the same `custom_jira_references` / `custom_github_automation`
  mapping the FL Titling product configuration declares (identical to `INT-101`).

### Covered stakeholder flow

1. **Connector health** - Jira, GitHub, and TestRail rows report `Healthy` and credential
   status `valid`; no credential value or `secret://` reference is rendered.
2. **Story traceability and provenance** - `requirement:FLT-2001` lists its GitHub
   automated test and TestRail manual test with `Automated`/`Manual` type, `GitHub (v...)`
   / `TestRail (v...)` provenance, and `Explicit` link confidence.
3. **Coverage** - the requirement reports `1/1` with `explicit` link confidence.
4. **Loading state** - the real conflicts response is delayed (the request is still served
   by the API, not stubbed) to observe `Loading knowledge conflicts...`.
5. **Conflict review** - submitting with no claim selected is refused client-side;
   approving the superseding revision's claim `POST`s to
   `/v1/knowledge/conflicts/review` and returns `200`; the card flips to `Reviewed`.
6. **Persistence** - after a reload the reviewed conflict is no longer open while the
   untouched conflict still is, confirmed again by reading the API directly over HTTP.
7. **Stale-tab protection** - a tab loaded before the review cannot overwrite the durable
   decision; the API rejects the second submission and the dashboard surfaces the error.
8. **Authorization** - unauthenticated requests get `401`; a request for another product
   with a valid token gets `403 product_access_denied`; a dashboard configured with a
   rejected token renders `Failed to load conflicts` and no conflict cards.

## Security boundaries

- **Fixture ingestion is never exposed over HTTP.** Seeding happens in-process, before the
  server listens, through the `createKnowledgeService().ingest()` composition seam. No
  ingestion route exists in the production API or in the harness.
- **Production authentication is unchanged.** The harness uses
  `createConfiguredAuthenticator()` exactly as `apps/api/src/server.js` does. The static
  `TKL_AUTH_TOKENS` map is the development-only path that `packages/ops` already fails
  closed on in production.
- **The harness cannot be deployed.** `tests/e2e/harness/api-server.mjs` throws when
  `NODE_ENV=production` and when `TKL_AUTH_TOKENS` is absent.
- **No secret is committed.** The bearer token is random per run and lives only in process
  environment variables and a temporary `.env` file that teardown deletes. It is a TKL API
  token, never a source-system credential.
- **Same-origin by design.** The dashboard reaches the API through the Vite dev server's
  `/v1` and `/health` proxy, so the production API is not given a permissive CORS policy
  just to make a browser test pass.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Executable doesn't exist at ...chromium...` | Browser binaries were never downloaded. | `npm run test:e2e:install`. |
| `Timed out starting the harness API` | The API child failed during seeding; its stderr is included in the error. | Run `node --experimental-strip-types tests/e2e/harness/api-server.mjs` with `TKL_AUTH_TOKENS` set to reproduce. |
| `Port ... is already in use` | Another process grabbed the reserved port between reservation and bind. | Re-run; ports are re-reserved on every run. |
| Dashboard shows `Failed to load ...` | The API rejected the token, or the proxy target is wrong. | Check the API child's audit/stderr output and the generated temporary `.env`. |
| Leftover `tests/e2e/.tmp/*` directories | A run was killed before teardown. | Safe to delete; the directory is git-ignored. |

Artifacts (`test-results/`, `playwright-report/`) are git-ignored; traces and screenshots
are retained only for failures.

## Known limitations

- The suite pins one browser (Chromium). Cross-browser coverage is not part of `INT-102`.
- The knowledge store is in-memory, so state lives only for the duration of a run. A
  persistent backend is still an open platform decision.
- Reviewing an already-reviewed conflict currently returns `404 conflict_not_found`
  instead of `409 conflict_already_reviewed`, because the Application API resolves
  conflicts through `listOpenConflicts()`. The durable decision still wins and the user
  sees an explicit error; refining that status code belongs to the API workstream and the
  test accepts either wording.
- `EVAL-102` evaluation metrics are still not exposed by the API, so the dashboard's
  Evaluation page is out of scope here.
