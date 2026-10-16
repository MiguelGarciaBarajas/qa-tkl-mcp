import test from "node:test";
import assert from "node:assert/strict";
import { ReportPortalConnector, reportportalManifest } from "../src/index.js";

const launch1 = { id: 1, name: "Regression nightly", status: "PASSED", startTime: 1_757_000_000_000, endTime: 1_757_000_100_000 };
const launch2 = { id: 2, name: "Smoke", status: "FAILED", startTime: 1_757_100_000_000, endTime: 1_757_100_050_000 };

const passingItem = {
  id: 10,
  launchId: 1,
  name: "billing deal totals reconcile",
  status: "PASSED",
  startTime: 1_757_000_000_500,
  endTime: 1_757_000_001_000,
  codeRef: "billing.spec.ts#reconcile",
};

const failedItemWithDefect = {
  id: 11,
  launchId: 2,
  name: "billing fee lines populate",
  status: "FAILED",
  startTime: 1_757_100_000_500,
  endTime: 1_757_100_002_000,
  issue: {
    issueType: "pb001",
    externalSystemIssues: [{ ticketId: "STT-5291", url: "https://jira.example/browse/STT-5291", btsProjectId: "STT" }],
  },
};

const createConnector = (client, options = {}) => new ReportPortalConnector({
  client,
  tenantId: "tenant-test",
  productId: "fl-titling",
  credentialRef: "secret://reportportal/fl-titling",
  project: "fl_titling",
  baseUrl: "https://reportportal.example.test",
  now: () => "2026-09-10T16:00:00.000Z",
  ...options,
});

test("exposes a versioned ReportPortal manifest and validates configuration", async () => {
  assert.equal(reportportalManifest.id, "connector.reportportal");
  const connector = createConnector({ fetchLaunches: async () => ({ items: [launch1] }) });
  assert.deepEqual(await connector.validateConfiguration(), { valid: true, errors: [] });
});

test("rejects invalid configuration before calling ReportPortal", async () => {
  let called = false;
  const connector = createConnector(
    { fetchLaunches: async () => { called = true; return { items: [] }; } },
    { project: "" },
  );
  await assert.rejects(connector.collect().next(), /project is required/);
  assert.equal(called, false);
});

test("emits reportportal.launch and reportportal.test_item raw evidence with deterministic identity", async () => {
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [launch1] }),
    fetchTestItems: async () => ({ items: [passingItem] }),
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 2);
  assert.equal(records[0].contentType, "reportportal.launch");
  assert.equal(records[0].sourceId, "1");
  assert.equal(records[1].contentType, "reportportal.test_item");
  assert.equal(records[1].sourceId, "10");
  assert.equal(records[1].idempotencyKey.length, 64);
  assert.equal(JSON.stringify(records).includes("secret://"), false);
});

test("collects test items for every launch in order", async () => {
  const calls = [];
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [launch1, launch2] }),
    fetchTestItems: async (id, page) => {
      calls.push([id, page]);
      return { items: id === "1" ? [passingItem] : [failedItemWithDefect] };
    },
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 4);
  assert.deepEqual(calls, [["1", 0], ["2", 0]]);
});

test("collects bounded execution history for one stable test identity", async () => {
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [] }),
    fetchTestItemsByIdentity: async (identity) => {
      assert.equal(identity, "billing.spec.ts#reconcile");
      return [passingItem];
    },
  });

  const records = await Array.fromAsync(
    connector.collectTestItemsByIdentity("billing.spec.ts#reconcile"),
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].contentType, "reportportal.test_item");
  assert.equal(records[0].sourceId, "10");
});

test("uses local lookback filtering without trusting start-time pagination order", async () => {
  const launchPages = [];
  const connector = createConnector({
    fetchLaunches: async (page) => {
      launchPages.push(page);
      if (page === 0) {
        return {
          items: [
            { id: 3, lastModified: "2026-09-10T10:00:00.000Z" },
            { id: 4, lastModified: "2026-09-10T11:59:30.000Z" },
          ],
          nextPage: 1,
        };
      }
      return { items: [{ id: 5, name: "timestamp unavailable" }] };
    },
  }, {
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "complete",
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(launchPages, [0, 1]);
  assert.deepEqual(records.map((record) => record.sourceId), ["4", "5"]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("restarts lookback traversal before an earlier skipped launch and retains the committed watermark", async () => {
  const calls = [];
  const connector = createConnector({
    fetchLaunches: async (page) => {
      calls.push(["launches", page]);
      return {
        items: [
          { id: 1, lastModified: "2026-09-10T10:00:00.000Z" },
          { id: 2, lastModified: "2026-09-10T10:00:00.000Z" },
        ],
      };
    },
    fetchTestItems: async (id, page) => {
      calls.push(["items", id, page]);
      return {
        items: id === "1"
          ? [{ id: 12, launchId: 1, lastModified: "2026-09-10T11:59:30.000Z" }]
          : [],
      };
    },
  }, {
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "items",
    launchId: "2",
    itemPage: 3,
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(calls, [
    ["launches", 0],
    ["items", "1", 0],
    ["items", "2", 0],
  ]);
  assert.equal(records.some((record) => record.sourceId === "12"), true);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("preserves explicit defect classification and external issue references on test items", async () => {
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [launch2] }),
    fetchTestItems: async () => ({ items: [failedItemWithDefect] }),
  });
  const records = await Array.fromAsync(connector.collect());
  const itemRecord = records.find((record) => record.contentType === "reportportal.test_item");
  assert.equal(itemRecord.payload.issue.issueType, "pb001");
  assert.deepEqual(itemRecord.payload.issue.externalSystemIssues, failedItemWithDefect.issue.externalSystemIssues);
});

test("supports paginated test items and resumes at the items phase for the correct launch", async () => {
  const calls = [];
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [launch1, launch2] }),
    fetchTestItems: async (id, page) => {
      calls.push([id, page]);
      if (id === "2" && page === 0) return { items: [failedItemWithDefect], nextPage: 1 };
      return { items: [] };
    },
  });
  const records = await Array.fromAsync(
    connector.collect({ phase: "items", launchId: "2", itemPage: 0 }),
  );
  assert.equal(records.length, 1);
  assert.deepEqual(calls, [["2", 0], ["2", 1]]);
});

test("rejects a resumed items checkpoint whose launch is no longer present", async () => {
  const connector = createConnector({
    fetchLaunches: async () => ({ items: [launch1] }),
    fetchTestItems: async () => ({ items: [] }),
  });
  await assert.rejects(
    Array.fromAsync(connector.collect({ phase: "items", launchId: "999", itemPage: 0 })),
    /Checkpoint launch "999" was not found/,
  );
});

test("a checkpoint of { phase: \"complete\" } starts a fresh full sync", async () => {
  const calls = [];
  const connector = createConnector({
    fetchLaunches: async () => {
      calls.push("launches");
      return { items: [launch1] };
    },
    fetchTestItems: async () => ({ items: [] }),
  });
  const records = await Array.fromAsync(connector.collect({ phase: "complete" }));
  assert.equal(records.length, 1);
  assert.deepEqual(calls, ["launches"]);
});

test("rejects an invalid checkpoint phase", async () => {
  const connector = createConnector({ fetchLaunches: async () => ({ items: [] }) });
  await assert.rejects(connector.collect({ phase: "bogus" }).next(), /checkpoint phase is invalid/);
});

test("retries transient failures and exposes health metrics", async () => {
  let attempts = 0;
  const connector = createConnector({
    fetchLaunches: async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { items: [launch1] };
    },
    fetchTestItems: async () => ({ items: [] }),
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
      fetchLaunches: async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
        return { items: [launch1] };
      },
      fetchTestItems: async () => ({ items: [passingItem] }),
    },
    { logger },
  );
  await Array.fromAsync(connector.collect());

  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ["connector.sync.start", "connector.retry", "connector.sync.complete"]);
  for (const event of events) {
    assert.equal(event.pluginId, "connector.reportportal");
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("secret://"), false);
    assert.equal(serialized.includes("billing"), false);
  }
});

test("a broken logger sink never breaks a successful sync", async () => {
  const connector = createConnector(
    { fetchLaunches: async () => ({ items: [launch1] }), fetchTestItems: async () => ({ items: [] }) },
    { logger: { info: () => { throw new Error("sink is down"); } } },
  );
  const records = await Array.fromAsync(connector.collect());
  assert.equal(records.length, 1);
});

test("rejects a plain-HTTP, non-loopback connector baseUrl by default", async () => {
  const connector = createConnector(
    { fetchLaunches: async () => ({ items: [] }) },
    { baseUrl: "http://reportportal.internal" },
  );
  await assert.rejects(connector.collect().next(), /baseUrl must use HTTPS/);
});
