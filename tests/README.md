# Tests

Test areas:

- `contract`: plugin conformance and shared schema compatibility.
- `integration`: connector-to-knowledge and API/MCP integration, plus the `OPS-101`
  scheduled-sync operational path (`ops-101-scheduled-sync.test.js`: real connector,
  real config-driven composition, real durable encrypted store, simulated restart and
  confirmed replay, with only the HTTP client injected).
- `e2e`: the browser/dashboard vertical slice (`INT-102`) - a real Chromium browser
  driving the real dashboard against a fixture-seeded TKL Application API. See
  [`docs/runbooks/dashboard-e2e.md`](../docs/runbooks/dashboard-e2e.md).
- `fixtures`: sanitized source records and the golden dataset.

## Running

```bash
npm test                 # workspace unit tests
npm run test:contract    # contract tests
npm run test:integration # repository integration tests
npm run test:e2e         # browser slice (after: npm run test:e2e:install)
```

`tests/e2e/harness/` is a **test-only** composition root. It seeds knowledge through the
`createKnowledgeService().ingest()` seam before the server listens; it never exposes
fixture ingestion over HTTP, never relaxes authentication, and refuses to start with
`NODE_ENV=production`.

Tests and fixtures must not contain credentials or restricted production data. The
end-to-end bearer token is generated randomly per run and never written to a committed
file. Durable-store tests write scratch data to a git-ignored `.tmp/` directory inside
their own area and remove it afterwards; the AES key material they use is generated in
the test itself and never protects real evidence.
