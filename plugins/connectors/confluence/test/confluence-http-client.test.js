import assert from "node:assert/strict";
import test from "node:test";
import { createConfluenceHttpClient, ConfluenceHttpError } from "../src/confluence-http-client.js";

const BASE_URL = "https://confluence.example.test/wiki";

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
  username: "qa@example.com",
  credentialRef: "secret://confluence/fl-titling",
  resolveCredential: async (ref) => `token-for-${ref}`,
  allowedSpaceKeys: ["QA"],
  ...overrides,
});

test("exposes space, exact-page, page-tree, and contextual search operations", () => {
  const client = createConfluenceHttpClient(baseOptions());
  assert.equal(typeof client.fetchSpacePages, "function");
  assert.equal(typeof client.fetchPage, "function");
  assert.equal(typeof client.fetchPageTree, "function");
  assert.equal(typeof client.fetchPagesByText, "function");
});

test("searches text only within allowlisted spaces using bounded CQL requests", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ body: JSON.stringify({ results: [] }) }),
    fakeResponse({ body: JSON.stringify({ results: [] }) }),
  ]);
  const client = createConfluenceHttpClient({
    ...baseOptions(),
    allowedSpaceKeys: ["QA", "ENG"],
    fetch: fetchImpl,
  });

  await client.fetchPagesByText('driver "login"');

  assert.equal(calls.length, 2);
  const cql = new URL(calls[0].url).searchParams.get("cql");
  assert.match(cql, /^space = "QA" AND type = page/);
  assert.match(cql, /title ~ "driver \\"login\\""/);
  assert.equal(new URL(calls[1].url).searchParams.get("cql").includes('space = "ENG"'), true);
});

test("rejects construction without a required dependency or allowlist", () => {
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), fetch: null }), /fetch implementation is required/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), resolveCredential: undefined }), /credential resolver function is required/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), credentialRef: "" }), /credentialRef is required/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), username: "" }), /username is required/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), authMode: "unknown" }), /authMode must be/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), baseUrl: "not-a-url" }), /baseUrl must be a valid HTTP\(S\) URL/);
  assert.throws(() => createConfluenceHttpClient({ ...baseOptions(), allowedSpaceKeys: [] }), /non-empty space key allowlist is required/);
});

test("sends a bearer personal access token for self-hosted Confluence", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [] }) }),
  ]);
  const client = createConfluenceHttpClient({
    ...baseOptions(),
    authMode: "bearer",
    fetch: fetchImpl,
    resolveCredential: async () => "personal-access-token",
  });

  await client.fetchSpacePages("QA");

  assert.equal(calls[0].init.headers.Authorization, "Bearer personal-access-token");
});

test("rejects fetchSpacePages for a space outside the allowlist without a network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("OUT"), /not in the configured allowlist/);
  assert.equal(calls.length, 0);
});

test("resolves the credential per request and sends Basic base64(username:token) without leaking the token", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ results: [] }) })]);
  const resolvedRefs = [];
  const client = createConfluenceHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolvedRefs.push(ref);
      return "super-secret-token";
    },
  });

  await client.fetchSpacePages("QA");
  assert.deepEqual(resolvedRefs, ["secret://confluence/fl-titling"]);
  const expectedToken = Buffer.from("qa@example.com:super-secret-token", "utf8").toString("base64");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${expectedToken}`);
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].url.includes("super-secret-token"), false);
});

test("requests the path-prefix-preserving rest/api/content endpoint with the expected filters and expand", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ results: [] }) })]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await client.fetchSpacePages("QA");

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/wiki/rest/api/content");
  assert.equal(url.searchParams.get("type"), "page");
  assert.equal(url.searchParams.get("status"), "current");
  assert.equal(url.searchParams.get("spaceKey"), "QA");
  assert.equal(url.searchParams.get("expand"), "space,version,body.storage,metadata.labels");
  assert.equal(url.searchParams.get("start"), "0");
});

test("fetches an exact allowlisted page by canonical ID", async () => {
  const page = { id: "42", title: "Product", space: { key: "QA" } };
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify(page) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });

  assert.deepEqual(await client.fetchPage("QA", "42"), page);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/wiki/rest/api/content/42");
  assert.equal(url.searchParams.get("status"), "current");
});

test("fetches a root page and descendants through a scoped CQL query", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({
        results: [{ id: "42", space: { key: "QA" } }],
        _links: { next: "/wiki/rest/api/content/search?start=1&limit=25" },
      }),
    }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const result = await client.fetchPageTree("QA", "42");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/wiki/rest/api/content/search");
  assert.equal(
    url.searchParams.get("cql"),
    'space = "QA" AND type = page AND ancestor = 42',
  );
  assert.deepEqual(result.nextPage, { start: 1 });
});

test("rejects page-tree access outside the space allowlist before a network call", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [] }) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.fetchPageTree("OTHER", "42"), /not in the configured allowlist/);
  await assert.rejects(client.fetchPage("QA", "not-an-id"), /positive integer/);
  assert.equal(calls.length, 0);
});

test("paginates using _links.next, advancing by the actual returned count", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ results: [{ id: "1" }], _links: { next: "/wiki/rest/api/content?spaceKey=QA&start=1&limit=1" } }),
    }),
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "2" }] }) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchSpacePages("QA", 0);
  assert.deepEqual(first, { items: [{ id: "1" }], nextPage: { start: 1 } });
  const second = await client.fetchSpacePages("QA", first.nextPage);
  assert.deepEqual(second, { items: [{ id: "2" }], nextPage: undefined });
  assert.equal(new URL(calls[1].url).searchParams.get("start"), "1");
});

test("emits every page when the server caps results far below the requested pageSize", async () => {
  const total = 5;
  const cap = 2;
  const ids = Array.from({ length: total }, (_, index) => String(index + 1));
  const responses = [];
  for (let start = 0; start < total; start += cap) {
    const offset = start;
    const hasMore = offset + cap < total;
    responses.push(() => fakeResponse({
      status: 200,
      body: JSON.stringify({
        results: ids.slice(offset, offset + cap).map((id) => ({ id })),
        _links: hasMore ? { next: `/wiki/rest/api/content?spaceKey=QA&start=${offset + cap}&limit=${cap}` } : {},
      }),
    }));
  }
  const { calls, fetchImpl } = queueFetch(responses);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 100 });

  const collected = [];
  let cursor = 0;
  do {
    const page = await client.fetchSpacePages("QA", cursor);
    collected.push(...page.items.map((item) => item.id));
    cursor = page.nextPage;
  } while (cursor);

  assert.deepEqual(collected, ids);
  assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get("start")), ["0", "2", "4"]);
});

test("stops paging instead of looping when a page is empty or carries no _links.next", async () => {
  const empty = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ results: [], _links: { next: "/wiki/rest/api/content?start=1" } }) })]);
  const emptyClient = createConfluenceHttpClient({ ...baseOptions(), fetch: empty.fetchImpl });
  assert.equal((await emptyClient.fetchSpacePages("QA")).nextPage, undefined);

  const noNext = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "1" }] }) })]);
  const noNextClient = createConfluenceHttpClient({ ...baseOptions(), fetch: noNext.fetchImpl });
  assert.equal((await noNextClient.fetchSpacePages("QA")).nextPage, undefined);
});

test("fails closed when a successful response omits the results array", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ size: 0, _links: {} }) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("QA"), /results must be an array/);
});

test("rejects a _links.next that does not resolve to the rest/api/content operation", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "1" }], _links: { next: "/wiki/rest/api/space/QA" } }) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("QA"), /does not match the expected content operation/);
});

test("rejects a _links.next that is cross-origin or downgrades to plain HTTP", async () => {
  const crossOrigin = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "1" }], _links: { next: "https://evil.example/wiki/rest/api/content" } }) }),
  ]);
  const crossOriginClient = createConfluenceHttpClient({ ...baseOptions(), fetch: crossOrigin.fetchImpl });
  await assert.rejects(crossOriginClient.fetchSpacePages("QA"), /HTTPS and same-origin/);

  const downgraded = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "1" }], _links: { next: "http://confluence.example.test/wiki/rest/api/content" } }) }),
  ]);
  const downgradedClient = createConfluenceHttpClient({ ...baseOptions(), fetch: downgraded.fetchImpl });
  await assert.rejects(downgradedClient.fetchSpacePages("QA"), /HTTPS and same-origin/);
});

test("fails closed when a returned page belongs to a different space than requested", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ results: [{ id: "1", space: { key: "OTHER" } }] }) }),
  ]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("QA"), /outside the requested scope/);
});

test("rejects a malformed pagination cursor before any network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("QA", -1), /non-negative integer start/);
  await assert.rejects(client.fetchSpacePages("QA", { start: -3 }), /non-negative integer start/);
  assert.equal(calls.length, 0);
});

test("maps 401/403/429/5xx to a status-aware, credential-free error", async () => {
  const statuses = [401, 403, 429, 500, 503];
  for (const status of statuses) {
    const { fetchImpl } = queueFetch([
      fakeResponse({ status, body: "sensitive body", headers: { "retry-after": "5" } }),
    ]);
    const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await assert.rejects(client.fetchSpacePages("QA"), (error) => {
      assert.ok(error instanceof ConfluenceHttpError);
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes("sensitive body"), false);
      assert.equal(error.message.includes("sensitive body"), false);
      if (status === 429) assert.equal(error.retryAfter, 5);
      return true;
    });
  }
});

test("treats an aborted request as a timeout without leaking headers", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by controller")));
  });
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.fetchSpacePages("QA"), (error) => {
    assert.ok(error instanceof ConfluenceHttpError);
    assert.equal(error.message, "Request timed out");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("throws a safe error for a malformed JSON response", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "not-json{" })]);
  const client = createConfluenceHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchSpacePages("QA"), (error) => {
    assert.ok(error instanceof ConfluenceHttpError);
    assert.equal(error.message, "Response body was not valid JSON");
    return true;
  });
});

test("rejects a plain-HTTP, non-loopback baseUrl by default and requires an explicit opt-in for loopback HTTP", () => {
  assert.throws(
    () => createConfluenceHttpClient({ ...baseOptions(), baseUrl: "http://confluence.internal/wiki" }),
    /baseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createConfluenceHttpClient({
    ...baseOptions(),
    baseUrl: "http://localhost:9000/wiki",
    allowInsecureLoopback: true,
  }));
});
