import test from "node:test";
import assert from "node:assert/strict";
import { GitHubConnector } from "../src/index.js";

const options = (client, extra = {}) => new GitHubConnector({
  client, tenantId: "tenant-test", productId: "fl-titling",
  credentialRef: "secret://github/fl-titling", repository: "example/repo",
  now: () => "2026-09-10T16:00:00.000Z", ...extra,
});

test("validates configuration before collection", async () => {
  const connector = options({ fetchPullRequests: async () => [] }, { productId: "" });
  await assert.rejects(connector.collect().next(), /productId is required/);
});

test("collects paginated pull requests and changed files", async () => {
  const filePages = [];
  const connector = options({
    fetchPullRequests: async () => [{ number: 7, title: "Synthetic", updatedAt: "2026-09-10" }],
    fetchChangedFiles: async (_repo, _number, page) => {
      filePages.push(page);
      return page === 0 ? { items: [{ filename: "a.js" }], nextPage: 1 } : { items: [{ filename: "b.js" }] };
    },
  });
  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(records.map((record) => record.contentType), ["github.pull_request", "github.changed_file", "github.changed_file"]);
  assert.deepEqual(filePages, [0, 1]);
  assert.equal(connector.metrics.lastCheckpoint.pullRequest, "7");
});

test("collects only exact Jira-referenced pull requests within PR and file budgets", async () => {
  const connector = options({
    fetchPullRequests: async () => [],
    searchPullRequestsByIssue: async () => ({
      items: [
        {
          number: 7,
          title: "ABC-123 adds coverage",
          body: "",
          updated_at: "2026-09-10T10:00:00Z",
          pull_request: {}
        },
        {
          number: 8,
          title: "ABC-1234 is not the requested issue",
          body: "",
          updated_at: "2026-09-10T10:00:00Z",
          pull_request: {}
        }
      ]
    }),
    fetchChangedFiles: async () => ({
      items: [{ filename: "a.spec.ts" }, { filename: "b.spec.ts" }]
    })
  });

  const records = await Array.fromAsync(
    connector.collectPullRequestsByIssue(
      "abc-123",
      { maxPullRequests: 1, maxChangedFiles: 1 }
    )
  );

  assert.deepEqual(
    records.map((record) => record.contentType),
    ["github.pull_request", "github.changed_file"]
  );
  assert.deepEqual(records[0].payload.referencedIssues, ["ABC-123"]);
  assert.equal(records[1].sourceId, "example/repo#7:a.spec.ts");
});

test("restarts at page one and stops after an entirely older page within a lookback sync", async () => {
  const pages = [];
  const connector = options({
    fetchPullRequests: async (_repository, page) => {
      pages.push(page);
      if (page === 0) {
        return {
          items: [
            { number: 10, updated_at: "2026-09-10T12:01:00.000Z" },
            { number: 9, updated_at: "2026-09-10T11:59:30.000Z" },
          ],
          nextPage: 1,
        };
      }
      if (page === 1) {
        return {
          items: [{ number: 8, updated_at: "2026-09-10T10:00:00.000Z" }],
          nextPage: 2,
        };
      }
      throw new Error("an entirely older page must stop pagination");
    },
  }, { incrementalLookbackSeconds: 60 });

  const records = await Array.fromAsync(connector.collect({
    page: 99,
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(pages, [0, 1]);
  assert.deepEqual(records.map((record) => record.sourceId), [
    "example/repo#10",
    "example/repo#9",
  ]);
  assert.equal(
    connector.metrics.lastCheckpoint.sourceWatermark,
    "2026-09-10T12:01:00.000Z",
  );
});

test("emits sanitized start/retry/failure/complete events to an injected logger, never leaking the credential or payloads", async () => {
  const events = [];
  const logger = { info: (event) => events.push(event) };
  let attempts = 0;
  const connector = options(
    {
      fetchPullRequests: async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
        return [{ number: 21, updated_at: "2026-01-01T00:00:00Z", title: "secret title contents" }];
      },
    },
    { logger },
  );
  await Array.fromAsync(connector.collect());

  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ["connector.sync.start", "connector.retry", "connector.sync.complete"]);
  for (const event of events) {
    assert.equal(event.pluginId, "connector.github");
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("secret://"), false);
    assert.equal(serialized.includes("secret title contents"), false);
  }
  const completeEvent = events.find((event) => event.eventType === "connector.sync.complete");
  assert.equal(completeEvent.records, 1);
  assert.equal(completeEvent.retries, 1);
});

test("a broken logger sink never breaks a successful sync", async () => {
  const connector = options(
    { fetchPullRequests: async () => [{ number: 22, updated_at: "2026-01-01T00:00:00Z" }] },
    { logger: { info: () => { throw new Error("sink is down"); } } },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 1);
});

test("recovers from a permanent mid-sync failure by resuming from the preserved checkpoint, reproducing a stable idempotency key for the already-emitted record", async () => {
  const pages = {
    0: { items: [{ number: 7, updated_at: "2026-01-01T00:00:00Z" }], nextPage: 1 },
    1: { items: [{ number: 8, updated_at: "2026-01-02T00:00:00Z" }] },
  };
  const failingConnector = options({
    fetchPullRequests: async (_repo, page) => {
      if (page === 1) throw Object.assign(new Error("permanently rejected"), { status: 400 });
      return pages[page];
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
  assert.deepEqual(health.lastCheckpoint, { phase: "pull_requests", page: 0, pullRequest: "7" });
  assert.equal(firstRunRecords.length, 1);

  const recoveredConnector = options({
    fetchPullRequests: async (_repo, page) => pages[page],
  });
  const resumedRecords = await Array.fromAsync(recoveredConnector.collect({ page: health.lastCheckpoint.page }));

  // Resuming replays the checkpointed page (idempotent -- the identical
  // record is re-emitted with the exact same idempotency key) and then
  // reaches the page that previously failed.
  assert.equal(resumedRecords.length, 2);
  assert.equal(resumedRecords[0].idempotencyKey, firstRunRecords[0].idempotencyKey);
  assert.equal(resumedRecords[1].sourceId, "example/repo#8");
});

test("restarts pull-request and changed-file pagination when resuming so reordered records are not skipped", async () => {
  const pullRequestPages = [];
  const filePages = [];
  const connector = options({
    fetchPullRequests: async (_repo, page) => {
      pullRequestPages.push(page);
      return page === 0
        ? { items: [{ number: 9, updated_at: "2026-01-03T00:00:00Z" }], nextPage: 1 }
        : { items: [{ number: 7, updated_at: "2026-01-01T00:00:00Z" }] };
    },
    fetchChangedFiles: async (_repo, number, page) => {
      filePages.push([number, page]);
      return [{ filename: `tests/pr-${number}.spec.ts` }];
    },
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "changed_files",
    page: 1,
    pullRequest: "7",
    filePage: 3,
  }));

  assert.deepEqual(pullRequestPages, [0, 1]);
  assert.deepEqual(filePages, [["9", 0], ["7", 0]]);
  assert.deepEqual(
    records.filter((record) => record.contentType === "github.pull_request")
      .map((record) => record.sourceId),
    ["example/repo#9", "example/repo#7"],
  );
});

test("prefers the native GitHub updated_at field over the legacy updatedAt fallback", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 9, title: "Native shape", updated_at: "2026-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" }],
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceVersion, "2026-01-01T00:00:00Z");
});

test("falls back to the legacy updatedAt field when updated_at is absent", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 10, title: "Legacy shape", updatedAt: "2019-05-05T00:00:00Z" }],
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceVersion, "2019-05-05T00:00:00Z");
});

test("defaults evidence sourceUrl to github.com for backward compatibility when no webBaseUrl is configured", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 11, updated_at: "2026-01-01T00:00:00Z" }],
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://github.com/example/repo/pull/11");
});

test("uses an explicitly configured connector-level webBaseUrl for GitHub Enterprise evidence sourceUrl links", async () => {
  const connector = options(
    { fetchPullRequests: async () => [{ number: 12, updated_at: "2026-01-01T00:00:00Z" }] },
    { webBaseUrl: "https://ghe.example.test/" },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://ghe.example.test/example/repo/pull/12");
});

test("prefers the HTTP client's own validated webBaseUrl metadata over the github.com default", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 13, updated_at: "2026-01-01T00:00:00Z" }],
    webBaseUrl: "https://ghe-from-client.example.test",
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://ghe-from-client.example.test/example/repo/pull/13");
});

test("builds the pull_request evidence sourceUrl as /{repo}/pull/{number}", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 42, updated_at: "2026-01-01T00:00:00Z" }],
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].contentType, "github.pull_request");
  assert.equal(records[0].sourceUrl, "https://github.com/example/repo/pull/42");
});

test("builds the changed_file evidence sourceUrl as /{repo}/pull/{number}/files, not the bare repository", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 42, updated_at: "2026-01-01T00:00:00Z" }],
    fetchChangedFiles: async () => [{ filename: "src/app.js" }],
  }, { webBaseUrl: "https://ghe.example.test" });
  const records = await Array.fromAsync(connector.collect());
  const changedFile = records.find((record) => record.contentType === "github.changed_file");
  assert.ok(changedFile);
  assert.equal(changedFile.sourceUrl, "https://ghe.example.test/example/repo/pull/42/files");
});

test("rejects a malformed connector-level webBaseUrl override", () => {
  assert.throws(
    () => options({ fetchPullRequests: async () => [] }, { webBaseUrl: "not-a-url" }),
    /webBaseUrl must be a valid HTTP\(S\) URL/,
  );
});

test("rejects a plaintext, non-loopback connector-level webBaseUrl override", () => {
  assert.throws(
    () => options({ fetchPullRequests: async () => [] }, { webBaseUrl: "http://ghe.internal" }),
    /webBaseUrl must use HTTPS/,
  );
});

test("rejects a plaintext loopback connector-level webBaseUrl override unless allowInsecureLoopback is explicitly set", () => {
  assert.throws(
    () => options({ fetchPullRequests: async () => [] }, { webBaseUrl: "http://localhost:9000" }),
    /webBaseUrl must use HTTPS/,
  );
  assert.doesNotThrow(() => options(
    { fetchPullRequests: async () => [] },
    { webBaseUrl: "http://localhost:9000", allowInsecureLoopback: true },
  ));
});

test("does not re-validate the HTTP client's own already-validated webBaseUrl metadata when no explicit connector-level override is configured", async () => {
  // The HTTP client (createGitHubHttpClient) already validated this value
  // as HTTPS/loopback-safe at its own construction time; the connector
  // must trust it as immutable metadata rather than re-checking it, so an
  // https client-provided value flows straight through into sourceUrl.
  const connector = options({
    fetchPullRequests: async () => [{ number: 13, updated_at: "2026-01-01T00:00:00Z" }],
    webBaseUrl: "https://ghe-from-client.example.test",
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://ghe-from-client.example.test/example/repo/pull/13");
});

test("an explicit connector-level webBaseUrl override still takes priority over the HTTP client's own webBaseUrl metadata", async () => {
  const connector = options({
    fetchPullRequests: async () => [{ number: 14, updated_at: "2026-01-01T00:00:00Z" }],
    webBaseUrl: "https://ghe-from-client.example.test",
  }, { webBaseUrl: "https://ghe-explicit.example.test" });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl, "https://ghe-explicit.example.test/example/repo/pull/14");
});
