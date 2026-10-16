import assert from "node:assert/strict";
import test from "node:test";
import { createReportPortalHttpClient, ReportPortalHttpError } from "../src/reportportal-http-client.js";

const BASE_URL = "https://reportportal.example.test";

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
  project: "fl_titling",
  credentialRef: "secret://reportportal/fl-titling",
  resolveCredential: async (ref) => `token-for-${ref}`,
  ...overrides,
});

test("exposes fetchLaunches and fetchTestItems on every constructed client", () => {
  const client = createReportPortalHttpClient(baseOptions());
  assert.equal(typeof client.fetchLaunches, "function");
  assert.equal(typeof client.fetchTestItems, "function");
});

test("rejects construction without a required dependency or a valid project", () => {
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), fetch: null }), /fetch implementation is required/);
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), resolveCredential: undefined }), /credential resolver function is required/);
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), credentialRef: "" }), /credentialRef is required/);
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), baseUrl: "not-a-url" }), /baseUrl must be a valid HTTP\(S\) URL/);
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), project: "" }), /project must be a non-empty alphanumeric identifier/);
  assert.throws(() => createReportPortalHttpClient({ ...baseOptions(), project: "not a valid project!" }), /project must be a non-empty alphanumeric identifier/);
});

test("rejects a non-numeric launchId before any network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchTestItems("not-a-number"), /launchId must be a positive integer/);
  await assert.rejects(client.fetchTestItems("-1"), /launchId must be a positive integer/);
  assert.equal(calls.length, 0);
});

test("resolves the credential per request and sends a bearer token without leaking it", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [] }) })]);
  const resolvedRefs = [];
  const client = createReportPortalHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolvedRefs.push(ref);
      return "super-secret-token";
    },
  });

  await client.fetchLaunches();
  assert.deepEqual(resolvedRefs, ["secret://reportportal/fl-titling"]);
  assert.equal(calls[0].init.headers.Authorization, "Bearer super-secret-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].url.includes("super-secret-token"), false);
});

test("requests launches with zero-based page metadata and a deterministic sort", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [] }) })]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 10 });
  await client.fetchLaunches();
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/fl_titling/launch");
  assert.equal(url.searchParams.get("page.page"), "0");
  assert.equal(url.searchParams.get("page.size"), "10");
  assert.equal(url.searchParams.get("page.sort"), "startTime,ASC");
});

test("requests test items scoped to the launch path with a deterministic sort", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [] }) })]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await client.fetchTestItems(42);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/fl_titling/launch/42/testItem");
  assert.equal(url.searchParams.get("page.sort"), "startTime,ASC");
});

test("retrieves bounded test history by exact uniqueId and codeRef", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      body: JSON.stringify({
        content: [{ id: 10, launchId: 42, uniqueId: "tests/login.spec.ts:test" }],
      }),
    }),
    fakeResponse({
      body: JSON.stringify({
        content: [
          { id: 10, launchId: 42, uniqueId: "tests/login.spec.ts:test" },
          { id: 11, launchId: 42, codeRef: "tests/login.spec.ts:test" },
        ],
      }),
    }),
  ]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const items = await client.fetchTestItemsByIdentity(
    "http://reportportal.internal/ui/#fl_titling/launches/all/42"
      + "?item0Params=filter.eq.uniqueId%3Dtests%252Flogin.spec.ts%253Atest",
  );

  assert.deepEqual(items.map(({ id }) => id), [10, 11]);
  assert.equal(
    new URL(calls[0].url).searchParams.get("filter.eq.uniqueId"),
    "tests/login.spec.ts:test",
  );
  assert.equal(
    new URL(calls[1].url).searchParams.get("filter.eq.codeRef"),
    "tests/login.spec.ts:test",
  );
  assert.equal(new URL(calls[0].url).searchParams.get("filter.eq.launchId"), "42");
  assert.equal(new URL(calls[0].url).searchParams.get("page.sort"), "startTime,DESC");
});

test("paginates launches using content + zero-based page metadata", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 1 }], page: { number: 0, size: 1, totalElements: 2, totalPages: 2 } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 2 }], page: { number: 1, size: 1, totalElements: 2, totalPages: 2 } }) }),
  ]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchLaunches(0);
  assert.deepEqual(first, { items: [{ id: 1 }], nextPage: 1 });
  const second = await client.fetchLaunches(first.nextPage);
  assert.deepEqual(second, { items: [{ id: 2 }], nextPage: undefined });
  assert.equal(new URL(calls[1].url).searchParams.get("page.page"), "1");
});

test("paginates test items using content + zero-based page metadata", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 10, launchId: 42 }], page: { number: 0, totalPages: 2 } }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 11, launchId: 42 }], page: { number: 1, totalPages: 2 } }) }),
  ]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const first = await client.fetchTestItems(42, 0);
  assert.deepEqual(first.items, [{ id: 10, launchId: 42 }]);
  const second = await client.fetchTestItems(42, first.nextPage);
  assert.deepEqual(second, { items: [{ id: 11, launchId: 42 }], nextPage: undefined });
});

test("stops paging instead of looping when a page is empty or its metadata cannot prove more pages exist", async () => {
  const empty = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [], page: { number: 0, totalPages: 5 } }) })]);
  const emptyClient = createReportPortalHttpClient({ ...baseOptions(), fetch: empty.fetchImpl });
  assert.equal((await emptyClient.fetchLaunches()).nextPage, undefined);

  const noPageMeta = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 1 }] }) })]);
  const noPageMetaClient = createReportPortalHttpClient({ ...baseOptions(), fetch: noPageMeta.fetchImpl });
  assert.equal((await noPageMetaClient.fetchLaunches()).nextPage, undefined);

  const lastPage = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 1 }], page: { number: 1, totalPages: 2 } }) })]);
  const lastPageClient = createReportPortalHttpClient({ ...baseOptions(), fetch: lastPage.fetchImpl });
  assert.equal((await lastPageClient.fetchLaunches()).nextPage, undefined);
});

test("fails closed when successful launch or test-item responses omit content", async () => {
  const launchResponse = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ page: { number: 0, totalPages: 0 } }) }),
  ]);
  const launchClient = createReportPortalHttpClient({ ...baseOptions(), fetch: launchResponse.fetchImpl });
  await assert.rejects(launchClient.fetchLaunches(), /launch page envelope/);

  const itemResponse = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ page: { number: 0, totalPages: 0 } }) }),
  ]);
  const itemClient = createReportPortalHttpClient({ ...baseOptions(), fetch: itemResponse.fetchImpl });
  await assert.rejects(itemClient.fetchTestItems(42), /test item page envelope/);
});

test("fails closed when a returned test item belongs to a different launch than requested", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ content: [{ id: 10, launchId: 999 }] }) }),
  ]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchTestItems(42), /outside the requested scope/);
});

test("rejects a malformed pagination cursor before any network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchLaunches(-1), /non-negative integer page/);
  await assert.rejects(client.fetchLaunches(1.5), /non-negative integer page/);
  assert.equal(calls.length, 0);
});

test("maps 401/403/429/5xx to a status-aware, credential-free error", async () => {
  const statuses = [401, 403, 429, 500, 503];
  for (const status of statuses) {
    const { fetchImpl } = queueFetch([
      fakeResponse({ status, body: "sensitive body", headers: { "retry-after": "9" } }),
    ]);
    const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await assert.rejects(client.fetchLaunches(), (error) => {
      assert.ok(error instanceof ReportPortalHttpError);
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes("sensitive body"), false);
      assert.equal(error.message.includes("sensitive body"), false);
      if (status === 429) assert.equal(error.retryAfter, 9);
      return true;
    });
  }
});

test("treats an aborted request as a timeout without leaking headers", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by controller")));
  });
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.fetchLaunches(), (error) => {
    assert.ok(error instanceof ReportPortalHttpError);
    assert.equal(error.message, "Request timed out");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("throws a safe error for a malformed JSON response", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "not-json{" })]);
  const client = createReportPortalHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchLaunches(), (error) => {
    assert.ok(error instanceof ReportPortalHttpError);
    assert.equal(error.message, "Response body was not valid JSON");
    return true;
  });
});

test("rejects a plain-HTTP, non-loopback baseUrl by default and requires an explicit opt-in for loopback HTTP", () => {
  assert.throws(
    () => createReportPortalHttpClient({ ...baseOptions(), baseUrl: "http://reportportal.internal" }),
    /baseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createReportPortalHttpClient({
    ...baseOptions(),
    baseUrl: "http://localhost:9000",
    allowInsecureLoopback: true,
  }));
});

test("allows plain HTTP only when the exact internal host was approved upstream", async () => {
  const calls = [];
  const client = createReportPortalHttpClient({
    ...baseOptions(),
    baseUrl: "http://reportportal.internal:8080",
    allowInsecureHost: true,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse({
        body: JSON.stringify({ content: [], page: { number: 0, totalPages: 0 } }),
      });
    },
  });

  await client.fetchLaunches();
  assert.equal(
    calls[0].url.startsWith("http://reportportal.internal:8080/api/v1/"),
    true,
  );
});
