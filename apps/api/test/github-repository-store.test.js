import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createPersistentGitHubRepositoryStore
} from "../src/github-repository-store.js";

test("persists repository operational state without credentials and serializes updates", async () => {
  const directory = join(
    process.cwd(),
    "apps",
    "api",
    `.test-github-repositories-${randomUUID()}`
  );
  try {
    const store = createPersistentGitHubRepositoryStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling"
    });
    await Promise.all([
      store.transact((snapshot) => {
        snapshot.legacyMigrated = true;
        snapshot.repositories.push({
          id: "application",
          repository: "owner/application",
          url: "https://github.com/owner/application",
          purpose: "application",
          lifecycle: "active",
          enabled: true,
          validationStatus: "valid",
          syncStatus: "idle",
          lastValidatedAt: "2026-09-15T10:00:00.000Z",
          lastSyncAt: null,
          lastSuccessfulSyncAt: null,
          recordsCollected: 0,
          error: null
        });
      }),
      store.transact((snapshot) => {
        snapshot.legacyMigrated = true;
        snapshot.repositories.push({
          id: "automation",
          repository: "owner/automation",
          url: "https://github.com/owner/automation",
          purpose: "test-automation",
          lifecycle: "active",
          enabled: true,
          validationStatus: "pending",
          syncStatus: "succeeded",
          lastValidatedAt: null,
          lastSyncAt: "2026-09-15T10:01:00.000Z",
          lastSuccessfulSyncAt: "2026-09-15T10:02:00.000Z",
          recordsCollected: 12,
          error: null
        });
      })
    ]);

    const restarted = createPersistentGitHubRepositoryStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling"
    });
    const snapshot = restarted.read();
    assert.equal(snapshot.repositories.length, 2);
    assert.equal(snapshot.revision, 2);
    const serialized = await readFile(restarted.storagePath, "utf8");
    assert.ok(!serialized.includes("synthetic-token"));
    assert.ok(!serialized.toLowerCase().includes("credential"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
