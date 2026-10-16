import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RawEvidenceRecord } from "@tkl/contracts";

// This file intentionally imports the *package entry point* (the bare
// `@tkl/raw-evidence-store` specifier resolved through package.json
// `exports`), not a relative `./store.ts` path. The package ships a thin
// `src/index.js` that re-exports the `.ts` sources; that file previously
// referenced nonexistent `./store.js`/`./crypto.js`/`./persistent-store.js`
// modules, so any real consumer importing this package by name would fail at
// runtime even though every in-package relative import and `--check` passed.
// This test exercises the actual published entry point end to end so that
// regression is caught by `npm test`/`npm run build`.
import {
  createPersistentRawEvidenceStore,
  InMemoryRawEvidenceStore,
} from "@tkl/raw-evidence-store";

function withTemporaryDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "tkl-raw-evidence-store-entry-"));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

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

test("the package entry point exports a working InMemoryRawEvidenceStore", async () => {
  const store = new InMemoryRawEvidenceStore({ tenantId: "solera", productId: "fl-titling" });
  const result = await store.commit({
    connectorId: "connector.jira",
    records: [record()],
    checkpoint: { cursor: "STT-1234" },
  });

  assert.equal(result.committedCount, 1);
  assert.equal(store.listRecords().length, 1);
  assert.deepEqual(store.getCheckpoint("connector.jira"), { cursor: "STT-1234" });
});

test("the package entry point exports a working createPersistentRawEvidenceStore that commits durably and resumes after restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const resolveKey = () => key;

    const store = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: "secret://raw-evidence/fl-titling",
      resolveKey,
    });
    await store.commit({
      connectorId: "connector.jira",
      records: [record()],
      checkpoint: { cursor: "STT-1234" },
    });

    const restarted = await createPersistentRawEvidenceStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: "secret://raw-evidence/fl-titling",
      resolveKey,
    });
    assert.equal(restarted.listRecords().length, 1);
    assert.deepEqual(restarted.getCheckpoint("connector.jira"), { cursor: "STT-1234" });
  }));
