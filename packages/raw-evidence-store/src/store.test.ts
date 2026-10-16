import test from "node:test";
import assert from "node:assert/strict";
import type { RawEvidenceRecord } from "@tkl/contracts";
import {
  DuplicateEvidenceConflictError,
  InMemoryRawEvidenceStore,
  RawEvidenceScopeError,
} from "./store.ts";

function record(overrides: Partial<RawEvidenceRecord> = {}): RawEvidenceRecord {
  return {
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-1234",
    sourceVersion: "3",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "application/json",
    contentHash: "hash-abc",
    payload: { summary: "A sanitized fixture requirement" },
    classification: "internal",
    ...overrides,
  };
}

test("accepts dotted tenant and product scope identifiers", () => {
  assert.doesNotThrow(
    () => new InMemoryRawEvidenceStore({ tenantId: "solera.qa", productId: "fl.titling" }),
  );
});

test("commits new records and reports zero duplicates on first ingestion", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  const input = record();
  const result = await store.commit({
    connectorId: "connector-jira",
    records: [input],
    checkpoint: { cursor: "STT-1234" },
  });

  assert.equal(result.committedCount, 1);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.totalCount, 1);
  assert.equal(result.checkpointAdvanced, true);
  assert.deepEqual(result.checkpoint, { cursor: "STT-1234" });
  assert.deepEqual(result.committedIdempotencyKeys, ["jira:STT-1234:3"]);
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.listPendingProjectionRecords().length, 1);
  await store.acknowledgeProjected(result.committedIdempotencyKeys);
  assert.deepEqual(store.listPendingProjectionRecords(), []);
  assert.equal(store.hasEvidence(input), true);
  assert.equal(store.hasEvidence(record({ sourceId: "missing-record" })), false);
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
});

test("tracks projection failures, isolates poison records, and requeues bounded DLQ entries", async () => {
  const timestamps = [
    "2026-09-14T10:00:00.000Z",
    "2026-09-14T10:01:00.000Z",
    "2026-09-14T10:02:00.000Z",
  ];
  const store = new InMemoryRawEvidenceStore({
    tenantId: "solera",
    productId: "fl-titling",
    projectionFailureThreshold: 2,
    now: () => timestamps.shift() ?? "2026-09-14T10:03:00.000Z",
  });
  await store.commit({
    connectorId: "connector-jira",
    records: [
      record({ sourceId: "healthy", idempotencyKey: "jira:healthy:1" }),
      record({ sourceId: "poison", idempotencyKey: "jira:poison:1" }),
    ],
  });

  assert.equal(store.countPendingProjectionRecords(), 2);
  assert.equal(store.hasPendingProjection("jira:healthy:1"), true);
  assert.deepEqual(
    await store.recordProjectionFailures(["jira:poison:1", "jira:poison:1"]),
    { failedCount: 1, deadLetteredCount: 0 },
  );
  assert.deepEqual(
    store.listPendingProjectionRecords().map((item) => item.sourceId),
    ["healthy", "poison"],
  );
  await store.acknowledgeProjected(["jira:healthy:1"]);
  assert.equal(store.hasPendingProjection("jira:healthy:1"), false);
  assert.deepEqual(
    await store.recordProjectionFailures(["jira:poison:1"]),
    { failedCount: 1, deadLetteredCount: 1 },
  );

  assert.equal(store.countPendingProjectionRecords(), 0);
  assert.equal(store.countDeadLetterProjectionRecords(), 1);
  assert.deepEqual(store.listDeadLetterProjectionRecords(1), [{
    idempotencyKey: "jira:poison:1",
    connectorId: "connector-jira",
    failureCode: "projection-failed",
    attemptCount: 2,
    firstFailedAt: "2026-09-14T10:01:00.000Z",
    lastFailedAt: "2026-09-14T10:02:00.000Z",
  }]);
  assert.equal(await store.requeueDeadLetterProjectionRecords(["jira:poison:1"]), 1);
  assert.equal(store.countDeadLetterProjectionRecords(), 0);
  assert.deepEqual(
    store.listPendingProjectionRecords().map((item) => item.sourceId),
    ["poison"],
  );
});

test("projection DLQ metadata never accepts or exposes raw error messages", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: "solera",
    productId: "fl-titling",
    projectionFailureThreshold: 1,
    now: () => "2026-09-14T10:00:00.000Z",
  });
  await store.commit({
    connectorId: "connector-jira",
    records: [record({ idempotencyKey: "jira:poison:1" })],
  });
  await store.recordProjectionFailures(["jira:poison:1"]);

  const serialized = JSON.stringify(store.listDeadLetterProjectionRecords());
  assert.doesNotMatch(serialized, /message|stack|payload|secret/i);
  assert.throws(
    () => store.listDeadLetterProjectionRecords(0),
    /Projection batch limit must be a positive integer/,
  );
  await assert.rejects(
    () => store.requeueDeadLetterProjectionRecords(
      Array.from({ length: 1001 }, (_, index) => `key-${index}`),
    ),
    /Projection operation accepts at most 1000 keys/,
  );
});

test("replaying an identical record is a no-op counted as a duplicate", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({ connectorId: "connector-jira", records: [record()] });
  const result = await store.commit({ connectorId: "connector-jira", records: [record()] });

  assert.equal(result.committedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.history("connector-jira").length, 2);
});

test("the same idempotency key with different content fails explicitly", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({ connectorId: "connector-jira", records: [record()] });

  await assert.rejects(
    () => store.commit({
      connectorId: "connector-jira",
      records: [record({ payload: { summary: "Different sanitized content" } })],
    }),
    (error: unknown) => {
      assert.ok(error instanceof DuplicateEvidenceConflictError);
      assert.match((error as Error).message, /already exists with different content/);
      assert.doesNotMatch((error as Error).message, /Different sanitized content/);
      return true;
    },
  );
  assert.equal(store.listRecords().length, 1);
});

test("a batch conflict rolls back the whole commit, including valid siblings and the checkpoint", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record()],
    checkpoint: { cursor: "STT-1234" },
  });

  await assert.rejects(() => store.commit({
    connectorId: "connector-jira",
    records: [
      record({ sourceId: "STT-9999", payload: { summary: "A brand new sanitized story" } }),
      record({ payload: { summary: "Conflicting content for STT-1234" } }),
    ],
    checkpoint: { cursor: "STT-9999" },
  }));

  assert.equal(store.listRecords().length, 1);
  assert.equal(store.getRecord("jira:STT-9999:3"), undefined);
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
});

test("rejects records outside the store's tenant/product scope", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });

  await assert.rejects(
    () => store.commit({
      connectorId: "connector-jira",
      records: [record({ productId: "other-product" })],
    }),
    RawEvidenceScopeError,
  );
  assert.equal(store.listRecords().length, 0);
});

test("isolates records and checkpoints by connectorId within the same tenant/product scope", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record()],
    checkpoint: { cursor: "jira-cursor" },
  });
  await store.commit({
    connectorId: "connector-github",
    records: [record({ source: "github", sourceId: "42", idempotencyKey: "github:42:1" })],
    checkpoint: { cursor: "github-cursor" },
  });

  assert.equal(store.listRecords({ connectorId: "connector-jira" }).length, 1);
  assert.equal(store.listRecords({ connectorId: "connector-github" }).length, 1);
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "jira-cursor" });
  assert.deepEqual(store.getCheckpoint("connector-github"), { cursor: "github-cursor" });
});

test("clears a checkpoint when the caller commits an explicit null checkpoint", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record()],
    checkpoint: { cursor: "STT-1234" },
  });
  const result = await store.commit({
    connectorId: "connector-jira",
    records: [],
    checkpoint: null,
  });

  assert.equal(result.checkpointAdvanced, true);
  assert.equal(result.checkpoint, null);
  assert.equal(store.getCheckpoint("connector-jira"), undefined);
});

test("leaves the checkpoint untouched when the caller omits it", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record()],
    checkpoint: { cursor: "STT-1234" },
  });
  const result = await store.commit({
    connectorId: "connector-jira",
    records: [record({ sourceId: "STT-5555" })],
  });

  assert.equal(result.checkpointAdvanced, false);
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });
});

test("a replay with the same key/content but a different observedAt is a duplicate, and the checkpoint still advances", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record({ observedAt: "2026-09-10T00:00:00.000Z" })],
    checkpoint: { cursor: "STT-1234-page-1" },
  });

  // A resumed page or periodic re-sync replays the same source identity,
  // version, payload, hash, classification, contentType, and source URL, but
  // is naturally observed at a later wall-clock time. That must still count
  // as a duplicate (not a conflict), and an accompanying checkpoint update
  // must still advance.
  const result = await store.commit({
    connectorId: "connector-jira",
    records: [record({ observedAt: "2026-09-11T00:00:00.000Z" })],
    checkpoint: { cursor: "STT-1234-page-2" },
  });

  assert.equal(result.committedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.checkpointAdvanced, true);
  assert.deepEqual(result.checkpoint, { cursor: "STT-1234-page-2" });
  assert.equal(store.listRecords().length, 1);
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234-page-2" });
});

test("a replay with the same key but changed immutable identity (source, sourceId, sourceVersion, payload, contentHash, classification, contentType, or sourceUrl) still conflicts even with a different observedAt", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  const base = record({
    idempotencyKey: "fixed-key",
    sourceUrl: "https://jira.example.com/browse/STT-1234",
    observedAt: "2026-09-10T00:00:00.000Z",
  });
  await store.commit({ connectorId: "connector-jira", records: [base] });

  const mutations: Array<Partial<RawEvidenceRecord>> = [
    { sourceVersion: "4" },
    { payload: { summary: "Different sanitized content" } },
    { contentHash: "hash-different" },
    { classification: "confidential" },
    { contentType: "application/xml" },
    { sourceUrl: "https://jira.example.com/browse/STT-9999" },
  ];

  for (const mutation of mutations) {
    await assert.rejects(
      () => store.commit({
        connectorId: "connector-jira",
        records: [record({
          ...base,
          ...mutation,
          idempotencyKey: "fixed-key",
          observedAt: "2026-09-12T00:00:00.000Z",
        })],
      }),
      DuplicateEvidenceConflictError,
    );
  }
  assert.equal(store.listRecords().length, 1);
});

test("accepts canonical dot-separated plugin connectorIds such as connector.jira, connector.github, and connector.testrail", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });

  for (const connectorId of ["connector.jira", "connector.github", "connector.testrail"]) {
    const result = await store.commit({
      connectorId,
      records: [record({ source: connectorId, sourceId: `${connectorId}-1`, idempotencyKey: `${connectorId}:1` })],
      checkpoint: { cursor: "1" },
    });
    assert.equal(result.committedCount, 1);
    assert.deepEqual(store.getCheckpoint(connectorId), { cursor: "1" });
  }
});

test("rejects path-traversal and otherwise invalid connectorIds", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });

  const invalidConnectorIds = [
    "../connector.jira",
    "../../etc/passwd",
    "connector/../jira",
    "connector.jira/../other",
    "connector..jira",
    ".connector.jira",
    "connector.jira.",
    "connector jira",
    "connector\\jira",
    "",
  ];

  for (const connectorId of invalidConnectorIds) {
    await assert.rejects(
      () => store.commit({ connectorId, records: [record()] }),
      TypeError,
    );
  }
  assert.equal(store.listRecords().length, 0);
});

test("a non-cloneable checkpoint (DataCloneError) rolls back the whole commit, including otherwise-valid records", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  const uncloneable: Record<string, unknown> = { cursor: "STT-1234" };
  // Functions are not structured-cloneable; `structuredClone` throws
  // `DataCloneError` for them. This must be detected and rejected *before*
  // any record/checkpoint mutation, not after some records already landed.
  uncloneable.notCloneable = () => {};

  await assert.rejects(
    () => store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: uncloneable as never,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error).name, "DataCloneError");
      return true;
    },
  );

  assert.equal(store.listRecords().length, 0);
  assert.equal(store.getCheckpoint("connector-jira"), undefined);
  assert.equal(store.history("connector-jira").length, 0);
});

test("a clock that throws rolls back the whole commit, including otherwise-valid records and checkpoint", async () => {
  const store = new InMemoryRawEvidenceStore({
    tenantId: "solera",
    productId: "fl-titling",
    now: () => {
      throw new Error("clock unavailable");
    },
  });

  await assert.rejects(
    () => store.commit({
      connectorId: "connector-jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    }),
    /clock unavailable/,
  );

  assert.equal(store.listRecords().length, 0);
  assert.equal(store.getCheckpoint("connector-jira"), undefined);
  assert.equal(store.history("connector-jira").length, 0);
});

test("evaluates the checkpoint clone and clock before mutating, so a later validation failure in the same batch still leaves an unrelated non-cloneable checkpoint irrelevant", async () => {
  // Sanity check for ordering: a batch that fails on an earlier, ordinary
  // validation error (a same-key conflict) must still reject before ever
  // reaching checkpoint cloning/clock evaluation, and must never mutate.
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({ connectorId: "connector-jira", records: [record()] });

  const uncloneable: Record<string, unknown> = { cursor: "x", notCloneable: () => {} };
  await assert.rejects(() => store.commit({
    connectorId: "connector-jira",
    records: [record({ payload: { summary: "Different sanitized content" } })],
    checkpoint: uncloneable as never,
  }));

  assert.equal(store.listRecords().length, 1);
  assert.equal(store.getCheckpoint("connector-jira"), undefined);
});

test("returns immutable copies on read: mutating a result never mutates the store", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector-jira",
    records: [record()],
    checkpoint: { cursor: "STT-1234" },
  });

  const records = store.listRecords();
  (records[0].payload as Record<string, unknown>).summary = "tampered by a caller";
  assert.equal(
    (store.listRecords()[0].payload as Record<string, unknown>).summary,
    "A sanitized fixture requirement",
  );

  const checkpoint = store.getCheckpoint("connector-jira")!;
  (checkpoint as Record<string, unknown>).cursor = "tampered";
  assert.deepEqual(store.getCheckpoint("connector-jira"), { cursor: "STT-1234" });

  const history = store.history();
  (history[0] as unknown as Record<string, unknown>).operation = "tampered";
  assert.equal(store.history()[0].operation, "commit");
});

test("sourceInventory aggregates counts, freshness, and connectors per source without payloads", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  await store.commit({
    connectorId: "connector.jira",
    records: [
      record({ sourceId: "STT-1", observedAt: "2026-09-10T00:00:00.000Z", idempotencyKey: "jira:1" }),
      record({ sourceId: "STT-2", observedAt: "2026-09-12T00:00:00.000Z", idempotencyKey: "jira:2" }),
    ],
  });
  await store.commit({
    connectorId: "connector.github",
    records: [
      record({
        source: "github",
        sourceId: "42",
        observedAt: "2026-09-11T00:00:00.000Z",
        idempotencyKey: "github:42",
      }),
    ],
  });

  const inventory = store.sourceInventory();
  assert.deepEqual(
    inventory.map((entry) => entry.source),
    ["github", "jira"],
  );
  const jira = inventory.find((entry) => entry.source === "jira")!;
  assert.equal(jira.recordCount, 2);
  assert.equal(jira.firstObservedAt, "2026-09-10T00:00:00.000Z");
  assert.equal(jira.lastObservedAt, "2026-09-12T00:00:00.000Z");
  assert.deepEqual(jira.connectorIds, ["connector.jira"]);

  const github = inventory.find((entry) => entry.source === "github")!;
  assert.equal(github.recordCount, 1);
  assert.equal(github.lastObservedAt, "2026-09-11T00:00:00.000Z");
});

test("sourceInventory returns an empty array for an empty store", () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  assert.deepEqual(store.sourceInventory(), []);
});
