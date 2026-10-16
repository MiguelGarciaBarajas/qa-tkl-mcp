import test from "node:test";
import assert from "node:assert/strict";
import fixture from "../../../../tests/fixtures/stt-3731-jira.json" with { type: "json" };
import { DEFAULT_JIRA_BASE_URL, JiraConnector, createJiraHttpClient, jiraManifest } from "../src/index.js";

const createConnector = (client, options = {}) => new JiraConnector({
  client,
  tenantId: "tenant-test",
  productId: "fl-titling",
  credentialRef: "secret://jira/fl-titling",
  issueKey: "STT-3731",
  now: () => "2026-09-10T16:00:00.000Z",
  ...options,
});

test("exposes a versioned Jira manifest and validates credential references", async () => {
  assert.equal(jiraManifest.id, "connector.jira");
  const connector = createConnector({ fetchIssue: async () => fixture.issue });
  assert.deepEqual(await connector.validateConfiguration(), { valid: true, errors: [] });
});

test("emits issue and comment raw evidence with deterministic identity", async () => {
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async () => fixture.comments,
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 2);
  assert.equal(records[0].sourceId, "STT-3731");
  assert.equal(records[1].contentType, "jira.comment");
  assert.equal(records[1].idempotencyKey.length, 64);
  assert.equal(JSON.stringify(records).includes("secret://"), false);
});

test("uses the approved JQL scope when collecting a configured exact issue", async () => {
  let scopedRequest;
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    async fetchIssueWithinJql(issueKey, jql) {
      scopedRequest = { issueKey, jql };
      return fixture.issue;
    },
    async fetchComments() {
      return [];
    },
  }, {
    jql: "project = STT AND component = TITLING",
  });

  const records = await Array.fromAsync(connector.collect());

  assert.deepEqual(scopedRequest, {
    issueKey: "STT-3731",
    jql: "project = STT AND component = TITLING",
  });
  assert.equal(records[0].sourceId, "STT-3731");
});

test("applies lookback locally, emits invalid timestamps, and preserves late arrivals", async () => {
  const searchPages = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async (_jql, page) => {
      searchPages.push(page);
      if (page === 0) {
        return {
          items: [
            { key: "STT-LATE", fields: { updated: "2026-09-10T11:59:30.000Z" } },
            { key: "STT-OLD", fields: { updated: "2026-09-10T10:00:00.000Z" } },
          ],
          nextPage: 1,
        };
      }
      return { items: [{ key: "STT-INVALID", fields: {} }] };
    },
  }, {
    issueKey: undefined,
    jql: "project = STT ORDER BY updated DESC",
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    mode: "search",
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(searchPages, [0, 1], "Jira filtering never assumes stable upstream ordering");
  assert.deepEqual(records.map((record) => record.sourceId), ["STT-LATE", "STT-INVALID"]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("supports paginated comments and resumes at the comments phase", async () => {
  const calls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async (_key, page) => {
      calls.push(page);
      return page === 0 ? { items: [fixture.comments[0]], nextPage: 1 } : { items: [] };
    },
  });
  const records = await Array.fromAsync(connector.collect({ issueKey: "STT-3731", phase: "comments", commentPage: 0 }));
  assert.equal(records.length, 1);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(records[0].contentType, "jira.comment");
});

test("retries transient failures and exposes health metrics", async () => {
  let attempts = 0;
  const connector = createConnector({
    fetchIssue: async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429 });
      return fixture.issue;
    },
  });

  const records = await Array.fromAsync(connector.collect());
  const health = await connector.health();
  assert.equal(records.length, 1);
  assert.equal(health.retries, 1);
  assert.equal(health.status, "healthy");
});

test("rejects invalid configuration before calling Jira", async () => {
  let called = false;
  const connector = createConnector({ fetchIssue: async () => { called = true; return fixture.issue; } }, { productId: "" });
  await assert.rejects(connector.collect().next(), /productId is required/);
  assert.equal(called, false);
});

test("emits sanitized start/retry/failure/complete events to an injected logger, never leaking the credential or payloads", async () => {
  const events = [];
  const logger = { info: (event) => events.push(event) };
  let attempts = 0;
  const connector = createConnector(
    {
      fetchIssue: async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
        return fixture.issue;
      },
    },
    { logger },
  );
  await Array.fromAsync(connector.collect());

  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ["connector.sync.start", "connector.retry", "connector.sync.complete"]);
  for (const event of events) {
    assert.equal(event.pluginId, "connector.jira");
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("secret://"), false);
    assert.equal(serialized.includes("FL Modernization"), false);
  }
  const retryEvent = events.find((event) => event.eventType === "connector.retry");
  assert.equal(retryEvent.status, 429);
  assert.equal(retryEvent.attempt, 1);
  const completeEvent = events.find((event) => event.eventType === "connector.sync.complete");
  assert.equal(completeEvent.records, 1);
  assert.equal(completeEvent.retries, 1);
});

test("a broken logger sink never breaks a successful sync", async () => {
  const connector = createConnector(
    { fetchIssue: async () => fixture.issue },
    { logger: { info: () => { throw new Error("sink is down"); } } },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 1);
});

test("recovers from a permanent mid-sync failure by resuming from the preserved checkpoint, with no duplicated or lost records", async () => {
  const commentPages = {
    0: { items: [{ id: "c0", created: "2026-08-15T09:00:00.000-0400", body: "first page" }], nextPage: 1 },
    1: { items: [{ id: "c1", created: "2026-08-16T09:00:00.000-0400", body: "second page" }] },
  };
  const failingConnector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async (_key, page) => {
      if (page === 1) throw Object.assign(new Error("permanently rejected"), { status: 400 });
      return commentPages[page];
    },
  });

  const firstRunRecords = [];
  await assert.rejects(
    (async () => {
      for await (const record of failingConnector.collect()) firstRunRecords.push(record);
    })(),
    /permanently rejected/,
  );

  const health = await failingConnector.health();
  assert.equal(health.status, "degraded");
  assert.equal(health.failures, 1);
  // The checkpoint captured after page 0 succeeded (before the page-1
  // failure) must be preserved so a fresh connector instance can resume
  // exactly where the failed run left off.
  assert.deepEqual(health.lastCheckpoint, { phase: "comments", issueKey: "STT-3731", commentPage: 1 });
  assert.equal(firstRunRecords.length, 2); // issue + first comment page

  const recoveredConnector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async (_key, page) => commentPages[page],
  });
  const resumedRecords = await Array.fromAsync(
    recoveredConnector.collect({ issueKey: health.lastCheckpoint.issueKey, phase: "comments", commentPage: health.lastCheckpoint.commentPage }),
  );
  assert.equal(resumedRecords.length, 1); // only the still-missing second comment page

  const allRecords = [...firstRunRecords, ...resumedRecords];
  const idempotencyKeys = allRecords.map((record) => record.idempotencyKey);
  assert.equal(new Set(idempotencyKeys).size, idempotencyKeys.length, "no duplicate records across the failed and resumed runs");
  assert.deepEqual(
    allRecords.map((record) => record.sourceId).sort(),
    ["STT-3731", "STT-3731:c0", "STT-3731:c1"].sort(),
  );
});

test("supports JQL-driven issue search across pages with nested comment pagination", async () => {
  const searchPages = [];
  const commentPages = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      if (page === 0) return { items: [{ key: "STT-1001", updated: "2026-01-01" }], nextPage: 1 };
      return { items: [{ key: "STT-1002", updated: "2026-01-02" }] };
    },
    fetchComments: async (issueKey, page) => {
      commentPages.push([issueKey, page]);
      return page === 0 && issueKey === "STT-1001"
        ? { items: [fixture.comments[0]], nextPage: 1 }
        : { items: [] };
    },
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-1001",
    `STT-1001:${fixture.comments[0].id}`,
    "STT-1002",
  ]);
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0], ["project = STT AND status = Open", 1]]);
  assert.deepEqual(commentPages, [["STT-1001", 0], ["STT-1001", 1], ["STT-1002", 0]]);
});

test("reprocesses the entire checkpointed search page on resume, preserving comment-page resume only for the checkpointed issue", async () => {
  const searchPages = [];
  const commentCalls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      if (page === 0) {
        return {
          items: [{ key: "STT-1001", updated: "2026-01-01" }, { key: "STT-1002", updated: "2026-01-02" }],
          nextPage: 1,
        };
      }
      return { items: [{ key: "STT-1003", updated: "2026-01-03" }] };
    },
    fetchComments: async (issueKey, page) => {
      commentCalls.push([issueKey, page]);
      if (issueKey === "STT-1001") return page === 0 ? { items: [{ id: "c1" }], nextPage: 1 } : { items: [{ id: "c1b" }] };
      if (issueKey === "STT-1002") return page === 0 ? { items: [{ id: "c2a" }], nextPage: 1 } : { items: [{ id: "c2b" }] };
      return { items: [{ id: "c3a" }] };
    },
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  // A checkpoint captured mid-flight: STT-1001 (issue + all comments) had
  // already been fully collected in the checkpointed run, STT-1002's issue
  // record had been emitted and its first comment page consumed, so only
  // its second comment page was still pending.
  const checkpoint = { mode: "search", phase: "comments", page: 0, issueKey: "STT-1002", commentPage: 1 };
  const records = await Array.fromAsync(connector.collect(checkpoint));

  // The entire checkpointed page (STT-1001 and STT-1002) is reprocessed --
  // idempotency keys handle any duplicate emission of STT-1001, which the
  // connector cannot safely assume is still identical, still present, or
  // in the same position on resume. Only STT-1002's comment resume point
  // (page 1) is preserved; STT-1001's comments are collected from scratch.
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-1001",
    "STT-1001:c1",
    "STT-1001:c1b",
    "STT-1002",
    "STT-1002:c2b",
    "STT-1003",
    "STT-1003:c3a",
  ]);
  assert.deepEqual(commentCalls, [["STT-1001", 0], ["STT-1001", 1], ["STT-1002", 1], ["STT-1003", 0]]);
  // Resuming re-fetches the search page that contained the in-flight issue,
  // then continues to the next page normally.
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0], ["project = STT AND status = Open", 1]]);
});

test("reprocesses the checkpointed page and resumes comments correctly when the underlying search results have shifted and gained a new issue", async () => {
  const commentCalls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    // The checkpointed run saw [STT-1001, STT-1002] on page 0; by the time
    // this run resumes, a brand-new issue (STT-1000) has appeared ahead of
    // the previously-checkpointed STT-1002, shifting its position.
    searchIssues: async (_jql, page) => (page === 0
      ? { items: [{ key: "STT-1000", updated: "2026-01-05" }, { key: "STT-1002", updated: "2026-01-02" }] }
      : { items: [] }),
    fetchComments: async (issueKey, page) => {
      commentCalls.push([issueKey, page]);
      if (issueKey === "STT-1002") return page === 1 ? { items: [{ id: "c2b" }] } : { items: [{ id: "wrong-page" }] };
      return { items: [{ id: `${issueKey}-c0` }] };
    },
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const checkpoint = { mode: "search", phase: "comments", page: 0, issueKey: "STT-1002", commentPage: 1 };
  const records = await Array.fromAsync(connector.collect(checkpoint));

  // The new issue (STT-1000) is processed normally, and the shifted
  // checkpointed issue (STT-1002) still resumes its comments from the
  // checkpointed page (1), regardless of its new position on the page.
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-1000",
    "STT-1000:STT-1000-c0",
    "STT-1002",
    "STT-1002:c2b",
  ]);
  assert.deepEqual(commentCalls, [["STT-1000", 0], ["STT-1002", 1]]);
});

test("reprocesses the checkpointed page from the start when the checkpointed issue is missing or has moved to a different page", async () => {
  const commentCalls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    // STT-1002, the checkpointed issue, is no longer present anywhere in
    // the search results (for example it was resolved/moved out of the
    // JQL's result set between runs).
    searchIssues: async (_jql, page) => (page === 0
      ? { items: [{ key: "STT-1001", updated: "2026-01-01" }], nextPage: 1 }
      : { items: [{ key: "STT-1003", updated: "2026-01-03" }] }),
    fetchComments: async (issueKey, page) => {
      commentCalls.push([issueKey, page]);
      return { items: [{ id: `${issueKey}-c${page}` }] };
    },
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const checkpoint = { mode: "search", phase: "comments", page: 0, issueKey: "STT-1002", commentPage: 1 };
  const records = await Array.fromAsync(connector.collect(checkpoint));

  // Every issue on the checkpointed page is processed from the start
  // (comments from page 0, since the checkpointed issue never matched),
  // and pagination continues normally to subsequent pages afterward.
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-1001",
    "STT-1001:STT-1001-c0",
    "STT-1003",
    "STT-1003:STT-1003-c0",
  ]);
  assert.deepEqual(commentCalls, [["STT-1001", 0], ["STT-1003", 0]]);
});

test("preserves legacy single-issue checkpoints without a mode field", async () => {
  const calls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async (_key, page) => {
      calls.push(page);
      return page === 0 ? { items: [fixture.comments[0]], nextPage: 1 } : { items: [] };
    },
  });
  const records = await Array.fromAsync(connector.collect({ issueKey: "STT-3731", phase: "comments", commentPage: 0 }));
  assert.equal(records.length, 1);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(records[0].contentType, "jira.comment");
});

test("requires either an issueKey or a jql to be configured", async () => {
  const connector = createConnector(
    { fetchIssue: async () => fixture.issue },
    { issueKey: undefined, jql: undefined },
  );
  await assert.rejects(connector.collect().next(), /Either issueKey or jql is required/);
});

test("preserves the legacy client.issueKey fallback in validation and collection", async () => {
  const client = { issueKey: "STT-3731", fetchIssue: async () => fixture.issue };
  const connector = createConnector(client, { issueKey: undefined, jql: undefined });
  assert.deepEqual(await connector.validateConfiguration(), { valid: true, errors: [] });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceId, "STT-3731");
});

test("derives evidence sourceUrl from the configured baseUrl, not a hard-coded host", async () => {
  const connector = createConnector(
    { fetchIssue: async () => fixture.issue },
    { baseUrl: "https://custom-jira.example.test/jira" },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://custom-jira.example.test/jira/browse/STT-3731");
});

test("preserves legacy injected-client support by defaulting sourceUrl to the base client URL when baseUrl is omitted", async () => {
  const connector = createConnector({ fetchIssue: async () => fixture.issue });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, `${DEFAULT_JIRA_BASE_URL}/browse/STT-3731`);
});

test("prefers the native Jira fields.updated timestamp over the legacy flat updated field in legacy issue mode", async () => {
  const connector = createConnector({
    fetchIssue: async () => ({ key: "STT-3731", updated: "2020-01-01T00:00:00.000Z", fields: { updated: "2026-05-05T00:00:00.000Z" } }),
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceVersion, "2026-05-05T00:00:00.000Z");
});

test("falls back to the legacy flat updated field when fields.updated is absent in legacy issue mode", async () => {
  const connector = createConnector({ fetchIssue: async () => fixture.issue });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceVersion, fixture.issue.updated);
});

test("rejects an unrecognized checkpoint mode instead of silently falling back to a heuristic", async () => {
  const connector = createConnector({ fetchIssue: async () => fixture.issue });
  await assert.rejects(
    connector.collect({ mode: "bulk-export", issueKey: "STT-3731" }).next(),
    /Unknown checkpoint mode "bulk-export"/,
  );
});

test("allows a single-issue checkpoint whose issueKey matches the configured issueKey", async () => {
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    fetchComments: async () => ({ items: [] }),
  });
  const records = await Array.fromAsync(connector.collect({ mode: "issue", issueKey: "STT-3731" }));
  assert.equal(records[0].sourceId, "STT-3731");
});

test("rejects a single-issue checkpoint whose issueKey does not match the configured issueKey, so a checkpoint cannot override scope", async () => {
  let called = false;
  const connector = createConnector({ fetchIssue: async () => { called = true; return fixture.issue; } });
  await assert.rejects(
    connector.collect({ mode: "issue", issueKey: "OTHER-999" }).next(),
    /Checkpoint issueKey "OTHER-999" does not match the configured issueKey "STT-3731"/,
  );
  assert.equal(called, false);
});

test("rejects a legacy (mode-less) checkpoint issueKey that does not match the configured issueKey", async () => {
  let called = false;
  const connector = createConnector({ fetchIssue: async () => { called = true; return fixture.issue; } });
  await assert.rejects(
    connector.collect({ issueKey: "OTHER-999", phase: "comments", commentPage: 0 }).next(),
    /Checkpoint issueKey "OTHER-999" does not match the configured issueKey "STT-3731"/,
  );
  assert.equal(called, false);
});

test("rejects a single-issue checkpoint issueKey that does not match the legacy client.issueKey fallback", async () => {
  const client = { issueKey: "STT-3731", fetchIssue: async () => fixture.issue };
  const connector = createConnector(client, { issueKey: undefined, jql: undefined });
  await assert.rejects(
    connector.collect({ mode: "issue", issueKey: "OTHER-999" }).next(),
    /Checkpoint issueKey "OTHER-999" does not match the configured issueKey "STT-3731"/,
  );
});

test("routes a mode: \"search\" checkpoint through search only, even when it carries an issueKey unrelated to the connector's configured single-issue scope", async () => {
  const searchPages = [];
  const connector = createConnector({
    fetchIssue: async () => { throw new Error("collectIssue must not be used for a search-mode checkpoint"); },
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      return { items: [{ key: "STT-1001", updated: "2026-01-01" }] };
    },
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: "STT-3731", jql: "project = STT AND status = Open" });

  // The checkpoint's issueKey ("STT-3731") happens to equal this connector's
  // configured single-issue scope, but its mode is "search", so it must
  // still be routed through collectSearch (never collectIssue) and must
  // never trigger the single-issue scope-mismatch check.
  const records = await Array.fromAsync(connector.collect({ mode: "search", page: 0, issueKey: "STT-3731", commentPage: 0 }));
  assert.deepEqual(records.map((record) => record.sourceId), ["STT-1001"]);
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0]]);
});

test("regression: JQL resume restarts from page 0 so an issue reordered to before the checkpointed page is not lost behind the cursor", async () => {
  const searchPages = [];
  const commentCalls = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    // The checkpointed run had already advanced past page 0 (to page 1,
    // in-flight on STT-2002) when it was interrupted. By the time this run
    // resumes, STT-2005 -- which the checkpointed run had NOT yet seen --
    // has been reordered onto page 0, *ahead of* the checkpoint cursor
    // (page 1). A resume that started at checkpoint.page (the pre-fix
    // behavior) would skip page 0 entirely and silently lose STT-2005.
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      if (page === 0) return { items: [{ key: "STT-2005", updated: "2026-02-01" }], nextPage: 1 };
      if (page === 1) return { items: [{ key: "STT-2002", updated: "2026-01-02" }] };
      return { items: [] };
    },
    fetchComments: async (issueKey, page) => {
      commentCalls.push([issueKey, page]);
      if (issueKey === "STT-2002") return page === 1 ? { items: [{ id: "c2b" }] } : { items: [{ id: "wrong-page" }] };
      return { items: [{ id: `${issueKey}-c0` }] };
    },
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const checkpoint = { mode: "search", phase: "comments", page: 1, issueKey: "STT-2002", commentPage: 1 };
  const records = await Array.fromAsync(connector.collect(checkpoint));

  // Page 0 (STT-2005) is not skipped even though it precedes the
  // checkpointed page, and the checkpointed issue (STT-2002) still resumes
  // its comments from the checkpointed page (1).
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-2005",
    "STT-2005:STT-2005-c0",
    "STT-2002",
    "STT-2002:c2b",
  ]);
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0], ["project = STT AND status = Open", 1]]);
  assert.deepEqual(commentCalls, [["STT-2005", 0], ["STT-2002", 1]]);
});

test("rejects a malformed connector-level baseUrl override", () => {
  assert.throws(
    () => createConnector({ fetchIssue: async () => fixture.issue }, { baseUrl: "not-a-url" }),
    /baseUrl must be a valid HTTP\(S\) URL/,
  );
});

test("rejects a plaintext, non-loopback connector-level baseUrl override", () => {
  assert.throws(
    () => createConnector({ fetchIssue: async () => fixture.issue }, { baseUrl: "http://jira.internal/jira" }),
    /baseUrl must use HTTPS/,
  );
});

test("rejects a plaintext loopback connector-level baseUrl override unless allowInsecureLoopback is explicitly set", () => {
  assert.throws(
    () => createConnector({ fetchIssue: async () => fixture.issue }, { baseUrl: "http://localhost:9000/jira" }),
    /baseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => createConnector(
    { fetchIssue: async () => fixture.issue },
    { baseUrl: "http://localhost:9000/jira", allowInsecureLoopback: true },
  ));
});

test("prefers the HTTP client's own already-validated baseUrl metadata over the default when no explicit connector-level baseUrl is configured", async () => {
  const client = createJiraHttpClient({
    baseUrl: "https://jira-from-client.example.test/jira",
    credentialRef: "secret://jira/fl-titling",
    resolveCredential: async () => "token",
    allowedProjects: ["STT"],
    allowedJql: ["project = STT AND status = Open"],
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(fixture.issue),
    }),
  });
  const connector = createConnector(client, { baseUrl: undefined });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://jira-from-client.example.test/jira/browse/STT-3731");
});

test("an explicit connector-level baseUrl override still takes priority over the HTTP client's own baseUrl metadata", async () => {
  const client = createJiraHttpClient({
    baseUrl: "https://jira-from-client.example.test/jira",
    credentialRef: "secret://jira/fl-titling",
    resolveCredential: async () => "token",
    allowedProjects: ["STT"],
    allowedJql: ["project = STT AND status = Open"],
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(fixture.issue),
    }),
  });
  const connector = createConnector(client, { baseUrl: "https://custom-jira.example.test/jira" });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://custom-jira.example.test/jira/browse/STT-3731");
});

test("a JQL-only connector rejects a mode: \"issue\" checkpoint", async () => {
  const connector = createConnector({
    fetchIssue: async () => { throw new Error("collectIssue must not be used"); },
    searchIssues: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  await assert.rejects(
    connector.collect({ mode: "issue", issueKey: "STT-3731" }).next(),
    /Checkpoint mode "issue" is not valid for this connector.*JQL-only/,
  );
});

test("an issue-only connector rejects a mode: \"search\" checkpoint", async () => {
  const connector = createConnector({
    fetchIssue: async () => { throw new Error("should not be reached"); },
    searchIssues: async () => { throw new Error("collectSearch must not be used"); },
  }, { issueKey: "STT-3731", jql: undefined });

  await assert.rejects(
    connector.collect({ mode: "search", page: 0 }).next(),
    /Checkpoint mode "search" is not valid for this connector.*issue-only/,
  );
});

test("an issue-only connector (no searchIssues capability on the client) also rejects a mode: \"search\" checkpoint", async () => {
  // Configured with a jql, but the injected client does not implement
  // searchIssues at all -- search is not actually usable, so a search-mode
  // checkpoint must still be rejected rather than blowing up deep inside
  // collectSearch with an unrelated "not a function" error.
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
  }, { issueKey: "STT-3731", jql: "project = STT AND status = Open" });

  await assert.rejects(
    connector.collect({ mode: "search", page: 0 }).next(),
    /Checkpoint mode "search" is not valid for this connector/,
  );
});

test("stamps a deterministic JQL fingerprint on every search checkpoint", async () => {
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async () => ({ items: [{ key: "STT-1001", updated: "2026-01-01" }] }),
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  await Array.fromAsync(connector.collect());
  const health = await connector.health();
  assert.equal(health.lastCheckpoint.mode, "search");
  assert.equal(typeof health.lastCheckpoint.jqlFingerprint, "string");
  assert.equal(health.lastCheckpoint.jqlFingerprint.length, 64);

  // The fingerprint is a pure, deterministic function of the configured
  // JQL: a second connector configured with the exact same JQL produces the
  // identical fingerprint.
  const other = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async () => ({ items: [{ key: "STT-2001", updated: "2026-01-02" }] }),
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });
  await Array.fromAsync(other.collect());
  assert.equal((await other.health()).lastCheckpoint.jqlFingerprint, health.lastCheckpoint.jqlFingerprint);
});

test("accepts a resumed search checkpoint whose JQL fingerprint matches the configured JQL", async () => {
  const searchPages = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      return { items: [{ key: "STT-1001", updated: "2026-01-01" }] };
    },
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const firstRun = await Array.fromAsync(connector.collect());
  const checkpoint = (await connector.health()).lastCheckpoint;
  assert.ok(checkpoint.jqlFingerprint);

  searchPages.length = 0;
  const resumed = await Array.fromAsync(connector.collect(checkpoint));
  assert.ok(firstRun.length > 0);
  assert.ok(resumed.length > 0);
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0]]);
});

test("rejects a resumed search checkpoint whose JQL fingerprint no longer matches the connector's configured JQL", async () => {
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async () => ({ items: [{ key: "STT-1001", updated: "2026-01-01" }] }),
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  await Array.fromAsync(connector.collect());
  const staleCheckpoint = (await connector.health()).lastCheckpoint;

  // The connector's JQL is reconfigured (for example after an allowlist
  // change), so the previously saved checkpoint's JQL fingerprint no longer
  // matches -- resuming it would silently apply page/comment cursors
  // captured against a different query.
  const reconfigured = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async () => { throw new Error("searchIssues must not be called for a rejected checkpoint"); },
  }, { issueKey: undefined, jql: "project = STT AND status = Closed" });

  await assert.rejects(
    reconfigured.collect(staleCheckpoint).next(),
    /Checkpoint JQL fingerprint does not match the configured JQL/,
  );
});

test("resumes a legacy search checkpoint that predates the JQL fingerprint field without a fingerprint to compare", async () => {
  const searchPages = [];
  const connector = createConnector({
    fetchIssue: async () => fixture.issue,
    searchIssues: async (jql, page) => {
      searchPages.push([jql, page]);
      return { items: [{ key: "STT-1001", updated: "2026-01-01" }] };
    },
    fetchComments: async () => ({ items: [] }),
  }, { issueKey: undefined, jql: "project = STT AND status = Open" });

  const legacyCheckpoint = { mode: "search", phase: "comments", page: 0, issueKey: "STT-1001", commentPage: 0 };
  const records = await Array.fromAsync(connector.collect(legacyCheckpoint));
  assert.ok(records.length > 0);
  assert.deepEqual(searchPages, [["project = STT AND status = Open", 0]]);
});

/**
 * Builds a fake Jira REST endpoint that always caps `maxResults` at `cap`,
 * however large a page the caller asks for -- the real behavior of a Jira
 * instance with `jira.search.views.default.max` set below the connector's
 * configured page size. Every request is recorded so a test can prove the
 * connector walked a gap-free, cumulative absolute offset.
 */
function cappedJiraFetch({ issueKeys, commentsByIssue, cap }) {
  const calls = [];
  const respond = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const startAt = Number(parsed.searchParams.get("startAt"));
    calls.push({ pathname: parsed.pathname, startAt });
    if (parsed.pathname.endsWith("/comment")) {
      const issueKey = decodeURIComponent(parsed.pathname.split("/").at(-2));
      const all = commentsByIssue[issueKey] ?? [];
      return respond({ startAt, maxResults: cap, total: all.length, comments: all.slice(startAt, startAt + cap) });
    }
    return respond({
      startAt,
      maxResults: cap,
      total: issueKeys.length,
      issues: issueKeys.slice(startAt, startAt + cap).map((key) => ({ key, fields: { updated: "2026-01-01" } })),
    });
  };
  return { calls, fetchImpl };
}

const cappedConnectorOptions = (fetchImpl) => ({
  client: createJiraHttpClient({
    fetch: fetchImpl,
    baseUrl: "https://jira.example.test/jira",
    credentialRef: "secret://jira/fl-titling",
    resolveCredential: async () => "token",
    allowedProjects: ["STT"],
    allowedJql: ["project = STT AND status = Open"],
    // Deliberately far above the server's cap: the gap-free cursor must come
    // from what the server returned, never from page * pageSize.
    pageSize: 100,
  }),
  issueKey: undefined,
  jql: "project = STT AND status = Open",
});

test("emits every searched issue and every comment when the Jira server caps maxResults below the configured pageSize", async () => {
  const issueKeys = ["STT-1", "STT-2", "STT-3", "STT-4", "STT-5"];
  const commentsByIssue = {
    "STT-1": [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
    "STT-2": [], "STT-3": [], "STT-4": [], "STT-5": [],
  };
  const { calls, fetchImpl } = cappedJiraFetch({ issueKeys, commentsByIssue, cap: 2 });
  const connector = createConnector(undefined, cappedConnectorOptions(fetchImpl));

  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(records.map((record) => record.sourceId), [
    "STT-1", "STT-1:c1", "STT-1:c2", "STT-1:c3",
    "STT-2", "STT-3", "STT-4", "STT-5",
  ]);

  // Search paged 0 -> 2 -> 4 (cumulative, from the server's own counts), not
  // 0 -> 100 -> 200; the comment pages did the same for STT-1.
  assert.deepEqual(
    calls.filter((call) => call.pathname.endsWith("/search")).map((call) => call.startAt),
    [0, 2, 4],
  );
  assert.deepEqual(
    calls.filter((call) => call.pathname.includes("STT-1/comment")).map((call) => call.startAt),
    [0, 2],
  );
});

test("resumes a capped search from the { startAt } cursor its own checkpoint recorded, re-emitting the replayed range and nothing beyond it", async () => {
  const issueKeys = ["STT-1", "STT-2", "STT-3", "STT-4", "STT-5"];
  const commentsByIssue = { "STT-1": [], "STT-2": [], "STT-3": [{ id: "c30" }, { id: "c31" }, { id: "c32" }], "STT-4": [], "STT-5": [] };

  const interrupted = cappedJiraFetch({ issueKeys, commentsByIssue, cap: 2 });
  const first = createConnector(undefined, cappedConnectorOptions(interrupted.fetchImpl));
  const collected = [];
  for await (const record of first.collect()) {
    collected.push(record.sourceId);
    // Stop once the second comment page has started, so the recorded
    // checkpoint is a genuine mid-comments cursor rather than a page
    // boundary.
    if (record.sourceId === "STT-3:c32") break;
  }
  const checkpoint = (await first.health()).lastCheckpoint;
  assert.deepEqual(collected, ["STT-1", "STT-2", "STT-3", "STT-3:c30", "STT-3:c31", "STT-3:c32"]);
  assert.equal(checkpoint.phase, "comments");
  assert.deepEqual(checkpoint.page, { startAt: 2 });
  assert.deepEqual(checkpoint.commentPage, { startAt: 2 });
  assert.equal(checkpoint.issueKey, "STT-3");

  const resumed = cappedJiraFetch({ issueKeys, commentsByIssue, cap: 2 });
  const second = createConnector(undefined, cappedConnectorOptions(resumed.fetchImpl));
  const replayed = await Array.fromAsync(second.collect(checkpoint));

  // Resume replays from the first page (search order is not stable), keeps
  // the checkpointed issue's comment cursor, and still reaches every issue
  // past the checkpointed page -- with no offset gap anywhere.
  assert.deepEqual(replayed.map((record) => record.sourceId), [
    "STT-1", "STT-2", "STT-3", "STT-3:c32", "STT-4", "STT-5",
  ]);
  assert.deepEqual(
    resumed.calls.filter((call) => call.pathname.endsWith("/search")).map((call) => call.startAt),
    [0, 2, 4],
  );
});
