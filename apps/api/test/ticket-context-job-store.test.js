import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptEnvelope } from "@tkl/credential-vault";
import {
  InMemoryTicketContextJobStore,
  createPersistentTicketContextJobStore
} from "../src/ticket-context-job-store.js";

const ROOT = join("apps", "api", ".test-data", "context-jobs");

function testDirectory() {
  mkdirSync(ROOT, { recursive: true });
  return join(ROOT, randomUUID());
}

test("persists encrypted ticket jobs atomically and reloads them after restart", async (t) => {
  const directory = testDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const options = {
    dataDirectory: directory,
    tenantId: "solera",
    resolveKey: async () => key
  };
  const first = createPersistentTicketContextJobStore(options);
  await first.initialize();
  await first.transact((snapshot) => {
    snapshot.jobs.push({
      productId: "fl-titling",
      issueKey: "STT-3731",
      state: "pending",
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
      queuedAt: "2026-09-15T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      attemptCount: 0,
      nextRetryAt: null,
      force: false,
      sources: Object.fromEntries(["jira", "testrail", "github"].map((source) => [
        source,
        {
          state: source === "jira" ? "local" : "pending",
          startedAt: null,
          completedAt: null,
          attemptCount: 0,
          recordsCollected: 0,
          truncated: false,
          error: null
        }
      ])),
      completeness: {
        status: "pending",
        complete: false,
        reasons: ["secondary_enrichment_pending"]
      }
    });
  });

  const serialized = readFileSync(first.storagePath, "utf8");
  assert.doesNotMatch(serialized, /STT-3731|fl-titling/);
  assert.match(serialized, /"ciphertext"/);

  const second = createPersistentTicketContextJobStore(options);
  await second.initialize();
  const snapshot = await second.read();
  assert.equal(snapshot.jobs[0].issueKey, "STT-3731");
});

test("rejects a snapshot when a different encryption key is supplied", async (t) => {
  const directory = testDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createPersistentTicketContextJobStore({
    dataDirectory: directory,
    tenantId: "solera",
    resolveKey: async () => randomBytes(32)
  });
  await first.initialize();
  await first.transact(() => {});

  const second = createPersistentTicketContextJobStore({
    dataDirectory: directory,
    tenantId: "solera",
    resolveKey: async () => randomBytes(32)
  });
  await assert.rejects(() => second.initialize(), /integrity verification/);
});

test("rejects credential or payload fields from operational metadata", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  await assert.rejects(
    () => store.transact((snapshot) => {
      snapshot.jobs.push({
        productId: "fl-titling",
        issueKey: "STT-1",
        credential: "must-not-be-stored"
      });
    }),
    /invalid operational metadata/
  );
});

test("migrates an encrypted schema-one snapshot without losing P4 jobs", async (t) => {
  const directory = testDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const store = createPersistentTicketContextJobStore({
    dataDirectory: directory,
    tenantId: "solera",
    resolveKey: async () => key
  });
  const legacySnapshot = {
    schemaVersion: 1,
    revision: 7,
    tenantId: "solera",
    jobs: [{
      productId: "fl-titling",
      issueKey: "STT-42",
      state: "complete",
      createdAt: "2026-09-14T10:00:00.000Z",
      updatedAt: "2026-09-14T10:01:00.000Z",
      queuedAt: "2026-09-14T10:00:00.000Z",
      startedAt: "2026-09-14T10:00:01.000Z",
      completedAt: "2026-09-14T10:01:00.000Z",
      cancelledAt: null,
      attemptCount: 1,
      nextRetryAt: null,
      force: false,
      sources: Object.fromEntries(["jira", "testrail", "github"].map((source) => [
        source,
        {
          state: source === "jira" ? "local" : "complete",
          startedAt: "2026-09-14T10:00:01.000Z",
          completedAt: "2026-09-14T10:01:00.000Z",
          attemptCount: 1,
          recordsCollected: 1,
          truncated: false,
          error: null
        }
      ])),
      completeness: { status: "complete", complete: true, reasons: [] }
    }]
  };
  writeFileSync(store.storagePath, `${JSON.stringify(encryptEnvelope(legacySnapshot, key, {
    tenantId: "solera",
    productId: "ticket-context-jobs",
    schemaVersion: 1,
    keyRef: "env://TKL_CONTEXT_JOB_KEY"
  }))}\n`);

  await store.initialize();
  const migrated = await store.read();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.jobs[0].issueKey, "STT-42");
  assert.equal(migrated.jobs[0].retryCount, 0);
  assert.equal(migrated.jobs[0].invalidation.generation, 0);
  assert.deepEqual(migrated.receipts, []);
  assert.equal(JSON.parse(readFileSync(store.storagePath, "utf8")).schemaVersion, 2);
});
