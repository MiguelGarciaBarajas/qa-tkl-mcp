import assert from "node:assert/strict";
import test from "node:test";
import { createJiraHttpClient, JiraHttpError } from "../src/jira-http-client.js";

const BASE_URL = "https://jira.example.test/jira";

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
  credentialRef: "secret://jira/fl-titling",
  resolveCredential: async (ref) => `token-for-${ref}`,
  allowedProjects: ["STT"],
  allowedJql: ["project = STT AND status = Open"],
  ...overrides,
});

test("rejects construction without a required dependency or allowlist", () => {
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), fetch: null }), /fetch implementation is required/);
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), resolveCredential: undefined }), /credential resolver function is required/);
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), credentialRef: "" }), /credentialRef is required/);
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), baseUrl: "not-a-url" }), /baseUrl must be a valid HTTP\(S\) URL/);
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), allowedProjects: [] }), /non-empty project allowlist is required/);
  assert.throws(() => createJiraHttpClient({ ...baseOptions(), allowedJql: [] }), /non-empty JQL allowlist is required/);
});

test("resolves the credential per request and sends a bearer token without leaking it", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ key: "STT-1" }) })]);
  const resolvedRefs = [];
  const client = createJiraHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolvedRefs.push(ref);
      return "super-secret-token";
    },
  });

  const issue = await client.fetchIssue("STT-1");
  assert.deepEqual(issue, { key: "STT-1" });
  assert.deepEqual(resolvedRefs, ["secret://jira/fl-titling"]);
  assert.equal(calls[0].init.headers.Authorization, "Bearer super-secret-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  // The resolved token must never be embedded in the request URL.
  assert.equal(calls[0].url.includes("super-secret-token"), false);
});

test("rejects fetchIssue and fetchComments for a project outside the allowlist without a network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.fetchIssue("OUT-1"), /not in the configured allowlist/);
  await assert.rejects(client.fetchComments("OUT-1"), /not in the configured allowlist/);
  assert.equal(calls.length, 0);
});

test("rejects searchIssues for JQL outside the allowlist without a network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.searchIssues("project = OUT"), /not in the configured allowlist/);
  assert.equal(calls.length, 0);
});

test("retrieves an exact issue only within an allowlisted JQL scope", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ issues: [{ key: "STT-1234" }], total: 1 }),
    }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const issue = await client.fetchIssueWithinJql(
    "STT-1234",
    "project = STT AND status = Open",
  );

  assert.equal(issue.key, "STT-1234");
  const url = new URL(calls[0].url);
  assert.equal(
    url.searchParams.get("jql"),
    '(project = STT AND status = Open) AND key = "STT-1234"',
  );
  assert.equal(url.searchParams.get("maxResults"), "1");
});

test("paginates issue search using startAt/maxResults until total is reached", async () => {
  const jql = "project = STT AND status = Open";
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-1" }], total: 2 }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-2" }], total: 2 }) }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.searchIssues(jql, 0);
  assert.deepEqual(first, { items: [{ key: "STT-1" }], nextPage: { startAt: 1 } });
  const second = await client.searchIssues(jql, first.nextPage);
  assert.deepEqual(second, { items: [{ key: "STT-2" }], nextPage: undefined });

  assert.equal(new URL(calls[0].url).searchParams.get("startAt"), "0");
  assert.equal(new URL(calls[1].url).searchParams.get("startAt"), "1");
  assert.equal(new URL(calls[0].url).searchParams.get("maxResults"), "1");
  assert.equal(new URL(calls[0].url).searchParams.get("expand"), "names");
});

test("resolves the Jira Epic Link field name into a stable epicKey", async () => {
  const jql = "project = STT AND status = Open";
  const { fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({
        names: { customfield_12345: "Epic Link" },
        issues: [{
          key: "STT-5291",
          fields: {
            summary: "Billing total is empty",
            customfield_12345: "STT-3731",
          },
        }],
        total: 1,
      }),
    }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });

  const result = await client.searchIssues(jql, 0);

  assert.equal(result.items[0].epicKey, "STT-3731");
});

test("paginates comments using startAt/maxResults until total is reached", async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ comments: [{ id: "c1" }], total: 2 }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ comments: [{ id: "c2" }], total: 2 }) }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchComments("STT-1", 0);
  assert.deepEqual(first, { items: [{ id: "c1" }], nextPage: { startAt: 1 } });
  const second = await client.fetchComments("STT-1", first.nextPage);
  assert.deepEqual(second, { items: [{ id: "c2" }], nextPage: undefined });
});

/**
 * Server-side `maxResults` caps are the reason the cursor is an absolute
 * offset. Jira silently caps a requested page size (for example a requested
 * 100 served as 2), so a cursor derived as `page * pageSize` would jump
 * 0 -> 100 -> 200 and permanently skip every record the server withheld.
 */
function cappedSearchResponses({ total, cap, pageSize }) {
  const keys = Array.from({ length: total }, (_, index) => `STT-${index + 1}`);
  const responses = [];
  for (let startAt = 0; startAt < total; startAt += cap) {
    responses.push((url) => {
      assert.equal(new URL(url).searchParams.get("startAt"), String(startAt));
      assert.equal(new URL(url).searchParams.get("maxResults"), String(pageSize));
      return fakeResponse({
        status: 200,
        body: JSON.stringify({
          startAt,
          maxResults: cap,
          total,
          issues: keys.slice(startAt, startAt + cap).map((key) => ({ key })),
        }),
      });
    });
  }
  return { keys, responses };
}

test("emits every issue when the server caps maxResults far below the requested pageSize", async () => {
  const jql = "project = STT AND status = Open";
  const { keys, responses } = cappedSearchResponses({ total: 7, cap: 2, pageSize: 100 });
  const { calls, fetchImpl } = queueFetch(responses);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 100 });

  const collected = [];
  let cursor = 0;
  do {
    const page = await client.searchIssues(jql, cursor);
    collected.push(...page.items.map((issue) => issue.key));
    cursor = page.nextPage;
  } while (cursor);

  assert.deepEqual(collected, keys);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get("startAt")),
    ["0", "2", "4", "6"],
  );
});

test("emits every comment when the server caps maxResults far below the requested pageSize", async () => {
  const total = 5;
  const cap = 2;
  const ids = Array.from({ length: total }, (_, index) => `c${index + 1}`);
  const responses = [];
  for (let startAt = 0; startAt < total; startAt += cap) {
    const offset = startAt;
    responses.push(() => fakeResponse({
      status: 200,
      body: JSON.stringify({
        startAt: offset,
        maxResults: cap,
        total,
        comments: ids.slice(offset, offset + cap).map((id) => ({ id })),
      }),
    }));
  }
  const { calls, fetchImpl } = queueFetch(responses);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 50 });

  const collected = [];
  let cursor = 0;
  do {
    const page = await client.fetchComments("STT-1", cursor);
    collected.push(...page.items.map((comment) => comment.id));
    cursor = page.nextPage;
  } while (cursor);

  assert.deepEqual(collected, ids);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get("startAt")),
    ["0", "2", "4"],
  );
});

test("resumes from a persisted { startAt } cursor without re-reading or skipping records", async () => {
  const jql = "project = STT AND status = Open";
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({ startAt: 4, maxResults: 2, total: 6, issues: [{ key: "STT-5" }, { key: "STT-6" }] }),
    }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 100 });

  const resumed = await client.searchIssues(jql, { startAt: 4 });
  assert.deepEqual(resumed.items.map((issue) => issue.key), ["STT-5", "STT-6"]);
  assert.equal(resumed.nextPage, undefined);
  assert.equal(new URL(calls[0].url).searchParams.get("startAt"), "4");
});

test("still accepts a legacy numeric page-index cursor from an older checkpoint", async () => {
  const jql = "project = STT AND status = Open";
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-9" }], total: 100 }) }),
    fakeResponse({ status: 200, body: JSON.stringify({ comments: [{ id: "c9" }], total: 100 }) }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 25 });

  await client.searchIssues(jql, 3);
  assert.equal(new URL(calls[0].url).searchParams.get("startAt"), "75");
  await client.fetchComments("STT-1", 2);
  assert.equal(new URL(calls[1].url).searchParams.get("startAt"), "50");
});

test("rejects a malformed pagination cursor before any network call", async () => {
  const jql = "project = STT AND status = Open";
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "{}" })]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.searchIssues(jql, -1), /non-negative integer page/);
  await assert.rejects(client.searchIssues(jql, 1.5), /non-negative integer page/);
  await assert.rejects(client.searchIssues(jql, { startAt: -3 }), /non-negative integer startAt/);
  await assert.rejects(client.fetchComments("STT-1", { startAt: "nope" }), /non-negative integer startAt/);
  assert.equal(calls.length, 0);
});

test("stops paging instead of looping when a response cannot prove more records exist or fails to advance", async () => {
  const jql = "project = STT AND status = Open";
  // No total and no isLast: fail closed rather than page unbounded.
  const noTotal = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-1" }] }) })]);
  const noTotalClient = createJiraHttpClient({ ...baseOptions(), fetch: noTotal.fetchImpl, pageSize: 1 });
  assert.equal((await noTotalClient.searchIssues(jql, 0)).nextPage, undefined);

  // An empty page never produces a next cursor, even when total says more.
  const empty = queueFetch([fakeResponse({ status: 200, body: JSON.stringify({ issues: [], total: 50 }) })]);
  const emptyClient = createJiraHttpClient({ ...baseOptions(), fetch: empty.fetchImpl, pageSize: 10 });
  assert.equal((await emptyClient.searchIssues(jql, 0)).nextPage, undefined);

  // A response echoing a startAt behind the request must not produce a
  // cursor that stalls or moves backward.
  const stalled = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ startAt: 0, total: 50, issues: [{ key: "STT-1" }] }) }),
  ]);
  const stalledClient = createJiraHttpClient({ ...baseOptions(), fetch: stalled.fetchImpl, pageSize: 10 });
  assert.equal((await stalledClient.searchIssues(jql, { startAt: 10 })).nextPage, undefined);

  // `isLast: true` ends paging even when total suggests otherwise.
  const last = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ isLast: true, total: 50, issues: [{ key: "STT-1" }] }) }),
  ]);
  const lastClient = createJiraHttpClient({ ...baseOptions(), fetch: last.fetchImpl, pageSize: 10 });
  assert.equal((await lastClient.searchIssues(jql, 0)).nextPage, undefined);
});

test("maps 401/403/429/5xx to a status-aware, credential-free error", async () => {
  const statuses = [401, 403, 429, 500, 503];
  for (const status of statuses) {
    const { fetchImpl } = queueFetch([
      fakeResponse({ status, body: "sensitive body", headers: { "retry-after": "7" } }),
    ]);
    const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await assert.rejects(client.fetchIssue("STT-1"), (error) => {
      assert.ok(error instanceof JiraHttpError);
      assert.equal(error.status, status);
      assert.equal(error.url, `${BASE_URL}/rest/api/2/issue/STT-1`);
      assert.equal(JSON.stringify(error).includes("sensitive body"), false);
      assert.equal(error.message.includes("sensitive body"), false);
      if (status === 429) assert.equal(error.retryAfter, 7);
      return true;
    });
  }
});

test("treats an aborted request as a timeout without leaking headers", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by controller")));
  });
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.fetchIssue("STT-1"), (error) => {
    assert.ok(error instanceof JiraHttpError);
    assert.equal(error.message, "Request timed out");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("throws a safe error for a malformed JSON response", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "not-json{" })]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchIssue("STT-1"), (error) => {
    assert.ok(error instanceof JiraHttpError);
    assert.equal(error.message, "Response body was not valid JSON");
    assert.equal(error.status, 200);
    return true;
  });
});

test("rejects a plain-HTTP, non-loopback baseUrl by default and requires an explicit opt-in for loopback HTTP", () => {
  assert.throws(
    () => createJiraHttpClient({ ...baseOptions(), baseUrl: "http://jira.internal/jira" }),
    /baseUrl must use HTTPS/,
  );
  assert.throws(
    () => createJiraHttpClient({ ...baseOptions(), baseUrl: "http://localhost:9000/jira" }),
    /baseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createJiraHttpClient({
    ...baseOptions(),
    baseUrl: "http://localhost:9000/jira",
    allowInsecureLoopback: true,
  }));
  assert.doesNotThrow(() => createJiraHttpClient({
    ...baseOptions(),
    baseUrl: "http://127.0.0.1:9000/jira",
    allowInsecureLoopback: true,
  }));
});

test("fails closed when a search result issue is outside the allowed projects", async () => {
  const jql = "project = STT AND status = Open";
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-1" }, { key: "OUT-9" }], total: 2 }) }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.searchIssues(jql, 0), /not in the configured allowlist/);
  assert.equal(calls.length, 1);
});

test("fails closed when a search result issue is missing a valid key", async () => {
  const jql = "project = STT AND status = Open";
  const { fetchImpl } = queueFetch([
    fakeResponse({ status: 200, body: JSON.stringify({ issues: [{ key: "STT-1" }, { id: 999 }], total: 2 }) }),
  ]);
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.searchIssues(jql, 0), /not in the configured allowlist/);
});

test("keeps the abort timeout armed through body consumption and clears it exactly once", async () => {
  let sawAbortWhileReadingBody = false;
  const fetchImpl = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise((resolve, reject) => {
      const bodyTimer = setTimeout(() => resolve("{}"), 1_000);
      signal.addEventListener("abort", () => {
        sawAbortWhileReadingBody = true;
        clearTimeout(bodyTimer);
        reject(new Error("aborted while reading body"));
      });
    }),
  });
  const client = createJiraHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 10 });
  await assert.rejects(client.fetchIssue("STT-1"), (error) => {
    assert.ok(error instanceof JiraHttpError);
    assert.equal(error.message, "Request timed out");
    return true;
  });
  assert.equal(sawAbortWhileReadingBody, true);
});
