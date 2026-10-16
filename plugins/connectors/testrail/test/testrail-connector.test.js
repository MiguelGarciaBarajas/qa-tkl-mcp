import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../../tests/fixtures/testrail-project-128.json" with { type: "json" };
import { TestRailConnector, testrailManifest } from "../src/index.js";

const createConnector = (client, options = {}) => new TestRailConnector({
  client,
  tenantId: "tenant-test",
  productId: "fl-titling",
  projectId: 128,
  suiteIds: [12],
  baseUrl: "https://testrail.example.test",
  credentialRef: "secret://testrail/fl-titling",
  now: () => "2026-09-10T16:00:00.000Z",
  ...options,
});

const completeClient = {
  fetchSuites: async () => fixture.suites,
  fetchCases: async () => fixture.cases,
  fetchRuns: async () => fixture.runs,
  fetchResults: async () => fixture.results,
};

test("exposes a versioned manifest and validates required configuration", async () => {
  assert.deepEqual(testrailManifest.capabilities, ["suites", "cases", "runs", "results", "incremental-sync"]);
  assert.deepEqual(testrailManifest.requiredPermissions, ["testrail.project.read"]);
  assert.deepEqual(await createConnector(completeClient).validateConfiguration(), { valid: true, errors: [] });
  const validation = await createConnector(completeClient, {
    tenantId: "",
    productId: "",
    projectId: "",
    suiteIds: [],
    baseUrl: "",
    credentialRef: "",
  }).validateConfiguration();
  assert.deepEqual(validation.errors, [
    "tenantId is required",
    "productId is required",
    "projectId must be a positive integer",
    "selected suite scope requires at least one valid suite ID",
    "baseUrl must be a valid HTTP(S) URL",
    "credentialRef is required",
  ]);
});

test("rejects non-numeric IDs and non-HTTP URLs", async () => {
  const validation = await createConnector(completeClient, {
    projectId: "project-128",
    suiteIds: ["12", "suite-99"],
    baseUrl: "ftp://testrail.example.test",
  }).validateConfiguration();

  assert.deepEqual(validation.errors, [
    "projectId must be a positive integer",
    "selected suite scope requires at least one valid suite ID",
    "baseUrl must be a valid HTTP(S) URL",
  ]);
});

test("normalizes environment-derived IDs, URL, scope, and credential reference", async () => {
  const calls = [];
  const connector = createConnector({
    fetchSuites: async (projectId) => {
      calls.push(["suites", projectId]);
      return fixture.suites;
    },
    fetchCases: async (projectId, suiteId) => {
      calls.push(["cases", projectId, suiteId]);
      return fixture.cases;
    },
    fetchRuns: async (projectId) => {
      calls.push(["runs", projectId]);
      return fixture.runs;
    },
    fetchResults: async () => fixture.results,
  }, {
    tenantId: " tenant-test ",
    productId: " fl-titling ",
    projectId: " 0128 ",
    suiteIds: [" 012 ", "12"],
    baseUrl: " https://testrail.example.test/// ",
    credentialRef: " secret://testrail/fl-titling ",
  });

  const records = await Array.fromAsync(connector.collect());
  assert.deepEqual(calls, [
    ["suites", "128"],
    ["cases", "128", "12"],
    ["runs", "128"],
  ]);
  assert.equal(records[0].tenantId, "tenant-test");
  assert.equal(records[0].productId, "fl-titling");
  assert.match(records[0].sourceUrl, /^https:\/\/testrail\.example\.test\/index\.php/);
  assert.equal((await connector.health()).credentialRef, "secret://testrail/fl-titling");
});

test("collects only reference-filtered cases within selected suites and record budget", async () => {
  const calls = [];
  const connector = createConnector({
    ...completeClient,
    fetchCasesByReference: async (projectId, suiteId, reference) => {
      calls.push({ projectId, suiteId, reference });
      return {
        items: [
          { ...fixture.cases[0], id: 301, refs: "ABC-123" },
          { ...fixture.cases[0], id: 302, refs: "ABC-123" }
        ]
      };
    }
  });

  const records = await Array.fromAsync(
    connector.collectCasesByReference("abc-123", { maxRecords: 1 })
  );

  assert.deepEqual(calls, [{ projectId: "128", suiteId: "12", reference: "ABC-123" }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].contentType, "testrail.case");
  assert.equal(records[0].sourceId, "301");
});

test("collects one exact case without enumerating suites", async () => {
  const calls = [];
  const connector = createConnector({
    ...completeClient,
    fetchCase: async (caseId) => {
      calls.push(caseId);
      return { ...fixture.cases[0], id: 1201, refs: "STT-3731" };
    }
  });

  const records = await Array.fromAsync(connector.collectCase("001201"));

  assert.deepEqual(calls, ["1201"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceId, "1201");
  assert.equal(records[0].contentType, "testrail.case");
});

test("collects a bounded neighborhood from the exact case section", async () => {
  const calls = [];
  const connector = createConnector({
    ...completeClient,
    fetchCase: async () => ({
      ...fixture.cases[0],
      id: 1201,
      suite_id: 12,
      section_id: 44,
    }),
    fetchCasesInSection: async (projectId, suiteId, sectionId) => {
      calls.push({ projectId, suiteId, sectionId });
      return {
        items: [
          { ...fixture.cases[0], id: 1201 },
          { ...fixture.cases[0], id: 1202 },
        ],
      };
    },
  });

  const records = await Array.fromAsync(
    connector.collectCaseNeighborhood("1201", { maxRecords: 2 }),
  );

  assert.deepEqual(calls, [{ projectId: "128", suiteId: "12", sectionId: "44" }]);
  assert.deepEqual(records.map((record) => record.sourceId), ["1201", "1202"]);
});

test("collects cases directly from an explicitly selected suite section", async () => {
  const calls = [];
  const connector = createConnector({
    ...completeClient,
    fetchCasesInSection: async (projectId, suiteId, sectionId, page) => {
      calls.push({ projectId, suiteId, sectionId, page });
      return {
        items: [
          { ...fixture.cases[0], id: 1301, suite_id: 12, section_id: 44 },
          { ...fixture.cases[0], id: 1302, suite_id: 12, section_id: 44 },
        ],
      };
    },
  });

  const records = await Array.fromAsync(
    connector.collectCasesInSection("12", "44", { maxRecords: 2 }),
  );

  assert.deepEqual(calls, [{ projectId: "128", suiteId: "12", sectionId: "44", page: 0 }]);
  assert.deepEqual(records.map((record) => record.sourceId), ["1301", "1302"]);
});

test("emits suite, case, run, and result raw evidence without credentials", async () => {
  const records = await Array.fromAsync(createConnector(completeClient).collect());
  assert.deepEqual(records.map((record) => record.contentType), ["testrail.suite", "testrail.case", "testrail.run", "testrail.result"]);
  for (const record of records) {
    assert.equal(record.source, "testrail");
    assert.match(record.sourceUrl, /^https:\/\/testrail\.example\.test\//);
    assert.equal(record.contentHash.length, 64);
    assert.equal(record.idempotencyKey.length, 64);
    assert.equal(record.classification, "internal");
  }
  assert.equal(JSON.stringify(records).includes("secret://"), false);
});

test("uses local lookback filtering while emitting missing timestamps", async () => {
  const connector = createConnector({
    fetchSuites: async () => ({
      items: [
        { id: 12, updated_on: "2026-09-10T11:59:30.000Z" },
        { id: 13, updated_on: "2026-09-10T10:00:00.000Z" },
        { id: 14, version: 2 },
      ],
    }),
    fetchRuns: async () => ({ items: [] }),
  }, {
    suiteScope: "all",
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "complete",
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.deepEqual(records.map((record) => record.sourceId), ["12", "14"]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("restarts lookback traversal before an earlier skipped suite and retains the committed watermark", async () => {
  const calls = [];
  const connector = createConnector({
    fetchSuites: async (_projectId, page) => {
      calls.push(["suites", page]);
      return {
        items: [
          { id: 12, updated_on: "2026-09-10T10:00:00.000Z" },
          { id: 13, updated_on: "2026-09-10T10:00:00.000Z" },
        ],
      };
    },
    fetchCases: async (_projectId, suiteId, page) => {
      calls.push(["cases", suiteId, page]);
      return {
        items: suiteId === "12"
          ? [{ id: 1201, updated_on: "2026-09-10T11:59:30.000Z" }]
          : [],
      };
    },
    fetchRuns: async () => ({ items: [] }),
  }, {
    suiteScope: "all",
    suiteIds: undefined,
    incrementalLookbackSeconds: 60,
  });

  const records = await Array.fromAsync(connector.collect({
    phase: "cases",
    suiteId: "13",
    casePage: 4,
    sourceWatermark: "2026-09-10T12:00:00.000Z",
  }));

  assert.equal(records.some((record) => record.sourceId === "1201"), true);
  assert.deepEqual(calls.slice(0, 3), [
    ["suites", 0],
    ["cases", "12", 0],
    ["cases", "13", 0],
  ]);
  assert.equal(
    (await connector.health()).lastCheckpoint.sourceWatermark,
    "2026-09-10T12:00:00.000Z",
  );
});

test("collects only suites and suite-bound runs from the configured allowlist", async () => {
  const caseSuiteIds = [];
  const records = await Array.fromAsync(createConnector({
    fetchSuites: async () => [
      fixture.suites[0],
      { id: 99, name: "Out of scope", updated_on: 1789056000 },
    ],
    fetchCases: async (_projectId, suiteId) => {
      caseSuiteIds.push(suiteId);
      return suiteId === "12" ? fixture.cases : [{ id: 9901, title: "Out of scope" }];
    },
    fetchRuns: async () => [
      { ...fixture.runs[0], suite_id: 12 },
      { id: 99, suite_id: 99, name: "Out of scope run", updated_on: 1789056120 },
    ],
    fetchResults: async () => fixture.results,
  }).collect());

  assert.deepEqual(caseSuiteIds, ["12"]);
  assert.equal(records.some((record) => record.sourceId === "99" || record.sourceId === "9901"), false);
});

test("collects every current suite and suite-bound run when project scope is all", async () => {
  const caseSuiteIds = [];
  const records = await Array.fromAsync(createConnector({
    fetchSuites: async () => [
      fixture.suites[0],
      { id: 99, name: "Additional suite", updated_on: 1789056000 },
    ],
    fetchCases: async (_projectId, suiteId) => {
      caseSuiteIds.push(suiteId);
      return [{ id: Number(`${suiteId}01`), title: `Case for ${suiteId}` }];
    },
    fetchRuns: async () => [
      { ...fixture.runs[0], suite_id: 12 },
      { id: 99, suite_id: 99, name: "Additional run", updated_on: 1789056120 },
    ],
    fetchResults: async () => [],
  }, {
    suiteScope: "all",
    suiteIds: undefined,
  }).collect());

  assert.deepEqual(caseSuiteIds, ["12", "99"]);
  assert.equal(records.filter((record) => record.contentType === "testrail.suite").length, 2);
  assert.equal(records.filter((record) => record.contentType === "testrail.case").length, 2);
  assert.equal(records.filter((record) => record.contentType === "testrail.run").length, 2);
});

test("follows pagination for every TestRail resource", async () => {
  const calls = [];
  const page = (name, item) => async (...args) => {
    calls.push([name, ...args]);
    return args.at(-1) === 0 ? { items: [item], nextPage: 1 } : { items: [] };
  };
  const records = await Array.fromAsync(createConnector({
    fetchSuites: page("suites", fixture.suites[0]),
    fetchCases: page("cases", fixture.cases[0]),
    fetchRuns: page("runs", fixture.runs[0]),
    fetchResults: page("results", fixture.results[0]),
  }).collect());
  assert.equal(records.length, 4);
  assert.deepEqual(calls.filter(([name]) => name === "suites").map((call) => call.at(-1)), [0, 1]);
  assert.deepEqual(calls.filter(([name]) => name === "cases").map((call) => call.at(-1)), [0, 1]);
  assert.deepEqual(calls.filter(([name]) => name === "runs").map((call) => call.at(-1)), [0, 1]);
  assert.deepEqual(calls.filter(([name]) => name === "results").map((call) => call.at(-1)), [0, 1]);
});

test("resumes suite, case, run, and result cursors without re-emitting completed phases", async () => {
  const suiteCalls = [];
  const caseCalls = [];
  const runCalls = [];
  const resultCalls = [];
  const connector = createConnector({
    fetchSuites: async (_projectId, page) => {
      suiteCalls.push(page);
      return fixture.suites;
    },
    fetchCases: async (_projectId, _suiteId, page) => {
      caseCalls.push(page);
      return [fixture.cases[0]];
    },
    fetchRuns: async (_projectId, page) => {
      runCalls.push(page);
      return fixture.runs;
    },
    fetchResults: async (_runId, page) => {
      resultCalls.push(page);
      return [fixture.results[0]];
    },
  });
  const caseRecords = await Array.fromAsync(connector.collect({ phase: "cases", suiteId: 12, casePage: 4 }));
  assert.deepEqual(caseRecords.map((record) => record.contentType), ["testrail.case", "testrail.run", "testrail.result"]);
  assert.deepEqual(caseCalls, [4]);
  const resultRecords = await Array.fromAsync(connector.collect({ phase: "results", runId: 77, resultPage: 3 }));
  assert.deepEqual(resultRecords.map((record) => record.contentType), ["testrail.result"]);
  assert.deepEqual(resultCalls, [0, 3]);
  const runRecords = await Array.fromAsync(connector.collect({ phase: "runs", runPage: 2 }));
  assert.deepEqual(runRecords.map((record) => record.contentType), ["testrail.run", "testrail.result"]);
  assert.deepEqual(runCalls, [0, 0, 2]);
  const suiteRecords = await Array.fromAsync(connector.collect({ phase: "suites", suitePage: 4 }));
  assert.deepEqual(suiteRecords.map((record) => record.contentType), ["testrail.suite", "testrail.case", "testrail.run", "testrail.result"]);
  assert.deepEqual(suiteCalls, [0, 0, 0, 4]);
});

test("retries transient failures, reports health, and keeps idempotency deterministic", async () => {
  let attempts = 0;
  const connector = createConnector({
    ...completeClient,
    fetchSuites: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return fixture.suites;
    },
  });

  const records = await Array.fromAsync(connector.collect());
  const repeat = await Array.fromAsync(createConnector(completeClient).collect());
  assert.equal((await connector.health()).retries, 1);
  assert.equal((await connector.health()).status, "healthy");
  assert.equal(records[0].idempotencyKey, repeat[0].idempotencyKey);
});

test("honors bounded Retry-After metadata for transient failures", async () => {
  let attempts = 0;
  const connector = createConnector({
    ...completeClient,
    fetchSuites: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
      return fixture.suites;
    },
  });
  await Array.fromAsync(connector.collect());
  assert.equal(attempts, 2);
});

test("retries a recognized network/timeout failure (no status code) within bounds", async () => {
  let attempts = 0;
  const connector = createConnector({
    ...completeClient,
    fetchSuites: async () => {
      attempts += 1;
      // Mirrors the shared HTTP client's ConnectorHttpError shape for a
      // network failure or aborted/timed-out request: no `status` field.
      if (attempts === 1) throw new Error("Network request failed");
      return fixture.suites;
    },
  });
  const records = await Array.fromAsync(connector.collect());
  assert.equal(attempts, 2);
  assert.equal((await connector.health()).retries, 1);
  assert.ok(records.length > 0);
});

test("does not retry an ordinary non-transient 4xx failure", async () => {
  let attempts = 0;
  const connector = createConnector({
    ...completeClient,
    fetchSuites: async () => {
      attempts += 1;
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  });
  await assert.rejects(Array.fromAsync(connector.collect()), /not found/);
  assert.equal(attempts, 1);
  assert.equal((await connector.health()).status, "degraded");
});

test("emits sanitized start/retry/failure/complete events to an injected logger, never leaking the credential or payloads", async () => {
  const events = [];
  const logger = { info: (event) => events.push(event) };
  let attempts = 0;
  const connector = createConnector(
    {
      ...completeClient,
      fetchSuites: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: 0 });
        return fixture.suites;
      },
    },
    { logger },
  );
  await Array.fromAsync(connector.collect());

  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ["connector.sync.start", "connector.retry", "connector.sync.complete"]);
  for (const event of events) {
    assert.equal(event.pluginId, "connector.testrail");
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("secret://"), false);
    assert.equal(serialized.includes("Sanitized release run"), false);
  }
  const completeEvent = events.find((event) => event.eventType === "connector.sync.complete");
  assert.deepEqual(completeEvent.lastCheckpoint, { phase: "complete" });
});

test("a broken logger sink never breaks a successful sync", async () => {
  const connector = createConnector(completeClient, { logger: { info: () => { throw new Error("sink is down"); } } });
  const records = await Array.fromAsync(connector.collect());
  assert.ok(records.length > 0);
});

test("recovers from a permanent mid-sync failure by resuming from the preserved checkpoint, completing every phase with no lost records", async () => {
  const failingConnector = createConnector({
    ...completeClient,
    fetchRuns: async () => { throw Object.assign(new Error("permanently rejected"), { status: 400 }); },
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
  // Suites and cases were already emitted before runs failed; the
  // checkpoint reflects the last completed phase (cases).
  assert.deepEqual(health.lastCheckpoint, { phase: "cases", suiteId: "12", casePage: 0 });
  assert.deepEqual(firstRunRecords.map((record) => record.contentType), ["testrail.suite", "testrail.case"]);

  const recoveredConnector = createConnector(completeClient);
  const resumedRecords = await Array.fromAsync(recoveredConnector.collect(health.lastCheckpoint));

  // The suite phase is already behind the checkpoint and is not
  // re-emitted; the in-progress "cases" phase is safely (idempotently)
  // re-processed, and the previously-failing runs/results phases now
  // complete.
  assert.deepEqual(resumedRecords.map((record) => record.contentType), ["testrail.case", "testrail.run", "testrail.result"]);
  assert.equal(resumedRecords[0].idempotencyKey, firstRunRecords[1].idempotencyKey);

  const uniqueKeys = new Set([...firstRunRecords, ...resumedRecords].map((record) => record.idempotencyKey));
  assert.equal(uniqueKeys.size, 4); // suite, case, run, result -- nothing permanently lost
});

test("round-trips health().lastCheckpoint of {phase:'complete'} back into collect() as a fresh full sync", async () => {
  const connector = createConnector(completeClient);
  const firstRun = await Array.fromAsync(connector.collect());
  assert.equal(firstRun.length, 4);
  const health = await connector.health();
  assert.deepEqual(health.lastCheckpoint, { phase: "complete" });

  // Feeding the connector's own emitted terminal checkpoint back into
  // collect() must not be rejected as an invalid phase; it must resume as
  // a fresh full sync and collect everything again.
  const secondRun = await Array.fromAsync(connector.collect(health.lastCheckpoint));
  assert.equal(secondRun.length, 4);
  assert.deepEqual(secondRun.map((record) => record.contentType), firstRun.map((record) => record.contentType));
  assert.deepEqual((await connector.health()).lastCheckpoint, { phase: "complete" });
});

test("disregards stale positional fields alongside a phase:'complete' checkpoint", async () => {
  const suiteCalls = [];
  const connector = createConnector({
    ...completeClient,
    fetchSuites: async (_projectId, page) => {
      suiteCalls.push(page);
      return fixture.suites;
    },
  });
  // A {phase:"complete"} checkpoint must be treated as an entirely fresh
  // full sync -- any other (stale/unrelated) fields present alongside it
  // must not be trusted as resume cursors.
  const records = await Array.fromAsync(connector.collect({ phase: "complete", suitePage: 7, casePage: 9 }));
  assert.equal(records.length, 4);
  assert.deepEqual(suiteCalls, [0]);
});

test("requires the connector-level baseUrl to be HTTPS by default", async () => {
  const validation = await createConnector(completeClient, {
    baseUrl: "http://testrail.internal",
  }).validateConfiguration();
  assert.deepEqual(validation.errors, [
    "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
    + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
  ]);
});

test("allows a plain-HTTP connector-level baseUrl only for a loopback host with an explicit opt-in", async () => {
  const insecureNonLoopback = await createConnector(completeClient, {
    baseUrl: "http://testrail.internal",
    allowInsecureLoopback: true,
  }).validateConfiguration();
  assert.deepEqual(insecureNonLoopback.errors, [
    "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
    + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
  ]);

  const insecureLoopbackNoOptIn = await createConnector(completeClient, {
    baseUrl: "http://localhost:8080",
  }).validateConfiguration();
  assert.deepEqual(insecureLoopbackNoOptIn.errors, [
    "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
    + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
  ]);

  const insecureLoopbackWithOptIn = await createConnector(completeClient, {
    baseUrl: "http://localhost:8080",
    allowInsecureLoopback: true,
  }).validateConfiguration();
  assert.deepEqual(insecureLoopbackWithOptIn, { valid: true, errors: [] });
});

test("prefers the HTTP client's own validated baseUrl metadata when no connector-level baseUrl is configured", async () => {
  const client = { ...completeClient, baseUrl: "https://client-validated.testrail.example.test" };
  const connector = createConnector(client, { baseUrl: undefined });
  assert.deepEqual(await connector.validateConfiguration(), { valid: true, errors: [] });
  const records = await Array.fromAsync(connector.collect());
  assert.match(records[0].sourceUrl, /^https:\/\/client-validated\.testrail\.example\.test\//);
});

test("prefers an explicit connector-level baseUrl over the HTTP client's own baseUrl metadata", async () => {
  const client = { ...completeClient, baseUrl: "https://client-validated.testrail.example.test" };
  const connector = createConnector(client, { baseUrl: "https://explicit-override.testrail.example.test" });
  const records = await Array.fromAsync(connector.collect());
  assert.match(records[0].sourceUrl, /^https:\/\/explicit-override\.testrail\.example\.test\//);
});
