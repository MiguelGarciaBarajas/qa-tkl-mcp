import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEntity, Claim, ConflictRecord, TraceLink } from "@tkl/contracts";
import { PersistentKnowledgeStore } from "./persistent-store.ts";

function provenance() {
  return {
    source: "jira",
    sourceId: "STT-1234",
    sourceVersion: "3",
    contentHash: "hash-abc",
    observedAt: "2026-09-10T00:00:00.000Z",
    normalizerId: "jira-normalizer",
    normalizerVersion: "0.1.0",
  };
}

function requirement(): CanonicalEntity {
  return {
    id: "requirement:STT-1234",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "A persisted requirement",
    provenance: provenance(),
  };
}

function automatedTest(): CanonicalEntity {
  return {
    id: "test:github:4321",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "A persisted automated test",
    provenance: provenance(),
  };
}

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tkl-knowledge-store-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("persists scoped knowledge and immutable operation history across restarts", () => {
  withTemporaryDirectory((directory) => {
    const first = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      now: () => "2026-09-15T12:00:00.000Z",
    });
    const entity = requirement();
    const testEntity = automatedTest();
    const claim: Claim = {
      id: "claim:requirement:STT-1234:title",
      entityId: entity.id,
      attribute: "title",
      value: entity.title,
      origin: "explicit",
      confidence: 1,
      status: "approved",
      provenance: provenance(),
    };
    const link: TraceLink = {
      id: "link:test:4321:requirement:STT-1234",
      fromEntityId: testEntity.id,
      toEntityId: entity.id,
      type: "verifies",
      origin: "explicit",
      confidence: 1,
      provenance: provenance(),
    };
    const conflict: ConflictRecord = {
      id: "conflict:requirement:STT-1234:title",
      entityId: entity.id,
      claimIds: [claim.id],
      reason: "Sanitized fixture conflict",
      detectedAt: "2026-09-15T12:00:00.000Z",
      status: "open",
    };

    first.upsert({ entities: [entity, testEntity], claims: [claim], traceLinks: [link] });
    first.addConflict(conflict);
    const review = first.reviewConflict({
      conflictId: conflict.id,
      approvedClaimIds: [claim.id],
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-15T12:30:00.000Z",
      note: "Accepted the explicit TestRail value.",
    });

    const restarted = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.deepEqual(restarted.getEntity(entity.id), entity);
    assert.deepEqual(restarted.getApprovedClaims(entity.id), [claim]);
    assert.deepEqual(restarted.getTraceLinks(entity.id), [link]);
    assert.deepEqual(restarted.listOpenConflicts(entity.id), []);
    assert.deepEqual(restarted.listReviews(entity.id), [review]);
    assert.deepEqual(restarted.history(), [
      {
        id: "history:1",
        operation: "upsert",
        recordedAt: "2026-09-15T12:00:00.000Z",
      },
      {
        id: "history:2",
        operation: "add-conflict",
        recordedAt: "2026-09-15T12:00:00.000Z",
      },
      {
        id: "history:3",
        operation: "review-conflict",
        recordedAt: "2026-09-15T12:00:00.000Z",
      },
    ]);
  });
});

test("physically isolates tenant and product snapshots", () => {
  withTemporaryDirectory((directory) => {
    const flStore = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const otherStore = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "other-product",
    });

    flStore.addEntity(requirement());

    assert.notEqual(flStore.storagePath, otherStore.storagePath);
    assert.equal(otherStore.getEntity("requirement:STT-1234"), undefined);
    assert.throws(
      () => otherStore.addEntity(requirement()),
      /does not belong to store scope solera\/other-product/,
    );
  });
});

test("rolls back an invalid batch without replacing the durable snapshot", () => {
  withTemporaryDirectory((directory) => {
    const store = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    const before = readFileSync(store.storagePath, "utf-8");

    assert.throws(
      () => store.upsert({
        entities: [automatedTest()],
        traceLinks: [{
          id: "link:missing-endpoint",
          fromEntityId: "test:github:4321",
          toEntityId: "requirement:STT-9999",
          type: "verifies",
          origin: "explicit",
          confidence: 1,
          provenance: provenance(),
        }],
      }),
      /requires both endpoint entities/,
    );

    assert.equal(store.getEntity("test:github:4321"), undefined);
    assert.equal(readFileSync(store.storagePath, "utf-8"), before);
    const restarted = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.equal(restarted.getEntity("test:github:4321"), undefined);
    assert.deepEqual(restarted.history().map((entry) => entry.operation), ["add-entity"]);
  });
});

test("migrates a schema-zero snapshot and preserves its canonical records", () => {
  withTemporaryDirectory((directory) => {
    const scopeDirectory = join(directory, "solera", "fl-titling");
    const seed = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    seed.addEntity(requirement());
    const snapshot = JSON.parse(readFileSync(seed.storagePath, "utf-8")) as Record<string, unknown>;
    snapshot.schemaVersion = 0;
    delete snapshot.history;
    writeFileSync(join(scopeDirectory, "knowledge-store.json"), JSON.stringify(snapshot), "utf-8");

    const migrated = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const persisted = JSON.parse(readFileSync(migrated.storagePath, "utf-8")) as {
      schemaVersion: number;
      history: unknown[];
    };

    assert.equal(migrated.getEntity("requirement:STT-1234")?.title, "A persisted requirement");
    assert.equal(persisted.schemaVersion, 3);
    assert.deepEqual(persisted.history, []);
  });
});

test("rejects newer schemas instead of silently discarding unknown data", () => {
  withTemporaryDirectory((directory) => {
    const seed = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    seed.addEntity(requirement());
    const snapshot = JSON.parse(readFileSync(seed.storagePath, "utf-8")) as Record<string, unknown>;
    snapshot.schemaVersion = 4;
    writeFileSync(seed.storagePath, JSON.stringify(snapshot), "utf-8");

    assert.throws(
      () => new PersistentKnowledgeStore({
        dataDirectory: directory,
        tenantId: "solera",
        productId: "fl-titling",
      }),
      /schema 4 is newer than supported schema 3/,
    );
  });
});

test("migrates schema-one snapshots with an empty review history", () => {
  withTemporaryDirectory((directory) => {
    const seed = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    seed.addEntity(requirement());
    const snapshot = JSON.parse(readFileSync(seed.storagePath, "utf-8")) as Record<string, unknown>;
    snapshot.schemaVersion = 1;
    delete snapshot.reviews;
    writeFileSync(seed.storagePath, JSON.stringify(snapshot), "utf-8");

    const migrated = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const persisted = JSON.parse(readFileSync(migrated.storagePath, "utf-8")) as {
      schemaVersion: number;
      reviews: unknown[];
    };

    assert.equal(persisted.schemaVersion, 3);
    assert.deepEqual(persisted.reviews, []);
    assert.deepEqual(migrated.listReviews(), []);
  });
});

test("rejects stale writers instead of overwriting a newer review decision", () => {
  withTemporaryDirectory((directory) => {
    const seed = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    seed.addEntity(requirement());

    const firstWriter = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const staleWriter = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    firstWriter.addClaim({
      id: "claim:requirement:STT-1234:title",
      entityId: "requirement:STT-1234",
      attribute: "title",
      value: "Approved title",
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: provenance(),
    });

    assert.throws(
      () => staleWriter.addClaim({
        id: "claim:requirement:STT-1234:description",
        entityId: "requirement:STT-1234",
        attribute: "description",
        value: "Stale update",
        origin: "explicit",
        confidence: 1,
        status: "pending",
        provenance: provenance(),
      }),
      /revision changed/,
    );

    const restarted = new PersistentKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.deepEqual(
      restarted.getClaims("requirement:STT-1234").map((claim) => claim.attribute),
      ["title"],
    );
  });
});
