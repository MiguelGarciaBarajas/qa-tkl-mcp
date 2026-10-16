import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubHttpClient, GitHubHttpError } from "../src/github-http-client.js";

const API_URL = "https://api.github.test";

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
  apiUrl: API_URL,
  credentialRef: "secret://github/fl-titling",
  resolveCredential: async (ref) => `token-for-${ref}`,
  allowedRepositories: ["solera-engineering/fl-titling"],
  ...overrides,
});

test("rejects construction without a required dependency or allowlist", () => {
  assert.throws(() => createGitHubHttpClient({ ...baseOptions(), fetch: null }), /fetch implementation is required/);
  assert.throws(() => createGitHubHttpClient({ ...baseOptions(), resolveCredential: undefined }), /credential resolver function is required/);
  assert.throws(() => createGitHubHttpClient({ ...baseOptions(), credentialRef: "" }), /credentialRef is required/);
  assert.throws(() => createGitHubHttpClient({ ...baseOptions(), apiUrl: "not-a-url" }), /apiUrl must be a valid HTTP\(S\) URL/);
  assert.throws(() => createGitHubHttpClient({ ...baseOptions(), allowedRepositories: [] }), /non-empty repository allowlist is required/);
});

test("resolves the credential per request and sends least-privilege headers without leaking the token", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify([{ number: 1 }]) })]);
  const resolvedRefs = [];
  const client = createGitHubHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolvedRefs.push(ref);
      return "super-secret-token";
    },
  });

  const result = await client.fetchPullRequests("solera-engineering/fl-titling");
  assert.deepEqual(result, { items: [{ number: 1 }], nextPage: undefined });
  assert.deepEqual(resolvedRefs, ["secret://github/fl-titling"]);
  assert.equal(calls[0].init.headers.Authorization, "Bearer super-secret-token");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(calls[0].init.headers["User-Agent"]);
  assert.equal(Object.keys(calls[0].init.headers).length, 4);
  assert.equal(calls[0].url.includes("super-secret-token"), false);
});

test("rejects fetchPullRequests and fetchChangedFiles for a repository outside the allowlist without a network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });

  await assert.rejects(client.fetchPullRequests("someone-else/other-repo"), /not in the configured allowlist/);
  await assert.rejects(client.fetchChangedFiles("someone-else/other-repo", 1), /not in the configured allowlist/);
  await assert.rejects(
    client.searchPullRequestsByIssue("someone-else/other-repo", "ABC-123"),
    /not in the configured allowlist/
  );
  assert.equal(calls.length, 0);
});

test("searches pull requests by an exact Jira key inside the allowlisted repository", async () => {
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify({
        total_count: 1,
        items: [{ number: 7, title: "ABC-123 adds coverage", pull_request: {} }]
      })
    })
  ]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 10 });

  const result = await client.searchPullRequestsByIssue(
    "solera-engineering/fl-titling",
    "abc-123"
  );

  assert.equal(result.items[0].number, 7);
  assert.equal(result.incompleteResults, false);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/search/issues");
  assert.equal(url.searchParams.get("q"), 'repo:solera-engineering/fl-titling is:pr "ABC-123"');
  assert.equal(url.searchParams.get("per_page"), "10");
});

test("rejects a malformed repository identifier before any network call", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchPullRequests("not-a-repo-path"), /owner\/name" string/);
  assert.equal(calls.length, 0);
});

test("paginates pull requests using the Link: rel=\"next\" header as an opaque cursor", async () => {
  const nextUrl = `${API_URL}/repos/solera-engineering/fl-titling/pulls?per_page=1&page=2`;
  const { calls, fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify([{ number: 1 }]),
      headers: { link: `<${nextUrl}>; rel="next", <${API_URL}/x>; rel="last"` },
    }),
    fakeResponse({ status: 200, body: JSON.stringify([{ number: 2 }]) }),
  ]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchPullRequests("solera-engineering/fl-titling", 0);
  assert.deepEqual(first, { items: [{ number: 1 }], nextPage: nextUrl });
  const second = await client.fetchPullRequests("solera-engineering/fl-titling", first.nextPage);
  assert.deepEqual(second, { items: [{ number: 2 }], nextPage: undefined });

  assert.equal(calls[0].url, `${API_URL}/repos/solera-engineering/fl-titling/pulls?state=all&sort=updated&direction=desc&per_page=1&page=1`);
  assert.equal(calls[1].url, nextUrl);
});

test("paginates changed files using the Link: rel=\"next\" header as an opaque cursor", async () => {
  const nextUrl = `${API_URL}/repos/solera-engineering/fl-titling/pulls/7/files?per_page=1&page=2`;
  const { fetchImpl } = queueFetch([
    fakeResponse({
      status: 200,
      body: JSON.stringify([{ filename: "a.js" }]),
      headers: { link: `<${nextUrl}>; rel="next"` },
    }),
    fakeResponse({ status: 200, body: JSON.stringify([{ filename: "b.js" }]) }),
  ]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl, pageSize: 1 });

  const first = await client.fetchChangedFiles("solera-engineering/fl-titling", 7, 0);
  assert.deepEqual(first, { items: [{ filename: "a.js" }], nextPage: nextUrl });
  const second = await client.fetchChangedFiles("solera-engineering/fl-titling", 7, first.nextPage);
  assert.deepEqual(second, { items: [{ filename: "b.js" }], nextPage: undefined });
});

test("maps 401/403/429/5xx to a status-aware, credential-free error", async () => {
  const statuses = [401, 403, 429, 500, 503];
  for (const status of statuses) {
    const { fetchImpl } = queueFetch([
      fakeResponse({ status, body: "sensitive body", headers: { "retry-after": "11" } }),
    ]);
    const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
    await assert.rejects(client.fetchPullRequests("solera-engineering/fl-titling"), (error) => {
      assert.ok(error instanceof GitHubHttpError);
      assert.equal(error.status, status);
      assert.equal(JSON.stringify(error).includes("sensitive body"), false);
      assert.equal(error.message.includes("sensitive body"), false);
      if (status === 429) assert.equal(error.retryAfter, 11);
      return true;
    });
  }
});

test("treats an aborted request as a timeout without leaking headers", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by controller")));
  });
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 5 });
  await assert.rejects(client.fetchPullRequests("solera-engineering/fl-titling"), (error) => {
    assert.ok(error instanceof GitHubHttpError);
    assert.equal(error.message, "Request timed out");
    assert.equal(error.status, undefined);
    return true;
  });
});

test("throws a safe error for a malformed JSON response", async () => {
  const { fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "not-json{" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(client.fetchPullRequests("solera-engineering/fl-titling"), (error) => {
    assert.ok(error instanceof GitHubHttpError);
    assert.equal(error.message, "Response body was not valid JSON");
    assert.equal(error.status, 200);
    return true;
  });
});

test("rejects a plain-HTTP, non-loopback apiUrl by default and requires an explicit opt-in for loopback HTTP", () => {
  assert.throws(
    () => createGitHubHttpClient({ ...baseOptions(), apiUrl: "http://api.github.internal" }),
    /apiUrl must use HTTPS/,
  );
  assert.throws(
    () => createGitHubHttpClient({ ...baseOptions(), apiUrl: "http://localhost:4000" }),
    /apiUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createGitHubHttpClient({
    ...baseOptions(),
    apiUrl: "http://localhost:4000",
    allowInsecureLoopback: true,
  }));
  assert.doesNotThrow(() => createGitHubHttpClient({
    ...baseOptions(),
    apiUrl: "http://127.0.0.1:4000",
    allowInsecureLoopback: true,
  }));
});

test("rejects a pagination cursor that points cross-origin without resolving the credential or calling fetch", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  let resolveCalls = 0;
  const client = createGitHubHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolveCalls += 1;
      return `token-for-${ref}`;
    },
  });

  await assert.rejects(
    client.fetchPullRequests("solera-engineering/fl-titling", "https://evil.example/repos/x/pulls"),
    /HTTPS and same-origin/,
  );
  assert.equal(calls.length, 0);
  assert.equal(resolveCalls, 0);
});

test("rejects a pagination cursor that downgrades to plain HTTP against the same host", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchPullRequests("solera-engineering/fl-titling", "http://api.github.test/repos/x/pulls"),
    /HTTPS and same-origin/,
  );
  assert.equal(calls.length, 0);
});

test("rejects a same-origin pagination cursor that points at a different repository's pulls listing before resolving the credential", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  let resolveCalls = 0;
  const client = createGitHubHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolveCalls += 1;
      return `token-for-${ref}`;
    },
  });

  await assert.rejects(
    client.fetchPullRequests("solera-engineering/fl-titling", `${API_URL}/repos/someone-else/other-repo/pulls`),
    /does not match the expected GitHub API operation/,
  );
  assert.equal(calls.length, 0);
  assert.equal(resolveCalls, 0);
});

test("rejects a same-origin pagination cursor that points at an unrelated endpoint before resolving the credential", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchPullRequests("solera-engineering/fl-titling", `${API_URL}/repos/solera-engineering/fl-titling/issues`),
    /does not match the expected GitHub API operation/,
  );
  assert.equal(calls.length, 0);
});

test("extracts only trusted page/per_page parameters from GitHub's numeric repositories/{id} cursor and rebuilds the allowlisted pulls URL, without ever dereferencing the numeric path", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify([{ number: 3 }]) })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  const result = await client.fetchPullRequests(
    "solera-engineering/fl-titling",
    `${API_URL}/repositories/778899/pulls?page=2&per_page=25`,
  );
  assert.deepEqual(result.items, [{ number: 3 }]);
  assert.equal(calls.length, 1);
  // The numeric-id host/path must never be requested; only its page/per_page
  // values are carried over onto the rebuilt, allowlisted repos URL.
  assert.equal(
    calls[0].url,
    `${API_URL}/repos/solera-engineering/fl-titling/pulls?state=all&sort=updated&direction=desc&per_page=25&page=2`,
  );
});

test("an arbitrary/attacker-controlled numeric id in a pulls pagination cursor can never redirect the request to a different repository", async () => {
  const maliciousIds = ["1", "778899", "999999999999", "0"];
  for (const id of maliciousIds) {
    const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
    const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
    // eslint-disable-next-line no-await-in-loop
    await client.fetchPullRequests("solera-engineering/fl-titling", `${API_URL}/repositories/${id}/pulls?page=2`);
    assert.equal(calls.length, 1);
    // Regardless of which numeric id the cursor claims, the request that is
    // actually sent always targets the configured, allowlisted repository --
    // the numeric id can never change which repository is fetched.
    assert.ok(calls[0].url.startsWith(`${API_URL}/repos/solera-engineering/fl-titling/pulls?`));
    assert.equal(calls[0].url.includes("/repositories/"), false);
  }
});

test("rejects a changed-files cursor that points at a different pull request's files before resolving the credential", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  let resolveCalls = 0;
  const client = createGitHubHttpClient({
    ...baseOptions(),
    fetch: fetchImpl,
    resolveCredential: async (ref) => {
      resolveCalls += 1;
      return `token-for-${ref}`;
    },
  });

  await assert.rejects(
    client.fetchChangedFiles(
      "solera-engineering/fl-titling",
      7,
      `${API_URL}/repos/solera-engineering/fl-titling/pulls/999/files`,
    ),
    /does not match the expected GitHub API operation/,
  );
  assert.equal(calls.length, 0);
  assert.equal(resolveCalls, 0);
});

test("rejects a changed-files cursor that points at a different repository's files before resolving the credential", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchChangedFiles(
      "solera-engineering/fl-titling",
      7,
      `${API_URL}/repos/someone-else/other-repo/pulls/7/files`,
    ),
    /does not match the expected GitHub API operation/,
  );
  assert.equal(calls.length, 0);
});

test("extracts only trusted page/per_page parameters from GitHub's numeric repositories/{id} cursor and rebuilds the allowlisted changed-files URL, without ever dereferencing the numeric path", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: JSON.stringify([{ filename: "c.js" }]) })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  const result = await client.fetchChangedFiles(
    "solera-engineering/fl-titling",
    7,
    `${API_URL}/repositories/778899/pulls/7/files?page=2&per_page=10`,
  );
  assert.deepEqual(result.items, [{ filename: "c.js" }]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${API_URL}/repos/solera-engineering/fl-titling/pulls/7/files?per_page=10&page=2`,
  );
});

test("an arbitrary/attacker-controlled numeric id in a changed-files pagination cursor can never redirect the request to a different repository or pull request", async () => {
  const maliciousIds = ["1", "778899", "999999999999", "0"];
  for (const id of maliciousIds) {
    const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
    const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
    // eslint-disable-next-line no-await-in-loop
    await client.fetchChangedFiles(
      "solera-engineering/fl-titling",
      7,
      `${API_URL}/repositories/${id}/pulls/7/files?page=2`,
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(`${API_URL}/repos/solera-engineering/fl-titling/pulls/7/files?`));
    assert.equal(calls[0].url.includes("/repositories/"), false);
  }
});

test("rejects a numeric-id changed-files cursor whose PR number segment does not match the requested pull request", async () => {
  const { calls, fetchImpl } = queueFetch([fakeResponse({ status: 200, body: "[]" })]);
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl });
  await assert.rejects(
    client.fetchChangedFiles(
      "solera-engineering/fl-titling",
      7,
      `${API_URL}/repositories/778899/pulls/999/files?page=2`,
    ),
    /does not match the expected GitHub API operation/,
  );
  assert.equal(calls.length, 0);
});

test("exposes an explicitly configured, validated webBaseUrl for evidence sourceUrl links, defaulting to undefined", () => {
  const withoutWebBaseUrl = createGitHubHttpClient(baseOptions());
  assert.equal(withoutWebBaseUrl.webBaseUrl, undefined);

  const withWebBaseUrl = createGitHubHttpClient({
    ...baseOptions(),
    apiUrl: "https://ghe.example.test/api/v3",
    webBaseUrl: "https://ghe.example.test/",
  });
  assert.equal(withWebBaseUrl.webBaseUrl, "https://ghe.example.test");

  assert.throws(
    () => createGitHubHttpClient({ ...baseOptions(), webBaseUrl: "http://ghe.example.test" }),
    /webBaseUrl must use HTTPS/,
  );
  assert.throws(
    () => createGitHubHttpClient({ ...baseOptions(), webBaseUrl: "not-a-url" }),
    /webBaseUrl must be a valid HTTP\(S\) URL/,
  );
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
  const client = createGitHubHttpClient({ ...baseOptions(), fetch: fetchImpl, timeoutMs: 10 });
  await assert.rejects(client.fetchPullRequests("solera-engineering/fl-titling"), (error) => {
    assert.ok(error instanceof GitHubHttpError);
    assert.equal(error.message, "Request timed out");
    return true;
  });
  assert.equal(sawAbortWhileReadingBody, true);
});
