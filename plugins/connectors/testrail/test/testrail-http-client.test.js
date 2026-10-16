import assert from "node:assert/strict";
import test from "node:test";
import { createTestRailHttpClient, TestRailHttpError } from "../src/testrail-http-client.js";

const BASE_URL = "https://testrail.example.test";

function fakeResponse({ status = 200, ok = status >= 200 && status < 300, body = "", headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null },
    text: async () => body,
  };
}

function queueFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof next === "function" ? next(url, init) : next;
  };
  return { calls, fetchImpl };
}

const baseOptions = (overrides = {}) => ({
  baseUrl: BASE_URL,
  credentialRef: "secret://testrail/fl-titling",
  resolveCredential: async (ref) => `basic-token-for-${ref}`,
  ...overrides,
});

test("exposes all required capabilities on every constructed client", () => {
  const client = createTestRailHttpClient(baseOptions());
  for (const method of [
    "fetchCase",
    "createCase",
    "createSection",
    "fetchSuites",
    "fetchSections",
    "fetchCases",
    "fetchCasesInSection",
    "fetchCasesByReference",
    "fetchRuns",
    "fetchResults",
  ]) {
    assert.equal(typeof client[method], "function");
  }
});

test("retrieves one exact case without enumerating suites", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ id: 1201, title: "Verify title" }) })
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const result = await client.fetchCase("001201");

  assert.equal(result.id, 1201);
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_case/1201`);
});

test("creates one case in an exact TestRail section", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ id: 4455, title: "Verify valid VIN" }),
    }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const result = await client.createCase("001201", {
    title: "Verify valid VIN",
    refs: "STT-100",
  });

  assert.equal(result.id, 4455);
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/add_case/1201`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: "Verify valid VIN",
    refs: "STT-100",
  });
});

test("loads sections for one exact suite", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ sections: [{ id: 44, suite_id: 12, name: "Regression" }] }),
    }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 25 });

  const result = await client.fetchSections("128", "12");

  assert.deepEqual(result.items, [{ id: 44, suite_id: 12, name: "Regression" }]);
  assert.equal(
    calls[0].url,
    `${BASE_URL}/index.php?/api/v2/get_sections/128&suite_id=12&limit=25`,
  );
});

test("creates one section in an exact TestRail suite", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ id: 44, suite_id: 12, name: "Automation candidates" }),
    }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const result = await client.createSection("128", {
    suite_id: "12",
    name: "Automation candidates",
  });

  assert.equal(result.id, 44);
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/add_section/128`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    suite_id: "12",
    name: "Automation candidates",
  });
});

test("rejects a mismatched exact case response", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ id: 1202 }) })
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(
    client.fetchCase("1201"),
    /does not match the requested ID/
  );
});

test("filters cases by an exact Jira reference inside the allowlisted suite", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ cases: [{ id: 7 }], _links: { next: null } }) })
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 25 });

  const result = await client.fetchCasesByReference(128, 12, "abc-123");

  assert.deepEqual(result, { items: [{ id: 7 }], nextPage: undefined });
  assert.equal(
    calls[0].url,
    `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&refs=ABC-123&limit=25`
  );
});

test("filters cases by an exact section inside the allowlisted suite", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ cases: [{ id: 7 }], _links: { next: null } }),
    }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 25 });

  const result = await client.fetchCasesInSection(128, 12, 44);

  assert.deepEqual(result, { items: [{ id: 7 }], nextPage: undefined });
  assert.equal(
    calls[0].url,
    `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&section_id=44&limit=25`,
  );
});

test("rejects construction without a required dependency", () => {
  assert.throws(() => createTestRailHttpClient({ ...baseOptions(), fetch: null }), /fetch implementation is required/);
  assert.throws(() => createTestRailHttpClient({ ...baseOptions(), resolveCredential: undefined }), /credential resolver function is required/);
  assert.throws(() => createTestRailHttpClient({ ...baseOptions(), credentialRef: "" }), /credentialRef is required/);
  assert.throws(() => createTestRailHttpClient({ ...baseOptions(), baseUrl: "not-a-url" }), /baseUrl must be a valid HTTP\(S\) URL/);
});

test("rejects non-numeric project, suite, and run identifiers before any network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.fetchSuites("not-a-number"), /projectId must be a positive integer/);
  await assert.rejects(client.fetchCase("0"), /caseId must be a positive integer/);
  await assert.rejects(client.fetchCases(128, "not-a-number"), /suiteId must be a positive integer/);
  await assert.rejects(client.fetchRuns("0"), /projectId must be a positive integer/);
  await assert.rejects(client.fetchResults("-1"), /runId must be a positive integer/);
  assert.equal(calls.length, 0);
});

test("resolves the credential per request and sends a Basic auth header without leaking it", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const resolvedRefs = [];
  const client = createTestRailHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolvedRefs.push(ref);
      return "super-secret-basic-token";
    },
  });

  await client.fetchSuites(128);
  assert.deepEqual(resolvedRefs, ["secret://testrail/fl-titling"]);
  assert.equal(calls[0].init.headers.Authorization, "Basic super-secret-basic-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(Object.keys(calls[0].init.headers).length, 2);
  assert.equal(calls[0].url.includes("super-secret-basic-token"), false);
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_suites/128`);
});

test("get_suites is not paginated and always returns a single page", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify([{ id: 1 }, { id: 2 }]) })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  const result = await client.fetchSuites(128);
  assert.deepEqual(result, { items: [{ id: 1 }, { id: 2 }], nextPage: undefined });
});

test("paginates cases, runs, and results using TestRail's native _links.next cursor", async () => {
  const nextCasesLink = "/index.php?/api/v2/get_cases/128&suite_id=12&offset=1&limit=1";
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ cases: [{ id: 1 }], _links: { next: nextCasesLink } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ cases: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchCases(128, 12, 0);
  assert.deepEqual(first, { items: [{ id: 1 }], nextPage: `${BASE_URL}${nextCasesLink}` });
  const second = await client.fetchCases(128, 12, first.nextPage);
  assert.deepEqual(second, { items: [{ id: 2 }], nextPage: undefined });

  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&limit=1`);
  assert.equal(calls[1].url, `${BASE_URL}${nextCasesLink}`);
});

test("paginates runs using the native cursor", async () => {
  const nextLink = "/index.php?/api/v2/get_runs/128&offset=1&limit=1";
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ runs: [{ id: 1 }], _links: { next: nextLink } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ runs: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });
  const first = await client.fetchRuns(128, 0);
  assert.deepEqual(first, { items: [{ id: 1 }], nextPage: `${BASE_URL}${nextLink}` });
  const second = await client.fetchRuns(128, first.nextPage);
  assert.deepEqual(second, { items: [{ id: 2 }], nextPage: undefined });
});

test("paginates results using the native cursor", async () => {
  const nextLink = "/index.php?/api/v2/get_results_for_run/77&offset=1&limit=1";
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: 1 }], _links: { next: nextLink } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });
  const first = await client.fetchResults(77, 0);
  assert.deepEqual(first, { items: [{ id: 1 }], nextPage: `${BASE_URL}${nextLink}` });
  const second = await client.fetchResults(77, first.nextPage);
  assert.deepEqual(second, { items: [{ id: 2 }], nextPage: undefined });
});

/**
 * Documented `_links.next` cursor shapes this client must handle. TestRail
 * 6.7+ emits shape (1) on real deployments -- the API-router pseudo-path
 * *without* the `/index.php?` prefix an actual request needs, and (for
 * `get_cases`) *without* the `suite_id` the original request was scoped to.
 *
 *   1. vendor-relative  `/api/v2/get_cases/128&limit=250&offset=250`
 *   2. query-prefixed   `?/api/v2/get_cases/128&limit=250&offset=250`
 *   3. entry-prefixed   `/index.php?/api/v2/get_cases/128&limit=250&offset=250`
 *   4. absolute         `https://testrail.example.test/index.php?/api/v2/...`
 *
 * Shapes 1-3 are normalized to `${baseUrl}/index.php?<operation>` and then
 * rebuilt from trusted values; shape 4 is additionally subject to the
 * same-origin/HTTPS check, which is what rejects a cross-origin or
 * plaintext-downgraded cursor.
 */
const VENDOR_NEXT_CASES = "/api/v2/get_cases/128&limit=250&offset=250";

test("normalizes TestRail's real vendor-relative _links.next cursor and re-applies the suite scope the API omits", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ cases: [{ id: 1 }], _links: { next: VENDOR_NEXT_CASES } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ cases: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const first = await client.fetchCases(128, 12, 0);
  assert.deepEqual(first.items, [{ id: 1 }]);
  const second = await client.fetchCases(128, 12, first.nextPage);
  assert.deepEqual(second, { items: [{ id: 2 }], nextPage: undefined });

  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&limit=250`);
  // The vendor cursor carries no suite_id at all, so the trusted one is
  // re-applied rather than silently widening the query to the whole project.
  assert.equal(calls[1].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=250&limit=250`);
});

test("normalizes the query-prefixed and entry-prefixed vendor cursor shapes to the same trusted request URL", async () => {
  for (const cursor of [
    `?/api/v2/get_cases/128&limit=250&offset=250`,
    `/index.php?/api/v2/get_cases/128&limit=250&offset=250`,
    `${BASE_URL}/index.php?/api/v2/get_cases/128&limit=250&offset=250`,
  ]) {
    const { calls, fetchImpl } = queueFetch([
      fakeResponse({ status: 200, body: JSON.stringify({ cases: [], _links: { next: null } }) }),
    ]);
    const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await client.fetchCases(128, 12, cursor);
    assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=250&limit=250`);
  }
});

test("normalizes vendor-relative cursors for runs and results", async () => {
  const runs = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ runs: [{ id: 1 }], _links: { next: "/api/v2/get_runs/128&limit=250&offset=250" } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ runs: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const runsClient = createTestRailHttpClient({ ...baseOptions(), fetch: runs.fetchImpl });
  const firstRuns = await runsClient.fetchRuns(128, 0);
  await runsClient.fetchRuns(128, firstRuns.nextPage);
  assert.equal(runs.calls[1].url, `${BASE_URL}/index.php?/api/v2/get_runs/128&offset=250&limit=250`);

  const results = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: 1 }], _links: { next: "/api/v2/get_results_for_run/77&limit=250&offset=250" } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: 2 }], _links: { next: null } }) }),
  ]);
  const resultsClient = createTestRailHttpClient({ ...baseOptions(), fetch: results.fetchImpl });
  const firstResults = await resultsClient.fetchResults(77, 0);
  await resultsClient.fetchResults(77, firstResults.nextPage);
  assert.equal(results.calls[1].url, `${BASE_URL}/index.php?/api/v2/get_results_for_run/77&offset=250&limit=250`);
});

test("collects every page of a multi-page vendor-cursor sync without repeating or skipping an offset", async () => {
  const pages = [
    { cases: [{ id: 1 }, { id: 2 }], _links: { next: "/api/v2/get_cases/128&limit=2&offset=2" } },
    { cases: [{ id: 3 }, { id: 4 }], _links: { next: "/api/v2/get_cases/128&limit=2&offset=4" } },
    { cases: [{ id: 5 }], _links: { next: null } },
  ];
  const { calls, fetchImpl } = queueFetch(pages.map((body) => fakeResponse({ status: 200, body: JSON.stringify(body) })));
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 2 });

  const collected = [];
  let cursor = 0;
  do {
    const page = await client.fetchCases(128, 12, cursor);
    collected.push(...page.items.map((item) => item.id));
    cursor = page.nextPage;
  } while (cursor);

  assert.deepEqual(collected, [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.map((call) => call.url), [
    `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&limit=2`,
    `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=2&limit=2`,
    `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=4&limit=2`,
  ]);
});

test("drops untrusted extra parameters a cursor tries to smuggle in, keeping only the trusted operation, scope, and pagination", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ cases: [] }) })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await client.fetchCases(
    128,
    12,
    "/api/v2/get_cases/128&limit=250&offset=250&created_by=7&filter=secret&project_id=999",
  );
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=250&limit=250`);
});

test("never pages with a larger limit than the configured pageSize, even when the cursor asks for one", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ cases: [] }) })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 100 });
  await client.fetchCases(128, 12, VENDOR_NEXT_CASES);
  assert.equal(calls[0].url, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=12&offset=250&limit=100`);
});

test("rejects a vendor-relative cursor that redirects to another suite, project, run, or operation without resolving the credential", async () => {
  const cases = [
    ["fetchCases", [128, 12, "/api/v2/get_cases/128&suite_id=999&limit=250&offset=250"]],
    ["fetchCases", [128, 12, "/api/v2/get_cases/999&suite_id=12&limit=250&offset=250"]],
    ["fetchCases", [128, 12, "/api/v2/get_runs/128&limit=250&offset=250"]],
    ["fetchRuns", [128, "/api/v2/get_runs/999&limit=250&offset=250"]],
    ["fetchResults", [77, "/api/v2/get_results_for_run/999&limit=250&offset=250"]],
  ];
  for (const [method, args] of cases) {
    const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
    let resolveCalls = 0;
    const client = createTestRailHttpClient({
      ...baseOptions(),
      fetch: fetchImpl,
      resolveCredential: async () => {
        resolveCalls += 1;
        return "token";
      },
    });
    await assert.rejects(client[method](...args), /does not match the expected TestRail API operation/);
    assert.equal(calls.length, 0);
    assert.equal(resolveCalls, 0);
  }
});

test("rejects a cursor whose pagination parameters are not bounded integers, before any credential or network call", async () => {
  const malformed = [
    "/api/v2/get_cases/128&limit=250&offset=abc",
    "/api/v2/get_cases/128&limit=250&offset=-5",
    "/api/v2/get_cases/128&limit=not-a-number&offset=250",
    "/api/v2/get_cases/128&limit=0&offset=250",
  ];
  for (const cursor of malformed) {
    const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
    let resolveCalls = 0;
    const client = createTestRailHttpClient({
      ...baseOptions(),
      fetch: fetchImpl,
      resolveCredential: async () => {
        resolveCalls += 1;
        return "token";
      },
    });
    await assert.rejects(client.fetchCases(128, 12, cursor), /Pagination cursor (offset|limit) must be a/);
    assert.equal(calls.length, 0);
    assert.equal(resolveCalls, 0);
  }
});

test("rejects a vendor-relative cursor that resolves cross-origin or downgrades to plain HTTP", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchCases(128, 12, "https://evil.example/index.php?/api/v2/get_cases/128&limit=250&offset=250"),
    /HTTPS and same-origin/,
  );
  await assert.rejects(
    client.fetchCases(128, 12, "http://testrail.example.test/index.php?/api/v2/get_cases/128&limit=250&offset=250"),
    /HTTPS and same-origin/,
  );
  assert.equal(calls.length, 0);
});

test("maps 401/403/429/5xx to a status-aware, credential-free error", async () => {
  const statuses = [401, 403, 429, 500, 503];
  for (const status of statuses) {
    const { fetchImpl } = queueFetch([
      fakeResponse({ status, body: "sensitive body", headers: { "retry-after": "3" } }),
    ]);
    const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await assert.rejects(client.fetchSuites(128), (error) => {
      assert.ok(error instanceof TestRailHttpError);
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes("sensitive body"), false);
      assert.equal(error.message.includes("sensitive body"), false);
      if (status === 429) assert.equal(error.retryAfter, 3);
      return true;
    });
  }
});

test("treats an aborted request as a timeout without leaking headers", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by controller")));
  });
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.fetchSuites(128), (error) => {
    assert.ok(error instanceof TestRailHttpError);
    assert.equal(error.message, "Request timed out");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("throws a safe error for a malformed JSON response", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "not-json{" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSuites(128), (error) => {
    assert.ok(error instanceof TestRailHttpError);
    assert.equal(error.message, "Response body was not valid JSON");
    assert.equal(error.status, 200);
    return true;
  });
});

test("rejects a plain-HTTP, non-loopback baseUrl by default and requires an explicit opt-in for loopback HTTP", () => {
  assert.throws(
    () => createTestRailHttpClient({ ...baseOptions(), baseUrl: "http://testrail.internal" }),
    /baseUrl must use HTTPS/,
  );
  assert.throws(
    () => createTestRailHttpClient({ ...baseOptions(), baseUrl: "http://localhost:8080" }),
    /baseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createTestRailHttpClient({
    ...baseOptions(),
    baseUrl: "http://localhost:8080",
    allowInsecureLoopback: true,
  }));
  assert.doesNotThrow(() => createTestRailHttpClient({
    ...baseOptions(),
    baseUrl: "http://[::1]:8080",
    allowInsecureLoopback: true,
  }));
});

test("rejects a _links.next cursor that resolves cross-origin without resolving the credential or calling fetch again", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ cases: [{ id: 1 }], _links: { next: "https://evil.example/index.php?/api/v2/get_cases/128" } }),
    }),
  ]);
  let resolveCalls = 0;
  const client = createTestRailHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolveCalls += 1;
      return `token-for-${ref}`;
    },
  });

  const first = await client.fetchCases(128, 12, 0);
  assert.equal(resolveCalls, 1);
  await assert.rejects(client.fetchCases(128, 12, first.nextPage), /HTTPS and same-origin/);
  assert.equal(calls.length, 1);
  assert.equal(resolveCalls, 1);
});

test("rejects a same-origin _links.next cursor that points at a different project's suites without resolving the credential", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  let resolveCalls = 0;
  const client = createTestRailHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolveCalls += 1;
      return `token-for-${ref}`;
    },
  });

  await assert.rejects(
    client.fetchSuites(128, `${BASE_URL}/index.php?/api/v2/get_suites/999`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
  assert.equal(resolveCalls, 0);
});

test("rejects a same-origin _links.next cursor that switches to a different suite within the same project", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchCases(128, 12, `${BASE_URL}/index.php?/api/v2/get_cases/128&suite_id=999&offset=1&limit=1`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a same-origin _links.next cursor that switches to a different project for cases", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchCases(128, 12, `${BASE_URL}/index.php?/api/v2/get_cases/999&suite_id=12&offset=1&limit=1`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a same-origin _links.next cursor that switches to a different project for runs", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchRuns(128, `${BASE_URL}/index.php?/api/v2/get_runs/999&offset=1&limit=1`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a same-origin _links.next cursor that switches to a different run for results", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchResults(77, `${BASE_URL}/index.php?/api/v2/get_results_for_run/999&offset=1&limit=1`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a same-origin cursor that switches to an unrelated TestRail operation entirely", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchCases(128, 12, `${BASE_URL}/index.php?/api/v2/get_runs/128&suite_id=12&offset=1&limit=1`),
    /does not match the expected TestRail API operation/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a _links.next cursor that downgrades to plain HTTP against the same host", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchCases(128, 12, "http://testrail.example.test/index.php?/api/v2/get_cases/128"),
    /HTTPS and same-origin/,
  );
  assert.equal(calls.length, 0);
});

test("keeps the abort timeout armed through body consumption and clears it exactly once", async () => {
  let sawAbortWhileReadingBody = false;
  const fetchImpl = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise((resolve, reject) => {
      const bodyTimer = setTimeout(() => resolve("[]"), 1_000);
      signal.addEventListener("abort", () => {
        sawAbortWhileReadingBody = true;
        clearTimeout(bodyTimer);
        reject(new Error("aborted while reading body"));
      });
    }),
  });
  const client = createTestRailHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 10 });
  await assert.rejects(client.fetchSuites(128), (error) => {
    assert.ok(error instanceof TestRailHttpError);
    assert.equal(error.message, "Request timed out");
    return true;
  });
  assert.equal(sawAbortWhileReadingBody, true);
});
