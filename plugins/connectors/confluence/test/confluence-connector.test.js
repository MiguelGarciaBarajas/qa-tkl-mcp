import test from "node:test";
import assert from "node:assert/strict";
import { ConfluenceConnector, confluenceManifest } from "../src/index.js";

const requirementPage = {
  id: "111",
  type: "page",
  status: "current",
  title: "Billing fee lines",
  space: { key: "QA" },
  version: { number: 3, when: "2026-09-10T16:00:00.000Z" },
  body: { storage: { value: "<p>Fee lines must reconcile.</p>" } },
  metadata: { labels: { results: [{ name: "requirement" }] } },
};

const otherPage = {
  id: "222",
  type: "page",
  status: "current",
  title: "Team notes",
  space: { key: "QA" },
  version: { number: 1, when: "2026-09-10T16:00:00.000Z" },
  body: { storage: { value: "<p>Not a requirement.</p>" } },
  metadata: { labels: { results: [] } },
};

const createConnector = (client, options = {}) => new ConfluenceConnector({
  client,
  tenantId: "tenant-test",
  productId: "fl-titling",
  credentialRef: "secret://confluence/fl-titling",
  spaceKeys: ["QA"],
  baseUrl: "https://confluence.example.test/wiki",
  now: () => "2026-09-10T16:00:00.000Z",
  ...options,
});

test("exposes a versioned Confluence manifest and validates configuration", async () => {
  assert.equal(confluenceManifest.id, "connector.confluence");
  const connector = createConnector({ fetchSpacePages: async () => ({ items: [requirementPage] }) });
  assert.deepEqual(await connector.validateConfiguration(), { valid: true, errors: [] });
});

test("rejects invalid configuration before calling Confluence", async () => {
  let called = false;
  const connector = createConnector(
    { fetchSpacePages: async () => { called = true; return { items: [] }; } },
    { spaceKeys: [] },
  );
  await assert.rejects(connector.collect().next(), /spaceKeys must contain at least one allowlisted space/);
  assert.equal(called, false);
});

test("emits confluence.page raw evidence with deterministic identity", async () => {
  const connector = createConnector({ fetchSpacePages: async () => ({ items: [requirementPage, otherPage] }) });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 2);
  assert.equal(records[0].sourceId, "111");
  assert.equal(records[0].contentType, "confluence.page");
  assert.equal(records[0].idempotencyKey.length, 64);
  assert.equal(records[0].sourceUrl, "https://confluence.example.test/wiki/pages/viewpage.action?pageId=111");
  assert.equal(JSON.stringify(records).includes("secret://"), false);
});

test("collects contextual pages without enumerating a space", async () => {
  const connector = createConnector({
    fetchSpacePages: async () => {
      throw new Error("space enumeration must not run");
    },
    fetchPagesByText: async (query) => {
      assert.equal(query, "billing fee");
      return [requirementPage];
    },
  });

  const records = await Array.fromAsync(connector.collectPagesByText("billing fee"));

  assert.equal(records.length, 1);
  assert.equal(records[0].sourceId, "111");
});

test("uses local lookback filtering and emits pages with missing version timestamps", async () => {
  const connector = createConnector({
    fetchSpacePages: async () => ({
      items: [
        { ...requirementPage, id: "333", version: { number: 4, when: "2026-09-10T11:59:30.000Z" } },
        { ...otherPage, id: "444", version: { number: 2, when: "2026-09-10T10:00:00.000Z" } },
        { ...otherPage, id: "555", version: { number: 3 } },
      ],
    }),
  }, { incrementalLookbackSeconds: 60 });

  const records = await Array.fromAsync(connector.collect({
    phase: "complete",
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(records.map((record) => record.sourceId), ["333", "555"]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("restarts lookback traversal before an earlier skipped space and retains the committed watermark", async () => {
  const calls = [];
  const connector = createConnector({
    fetchSpacePages: async (spaceKey, page) => {
      calls.push([spaceKey, page]);
      return {
        items: spaceKey === "QA"
          ? [{ ...requirementPage, id: "333", version: { number: 4, when: "2026-09-10T11:59:30.000Z" } }]
          : [],
      };
    },
  }, {
    spaceKeys: ["QA", "DOCS"],
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "pages",
    spaceIndex: 1,
    spaceKey: "DOCS",
    start: { start: 50 },
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(calls, [["QA", 0], ["DOCS", 0]]);
  assert.deepEqual(records.map((record) => record.sourceId), ["333"]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("collects every configured space and paginates within each", async () => {
  const calls = [];
  const connector = createConnector(
    {
      fetchSpacePages: async (spaceKey, page) => {
        calls.push([spaceKey, page]);
        if (spaceKey === "QA" && (page === 0 || page === undefined)) {
          return { items: [requirementPage], nextPage: { start: 1 } };
        }
        if (spaceKey === "QA") return { items: [otherPage] };
        return { items: [] };
      },
    },
    { spaceKeys: ["QA", "TITLETEC"] },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 2);
  assert.deepEqual(calls, [["QA", 0], ["QA", { start: 1 }], ["TITLETEC", 0]]);
});

test("collects only an exact configured root page", async () => {
  const calls = [];
  const connector = createConnector(
    {
      fetchSpacePages: async () => ({ items: [] }),
      fetchPage: async (spaceKey, pageId) => {
        calls.push([spaceKey, pageId]);
        return requirementPage;
      },
    },
    {
      contentScope: "page",
      rootPageRefs: ["111:QA"],
    },
  );

  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(calls, [["QA", "111"]]);
  assert.deepEqual(records.map((record) => record.sourceId), ["111"]);
});

test("collects root page trees and deduplicates overlapping descendants", async () => {
  const calls = [];
  const connector = createConnector(
    {
      fetchSpacePages: async () => ({ items: [] }),
      fetchPage: async (_spaceKey, pageId) =>
        pageId === "111" ? requirementPage : otherPage,
      fetchPageTree: async (spaceKey, pageId, page) => {
        calls.push([spaceKey, pageId, page]);
        return pageId === "111" ? { items: [otherPage] } : { items: [] };
      },
    },
    {
      contentScope: "tree",
      rootPageRefs: ["111:QA", "222:QA"],
    },
  );

  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(calls, [["QA", "111", 0], ["QA", "222", 0]]);
  assert.deepEqual(records.map((record) => record.sourceId), ["111", "222"]);
});

test("resumes from a checkpoint at the correct space index/key and start offset", async () => {
  const calls = [];
  const connector = createConnector(
    {
      fetchSpacePages: async (spaceKey, page) => {
        calls.push([spaceKey, page]);
        return { items: [otherPage] };
      },
    },
    { spaceKeys: ["QA", "TITLETEC"] },
  );
  const records = await Array.fromAsync(
    connector.collect({ phase: "pages", spaceIndex: 1, spaceKey: "TITLETEC", start: 5 }),
  );
  assert.equal(records.length, 1);
  assert.deepEqual(calls, [["TITLETEC", 5]]);
});

test("rejects a checkpoint whose space no longer matches the configured spaceKeys", async () => {
  const connector = createConnector(
    { fetchSpacePages: async () => ({ items: [] }) },
    { spaceKeys: ["QA", "TITLETEC"] },
  );
  await assert.rejects(
    connector.collect({ phase: "pages", spaceIndex: 1, spaceKey: "OTHER", start: 0 }).next(),
    /does not match the configured space at index/,
  );
});

test("rejects checkpoints with a missing first-space key or an out-of-range space index", async () => {
  const connector = createConnector(
    { fetchSpacePages: async () => ({ items: [] }) },
    { spaceKeys: ["QA", "TITLETEC"] },
  );
  await assert.rejects(
    connector.collect({ phase: "pages", spaceIndex: 0, start: 0 }).next(),
    /does not match the configured space at index/,
  );
  await assert.rejects(
    connector.collect({ phase: "pages", spaceIndex: 2, spaceKey: "OTHER", start: 0 }).next(),
    /outside the configured spaceKeys/,
  );
});

test("a checkpoint of { phase: \"complete\" } starts a fresh full sync", async () => {
  const calls = [];
  const connector = createConnector({
    fetchSpacePages: async (spaceKey) => {
      calls.push(spaceKey);
      return { items: [otherPage] };
    },
  });
  const records = await Array.fromAsync(connector.collect({ phase: "complete" }));
  assert.equal(records.length, 1);
  assert.deepEqual(calls, ["QA"]);
});

test("retries transient failures and exposes health metrics", async () => {
  let attempts = 0;
  const connector = createConnector({
    fetchSpacePages: async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { items: [otherPage] };
    },
  });
  const records = await Array.fromAsync(connector.collect());
  const health = await connector.health();
  assert.equal(records.length, 1);
  assert.equal(health.retries, 1);
  assert.equal(health.status, "healthy");
  assert.deepEqual(health.lastCheckpoint, { phase: "complete" });
});

test("emits sanitized start/retry/failure/complete events to an injected logger, never leaking the credential or payloads", async () => {
  const events = [];
  const logger = { info: (event) => events.push(event) };
  let attempts = 0;
  const connector = createConnector(
    {
      fetchSpacePages: async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
        return { items: [requirementPage] };
      },
    },
    { logger },
  );
  await Array.fromAsync(connector.collect());

  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ["connector.sync.start", "connector.retry", "connector.sync.complete"]);
  for (const event of events) {
    assert.equal(event.pluginId, "connector.confluence");
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("secret://"), false);
    assert.equal(serialized.includes("Fee lines"), false);
  }
});

test("a broken logger sink never breaks a successful sync", async () => {
  const connector = createConnector(
    { fetchSpacePages: async () => ({ items: [otherPage] }) },
    { logger: { info: () => { throw new Error("sink is down"); } } },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 1);
});

test("rejects a plain-HTTP, non-loopback connector baseUrl by default", async () => {
  const connector = createConnector(
    { fetchSpacePages: async () => ({ items: [] }) },
    { baseUrl: "http://confluence.internal/wiki" },
  );
  await assert.rejects(connector.collect().next(), /baseUrl must use HTTPS/);
});

test("falls back to the client's own validated baseUrl when no connector-level baseUrl is set", async () => {
  const connector = createConnector(
    { fetchSpacePages: async () => ({ items: [requirementPage] }), baseUrl: "https://client.example.test/wiki" },
    { baseUrl: undefined },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records[0].sourceUrl.startsWith("https://client.example.test/wiki"), true);
});
