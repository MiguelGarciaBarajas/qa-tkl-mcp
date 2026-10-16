import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CanonicalEntity,
  Claim,
  ConflictRecord,
  TraceLink,
} from "@tkl/contracts";
import { SqliteKnowledgeStore } from "./relational-store.ts";

function provenance(sourceId = "STT-1234") {
  return {
    source: "jira",
    sourceId,
    sourceVersion: "3",
    contentHash: `hash-${sourceId}`,
    observedAt: "2026-09-10T00:00:00.000Z",
    normalizerId: "jira-normalizer",
    normalizerVersion: "0.1.0",
  };
}

function requirement(
  id = "requirement:STT-1234",
  title = "A persisted requirement",
): CanonicalEntity {
  return {
    id,
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title,
    provenance: provenance(id.slice(id.lastIndexOf(":") + 1)),
  };
}

function automatedTest(): CanonicalEntity {
  return {
    id: "test:github:4321",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "A persisted automated test",
    provenance: { ...provenance("4321"), source: "github" },
  };
}

function titleClaim(status: Claim["status"] = "pending"): Claim {
  return {
    id: "claim:requirement:STT-1234:title",
    entityId: "requirement:STT-1234",
    attribute: "title",
    value: "A persisted requirement",
    origin: "explicit",
    confidence: 1,
    status,
    provenance: provenance(),
  };
}

function claimVersionKey(claim: Claim): string {
  return createHash("sha256")
    .update(JSON.stringify({
      entityId: claim.entityId,
      attribute: claim.attribute,
      value: claim.value,
      origin: claim.origin,
      confidence: claim.confidence,
      provenance: claim.provenance,
    }))
    .digest("hex")
    .slice(0, 16);
}

function traceLink(toEntityId = "requirement:STT-1234"): TraceLink {
  return {
    id: `link:test:4321:${toEntityId}`,
    fromEntityId: "test:github:4321",
    toEntityId,
    type: "verifies",
    origin: "explicit",
    confidence: 1,
    provenance: { ...provenance("4321"), source: "github" },
  };
}

function withStoreDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(process.cwd(), ".tkl-sqlite-store-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("transactionally migrates a schema-v3 JSON snapshot exactly once", () => {
  withStoreDirectory((directory) => {
    let first: SqliteKnowledgeStore | undefined;
    let reopened: SqliteKnowledgeStore | undefined;
    let database: DatabaseSync | undefined;
    try {
    const legacyDirectory = join(directory, "solera", "fl-titling");
    const legacyPath = join(legacyDirectory, "knowledge-store.json");
    mkdirSync(legacyDirectory, { recursive: true });
    const entity = requirement();
    const testEntity = automatedTest();
    const claim = titleClaim("approved");
    const link = traceLink();
    const deferred = traceLink("requirement:STT-9999");
    const conflict: ConflictRecord = {
      id: "conflict:requirement:STT-1234:title",
      entityId: entity.id,
      claimIds: [claim.id],
      reason: "Reviewed legacy conflict",
      detectedAt: "2026-09-15T12:00:00.000Z",
      status: "reviewed",
    };
    const legacySnapshot = {
      schemaVersion: 3,
      revision: 7,
      tenantId: "solera",
      productId: "fl-titling",
      entities: [entity, testEntity],
      claims: [claim],
      traceLinks: [link],
      deferredTraceLinks: [deferred],
      conflicts: [conflict],
      reviews: [{
        id: "review:legacy",
        entityId: entity.id,
        targetType: "conflict",
        targetId: conflict.id,
        decision: "resolved",
        approvedClaimIds: [claim.id],
        reviewerId: "qa-lead",
        reviewedAt: "2026-09-15T12:30:00.000Z",
      }],
      history: [{
        id: "history:1",
        operation: "upsert",
        recordedAt: "2026-09-15T12:00:00.000Z",
      }],
    };
    const originalLegacyContent = `${JSON.stringify(legacySnapshot, null, 2)}\n`;
    writeFileSync(legacyPath, originalLegacyContent, "utf-8");

    first = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.deepEqual(first.getEntity(entity.id), entity);
    assert.deepEqual(first.getApprovedClaims(entity.id), [claim]);
    assert.deepEqual(first.getTraceLinks(entity.id), [link]);
    assert.deepEqual(first.listOpenConflicts(entity.id), []);
    assert.equal(first.listReviews(entity.id).length, 1);
    assert.deepEqual(first.history(), legacySnapshot.history);
    assert.equal(readFileSync(legacyPath, "utf-8"), originalLegacyContent);
    first.close();

    writeFileSync(
      legacyPath,
      JSON.stringify({
        ...legacySnapshot,
        entities: [...legacySnapshot.entities, requirement("requirement:STT-9999", "Late legacy edit")],
      }),
      "utf-8",
    );
    reopened = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.equal(reopened.getEntity("requirement:STT-9999"), undefined);
    assert.deepEqual(reopened.history(), legacySnapshot.history);
    reopened.close();

    database = new DatabaseSync(join(directory, "knowledge-store.sqlite"));
    const markerCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM store_metadata
      WHERE tenant_id = 'solera'
        AND product_id = 'fl-titling'
        AND key = 'legacy-json-v3-migration'
    `).get() as { count: number };
    assert.equal(Number(markerCount.count), 1);
    const migratedClaim = database.prepare(`
      SELECT base_id AS baseId
      FROM claims
      WHERE tenant_id = 'solera'
        AND product_id = 'fl-titling'
        AND id = ?
    `).get(claim.id) as { baseId: string };
    assert.equal(migratedClaim.baseId, claim.id);
    database.close();
    database = undefined;
    } finally {
      first?.close();
      reopened?.close();
      database?.close();
    }
  });
});

test("migrates legacy claim rows to an indexed stable base ID", () => {
  withStoreDirectory((directory) => {
    const databasePath = join(directory, "knowledge-store.sqlite");
    const database = new DatabaseSync(databasePath);
    const entity = requirement();
    const original = titleClaim("approved");
    const revised: Claim = {
      ...original,
      value: "A revised legacy title",
      status: "pending",
      provenance: {
        ...provenance(),
        sourceVersion: "4",
        contentHash: "hash-v4",
      },
    };
    const revisedId = `${original.id}@${claimVersionKey(revised)}`;
    const revisedStored = { ...revised, id: revisedId };
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE entities (
        tenant_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        sequence INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, product_id, id),
        UNIQUE (tenant_id, product_id, sequence)
      ) STRICT;
      CREATE TABLE claims (
        tenant_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        origin TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        version_key TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        sequence INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, product_id, id),
        UNIQUE (tenant_id, product_id, sequence),
        FOREIGN KEY (tenant_id, product_id, entity_id)
          REFERENCES entities(tenant_id, product_id, id)
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO entities(
        tenant_id, product_id, id, type, title, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entity.tenantId,
      entity.productId,
      entity.id,
      entity.type,
      entity.title,
      JSON.stringify(entity),
      1,
    );
    const insertClaim = database.prepare(`
      INSERT INTO claims(
        tenant_id, product_id, id, entity_id, attribute, value_json,
        origin, confidence, status, version_key, data_json, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [claim, sequence] of [[original, 1], [revisedStored, 2]] as const) {
      insertClaim.run(
        entity.tenantId,
        entity.productId,
        claim.id,
        claim.entityId,
        claim.attribute,
        JSON.stringify(claim.value),
        claim.origin,
        claim.confidence,
        claim.status,
        claimVersionKey(claim),
        JSON.stringify(claim),
        sequence,
      );
    }
    database.close();

    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });

    assert.deepEqual(
      store.getClaims(entity.id).map((claim) => claim.id),
      [original.id, revisedId],
    );
    store.addClaim(revised);
    assert.equal(store.getClaims(entity.id).length, 2);
    store.close();

    const migrated = new DatabaseSync(databasePath);
    const rows = migrated.prepare(`
      SELECT id, base_id AS baseId
      FROM claims
      WHERE tenant_id = ? AND product_id = ?
      ORDER BY sequence
    `).all("solera", "fl-titling") as Array<{ id: string; baseId: string }>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: original.id, baseId: original.id },
      { id: revisedId, baseId: original.id },
    ]);
    const plan = migrated.prepare(`
      EXPLAIN QUERY PLAN
      SELECT data_json
      FROM claims
      WHERE tenant_id = ? AND product_id = ? AND base_id = ?
      ORDER BY sequence
    `).all("solera", "fl-titling", original.id) as Array<{ detail: string }>;
    assert.equal(
      plan.some((step) => step.detail.includes("idx_claims_base_id")),
      true,
      JSON.stringify(plan),
    );
    const schemaVersion = migrated.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(schemaVersion.user_version, 3);
    migrated.close();
  });
});

test("recognizes historical status-inclusive claim IDs during JSON migration", () => {
  withStoreDirectory((directory) => {
    const scopeDirectory = join(directory, "solera", "fl-titling");
    mkdirSync(scopeDirectory, { recursive: true });
    const entity = requirement();
    const baseClaim = titleClaim("approved");
    const historicalVersionKey = createHash("sha256")
      .update(JSON.stringify({
        entityId: baseClaim.entityId,
        attribute: baseClaim.attribute,
        value: baseClaim.value,
        origin: baseClaim.origin,
        confidence: baseClaim.confidence,
        status: baseClaim.status,
        provenance: baseClaim.provenance,
      }))
      .digest("hex")
      .slice(0, 16);
    const historicalClaim = {
      ...baseClaim,
      id: `${baseClaim.id}@${historicalVersionKey}`,
    };
    writeFileSync(
      join(scopeDirectory, "knowledge-store.json"),
      JSON.stringify({
        schemaVersion: 3,
        revision: 1,
        tenantId: "solera",
        productId: "fl-titling",
        entities: [entity],
        claims: [historicalClaim],
        traceLinks: [],
        deferredTraceLinks: [],
        conflicts: [],
        reviews: [],
        history: [],
      }),
      "utf-8",
    );

    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    try {
      store.addClaim(baseClaim);
      assert.equal(store.getClaims(entity.id).length, 1);
      assert.equal(store.getClaims(entity.id)[0].id, historicalClaim.id);
    } finally {
      store.close();
    }
  });
});

test("preserves duplicate legacy base claim IDs as distinct versions", () => {
  withStoreDirectory((directory) => {
    const scopeDirectory = join(directory, "solera", "fl-titling");
    mkdirSync(scopeDirectory, { recursive: true });
    const entity = requirement();
    const original = titleClaim();
    const revised = {
      ...original,
      value: "A revised persisted requirement",
      provenance: {
        ...original.provenance,
        sourceVersion: "2",
        contentHash: "revised-title",
      },
    };
    writeFileSync(
      join(scopeDirectory, "knowledge-store.json"),
      JSON.stringify({
        schemaVersion: 3,
        revision: 2,
        tenantId: "solera",
        productId: "fl-titling",
        entities: [entity],
        claims: [original, revised],
        traceLinks: [],
        deferredTraceLinks: [],
        conflicts: [],
        reviews: [],
        history: [],
      }),
      "utf-8",
    );

    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    try {
      const claims = store.getClaims(entity.id);
      assert.equal(claims.length, 2);
      assert.deepEqual(
        claims.map((claim) => claim.value),
        [original.value, revised.value],
      );
      assert.equal(claims[0].id, original.id);
      assert.equal(claims[1].id, `${original.id}@${claimVersionKey(revised)}`);
    } finally {
      store.close();
    }
  });
});

test("rolls back an invalid batch and its operation history in one transaction", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    const historyBefore = store.history();
    const pendingBefore = store.pendingServingProjectionCount();

    assert.throws(
      () => store.upsert({
        entities: [automatedTest()],
        traceLinks: [traceLink("requirement:STT-9999")],
      }),
      /requires both endpoint entities/,
    );

    assert.equal(store.getEntity("test:github:4321"), undefined);
    assert.deepEqual(store.history(), historyBefore);
    assert.equal(store.pendingServingProjectionCount(), pendingBefore);
    store.close();

    const reopened = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.equal(reopened.getEntity("test:github:4321"), undefined);
    assert.deepEqual(reopened.history(), historyBefore);
    reopened.close();
  });
});

test("rolls back a failed legacy migration without writing its durable marker", () => {
  withStoreDirectory((directory) => {
    const legacyDirectory = join(directory, "solera", "fl-titling");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, "knowledge-store.json"), JSON.stringify({
      schemaVersion: 3,
      revision: 2,
      tenantId: "solera",
      productId: "fl-titling",
      entities: [requirement(), automatedTest()],
      claims: [],
      traceLinks: [traceLink("requirement:STT-9999")],
      deferredTraceLinks: [],
      conflicts: [],
      reviews: [],
      history: [],
    }), "utf-8");

    assert.throws(
      () => new SqliteKnowledgeStore({
        dataDirectory: directory,
        tenantId: "solera",
        productId: "fl-titling",
      }),
      /requires both endpoint entities/,
    );

    const database = new DatabaseSync(join(directory, "knowledge-store.sqlite"));
    const entityCount = database.prepare("SELECT COUNT(*) AS count FROM entities").get() as {
      count: number;
    };
    const markerCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM store_metadata
      WHERE key = 'legacy-json-v3-migration'
    `).get() as { count: number };
    assert.equal(Number(entityCount.count), 0);
    assert.equal(Number(markerCount.count), 0);
    database.close();
  });
});

test("keeps conflict review updates atomic when a referenced claim is missing", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const claim = titleClaim();
    const conflict: ConflictRecord = {
      id: "conflict:requirement:STT-1234:title",
      entityId: claim.entityId,
      claimIds: [claim.id, "claim:missing"],
      reason: "Malformed imported conflict",
      detectedAt: "2026-09-15T12:00:00.000Z",
      status: "open",
    };
    store.addEntity(requirement());
    store.addClaim(claim);
    store.addConflict(conflict);
    const historyBefore = store.history();

    assert.throws(
      () => store.reviewConflict({
        conflictId: conflict.id,
        approvedClaimIds: [claim.id],
        reviewerId: "qa-lead",
        reviewedAt: "2026-09-15T12:30:00.000Z",
      }),
      /references missing or mismatched claim claim:missing/,
    );

    assert.deepEqual(store.getClaims(claim.entityId), [claim]);
    assert.deepEqual(store.listOpenConflicts(claim.entityId), [conflict]);
    assert.deepEqual(store.listReviews(claim.entityId), []);
    assert.deepEqual(store.history(), historyBefore);
    store.close();
  });
});

test("preserves claim versions, review status, and reviewed-conflict decisions", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    const original = titleClaim();
    store.addClaim(original);
    store.reviewClaim({
      claimId: original.id,
      decision: "approved",
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-15T12:30:00.000Z",
    });
    store.addClaim({ ...original });
    store.addClaim({
      ...original,
      value: "A revised title",
      provenance: { ...provenance(), sourceVersion: "4", contentHash: "hash-v4" },
    });
    const claims = store.getClaims(original.entityId);
    assert.equal(claims.length, 2);
    assert.deepEqual(claims.map((claim) => claim.status), ["approved", "pending"]);
    assert.notEqual(claims[0].id, claims[1].id);

    const conflict: ConflictRecord = {
      id: "conflict:requirement:STT-1234:title",
      entityId: original.entityId,
      claimIds: claims.map((claim) => claim.id),
      reason: "Choose a title",
      detectedAt: "2026-09-15T13:00:00.000Z",
      status: "open",
    };
    store.addConflict(conflict);
    store.reviewConflict({
      conflictId: conflict.id,
      approvedClaimIds: [claims[1].id],
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-15T13:30:00.000Z",
    });
    store.addConflict({
      ...conflict,
      reason: "Analyzer replay",
      detectedAt: "2026-09-15T14:00:00.000Z",
    });
    assert.deepEqual(store.listOpenConflicts(original.entityId), []);
    assert.deepEqual(
      store.getClaims(original.entityId).map((claim) => claim.status),
      ["rejected", "approved"],
    );
    store.close();
  });
});

test("small mutations never rewrite the migrated legacy JSON snapshot", () => {
  withStoreDirectory((directory) => {
    const legacyDirectory = join(directory, "solera", "fl-titling");
    const legacyPath = join(legacyDirectory, "knowledge-store.json");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyContent = JSON.stringify({
      schemaVersion: 3,
      revision: 1,
      tenantId: "solera",
      productId: "fl-titling",
      entities: [requirement()],
      claims: [],
      traceLinks: [],
      deferredTraceLinks: [],
      conflicts: [],
      reviews: [],
      history: [],
    });
    writeFileSync(legacyPath, legacyContent, "utf-8");

    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addClaim(titleClaim());
    assert.equal(readFileSync(legacyPath, "utf-8"), legacyContent);
    assert.equal(existsSync(join(directory, "knowledge-store.sqlite")), true);
    store.close();
  });
});

test("does not fall back to legacy JSON when the SQLite database is corrupt", () => {
  withStoreDirectory((directory) => {
    const legacyDirectory = join(directory, "solera", "fl-titling");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyContent = JSON.stringify({
      schemaVersion: 3,
      revision: 1,
      tenantId: "solera",
      productId: "fl-titling",
      entities: [requirement()],
      claims: [],
      traceLinks: [],
      deferredTraceLinks: [],
      conflicts: [],
      reviews: [],
      history: [],
    });
    const legacyPath = join(legacyDirectory, "knowledge-store.json");
    writeFileSync(legacyPath, legacyContent, "utf-8");
    writeFileSync(join(directory, "knowledge-store.sqlite"), "not a sqlite database", "utf-8");

    assert.throws(
      () => new SqliteKnowledgeStore({
        dataDirectory: directory,
        tenantId: "solera",
        productId: "fl-titling",
      }),
      /not a database|malformed/i,
    );
    assert.equal(readFileSync(legacyPath, "utf-8"), legacyContent);
  });
});

test("serializes independent writers and keeps tenant/product scopes isolated", () => {
  withStoreDirectory((directory) => {
    const first = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const second = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const otherProduct = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "other-product",
    });
    const otherTenant = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "another-tenant",
      productId: "fl-titling",
    });
    first.addEntity(requirement());
    second.addEntity(automatedTest());
    otherProduct.addEntity({
      ...requirement("requirement:OTHER-1", "Other product requirement"),
      productId: "other-product",
    });
    otherTenant.addEntity({
      ...requirement("requirement:STT-1234", "Another tenant requirement"),
      tenantId: "another-tenant",
    });
    first.drainServingProjections({ limit: 10 });
    otherProduct.drainServingProjections({ limit: 10 });
    otherTenant.drainServingProjections({ limit: 10 });

    assert.deepEqual(
      first.listEntities("fl-titling").map((entity) => entity.id),
      ["requirement:STT-1234", "test:github:4321"],
    );
    assert.deepEqual(first.listEntities("other-product"), []);
    assert.deepEqual(
      otherProduct.listEntities("other-product").map((entity) => entity.id),
      ["requirement:OTHER-1"],
    );
    assert.deepEqual(
      first.searchEntities({
        productId: "fl-titling",
        query: "another tenant",
        limit: 10,
      }),
      [],
    );
    assert.deepEqual(
      otherTenant.searchEntities({
        productId: "fl-titling",
        query: "another tenant",
        limit: 10,
      }).map((entity) => entity.id),
      ["requirement:STT-1234"],
    );
    assert.throws(
      () => otherProduct.addEntity(requirement()),
      /does not belong to store scope solera\/other-product/,
    );

    first.close();
    second.close();
    otherProduct.close();
    otherTenant.close();
  });
});

test("keeps projection outbox work durable across restart", () => {
  withStoreDirectory((directory) => {
    let store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    assert.equal(store.pendingServingProjectionCount(), 1);
    store.close();

    store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    assert.equal(store.pendingServingProjectionCount(), 1);
    assert.deepEqual(store.drainServingProjections({ limit: 1 }), {
      attempted: 1,
      projected: 1,
      remaining: 0,
      version: 1,
    });
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "persisted requirement",
        limit: 10,
      }).map((entity) => entity.id),
      ["requirement:STT-1234"],
    );
    store.close();
  });
});

test("rolls back failed projection updates and retries them after restart", () => {
  withStoreDirectory((directory) => {
    class FailingProjectionStore extends SqliteKnowledgeStore {
      failNextProjection = true;

      protected override projectServingEntity(entity: CanonicalEntity): void {
        if (this.failNextProjection) {
          this.failNextProjection = false;
          super.projectServingEntity(entity);
          throw new Error("injected projection failure");
        }
        super.projectServingEntity(entity);
      }
    }

    let store: SqliteKnowledgeStore = new FailingProjectionStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    assert.throws(
      () => store.drainServingProjections({ limit: 10 }),
      /injected projection failure/,
    );
    assert.equal(store.pendingServingProjectionCount(), 1);
    store.close();

    const database = new DatabaseSync(join(directory, "knowledge-store.sqlite"));
    const pending = database.prepare(`
      SELECT attempt_count AS attemptCount, last_error AS lastError
      FROM serving_projection_outbox
    `).get() as { attemptCount: number; lastError: string };
    const projected = database.prepare(`
      SELECT COUNT(*) AS count
      FROM serving_entity_search
    `).get() as { count: number };
    assert.equal(pending.attemptCount, 1);
    assert.match(pending.lastError, /injected projection failure/);
    assert.equal(Number(projected.count), 0);
    database.close();

    store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.drainServingProjections({ limit: 10 });
    assert.equal(store.pendingServingProjectionCount(), 0);
    assert.equal(
      store.searchEntities({
        productId: "fl-titling",
        query: "STT-1234",
        limit: 10,
      }).length,
      1,
    );
    store.close();
  });
});

test("deduplicates repeated projection work and drains only the requested batch", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    store.addEntity(requirement());
    store.addEntity(requirement("requirement:STT-2000", "Second requirement"));
    store.addEntity(requirement("requirement:STT-3000", "Third requirement"));
    assert.equal(store.pendingServingProjectionCount(), 3);

    const first = store.drainServingProjections({ limit: 2 });
    assert.deepEqual(first, {
      attempted: 2,
      projected: 2,
      remaining: 1,
      version: 1,
    });
    assert.equal(store.drainServingProjections({ limit: 2 }).remaining, 0);
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "requirement",
        limit: 10,
      }).map((entity) => entity.id),
      [
        "requirement:STT-1234",
        "requirement:STT-2000",
        "requirement:STT-3000",
      ],
    );
    assert.throws(
      () => store.drainServingProjections({ limit: 501 }),
      /Projection batch size/,
    );
    store.close();
  });
});

test("searches canonical tables directly while serving projections are pending", () => {
  withStoreDirectory((directory) => {
    class BoundedFallbackStore extends SqliteKnowledgeStore {
      override listEntities(): CanonicalEntity[] {
        throw new Error("canonical fallback must not materialize every entity");
      }
    }

    const store = new BoundedFallbackStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity({
      ...requirement(),
      metadata: { workflow: "Electronic lien release" },
    });
    store.addEntity(requirement("requirement:STT-2000", "Lien release automation"));
    store.addEntity(requirement("requirement:STT-5678", "Unrelated requirement"));
    store.addEntity(automatedTest());
    store.addTraceLink(traceLink());
    store.addTraceLink(traceLink("requirement:STT-5678"));
    store.addClaim({
      ...titleClaim(),
      id: "claim:requirement:STT-1234:acceptance",
      attribute: "acceptanceCriteria",
      value: "Clerk confirms the lien release",
    });

    try {
      assert.equal(store.pendingServingProjectionCount(), 4);
      for (const query of ["STT-1234", "persisted requirement", "clerk confirms"]) {
        assert.deepEqual(
          store.searchEntities({
            productId: "fl-titling",
            source: "jira",
            query,
            limit: 10,
          }).map((entity) => entity.id),
          ["requirement:STT-1234"],
        );
      }
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "STT-1234",
          limit: 10,
        }).map((entity) => entity.id),
        ["requirement:STT-1234", "test:github:4321"],
      );
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "workflow",
          limit: 10,
        }).map((entity) => entity.id),
        ["requirement:STT-1234"],
      );
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "tenantId",
          limit: 10,
        }),
        [],
      );
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "",
          limit: 1,
          offset: 1,
        }).map((entity) => entity.id),
        ["requirement:STT-2000"],
      );
    } finally {
      store.close();
    }
  });
});

test("reprojects old and new endpoints when a trace link changes", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const oldTarget = requirement("requirement:STT-2000", "Legacy workflow target");
    const newTarget = requirement("requirement:STT-3000", "Modern workflow target");
    store.addEntity(automatedTest());
    store.addEntity(oldTarget);
    store.addEntity(newTarget);
    store.addTraceLink({
      ...traceLink(oldTarget.id),
      id: "link:test:4321:mutable",
    });
    store.drainServingProjections({ limit: 10 });

    store.addTraceLink({
      ...traceLink(newTarget.id),
      id: "link:test:4321:mutable",
    });
    store.drainServingProjections({ limit: 10 });

    try {
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "STT-2000",
          limit: 10,
        }).map((entity) => entity.id),
        [oldTarget.id],
      );
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          query: "STT-3000",
          limit: 10,
        }).map((entity) => entity.id),
        [newTarget.id, "test:github:4321"],
      );
    } finally {
      store.close();
    }
  });
});

test("rebuilds serving projections from canonical tables in rerunnable batches", () => {
  withStoreDirectory((directory) => {
    let store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    store.addEntity(requirement());
    store.addEntity(requirement("requirement:STT-2000", "Second requirement"));
    store.drainServingProjections({ limit: 10 });
    store.close();

    const database = new DatabaseSync(join(directory, "knowledge-store.sqlite"));
    database.prepare(`
      UPDATE serving_entity_search
      SET searchable_text = 'corrupt projection', title = 'corrupt projection'
      WHERE entity_id = 'requirement:STT-1234'
    `).run();
    database.prepare(`
      DELETE FROM serving_entity_search
      WHERE entity_id = 'requirement:STT-2000'
    `).run();
    database.close();

    store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const first = store.rebuildServingProjections({ batchSize: 1, cursor: 0 });
    assert.equal(first.processed, 1);
    assert.equal(first.done, false);
    const second = store.rebuildServingProjections({
      batchSize: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.processed, 1);
    assert.equal(second.done, true);
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "requirement",
        limit: 10,
      }).map((entity) => entity.id),
      ["requirement:STT-1234", "requirement:STT-2000"],
    );

    const rerun = store.rebuildServingProjections({ batchSize: 10, cursor: 0 });
    assert.equal(rerun.processed, 2);
    assert.equal(rerun.done, true);
    assert.equal(rerun.remaining, 0);
    store.close();
  });
});

test("searches projected titles, canonical text, IDs, and source references deterministically", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const first = {
      ...requirement(),
      metadata: { workflow: "Electronic lien release" },
    };
    store.addEntity(first);
    store.addClaim({
      ...titleClaim(),
      id: "claim:requirement:STT-1234:acceptance",
      attribute: "acceptanceCriteria",
      value: "Clerk confirms the lien release",
    });
    store.addEntity(requirement("requirement:STT-2000", "Lien release automation"));
    store.drainServingProjections({ limit: 10 });

    for (const query of ["sisted require", "clerk confirms", "STT-1234"]) {
      assert.deepEqual(
        store.searchEntities({
          productId: "fl-titling",
          source: "jira",
          query,
          limit: 10,
        }).map((entity) => entity.id),
        ["requirement:STT-1234"],
      );
    }
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        source: "github",
        query: "requirement",
        limit: 10,
      }),
      [],
    );
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "lien release",
        limit: 10,
      }).map((entity) => entity.id),
      ["requirement:STT-2000", "requirement:STT-1234"],
    );
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "",
        limit: 1,
        offset: 1,
      }).map((entity) => entity.id),
      ["requirement:STT-2000"],
    );
    store.reviewClaim({
      claimId: "claim:requirement:STT-1234:acceptance",
      decision: "rejected",
      reviewerId: "qa-lead",
      reviewedAt: "2026-09-15T12:30:00.000Z",
    });
    store.drainServingProjections({ limit: 10 });
    assert.deepEqual(
      store.searchEntities({
        productId: "fl-titling",
        query: "clerk confirms",
        limit: 10,
      }),
      [],
    );
    assert.deepEqual(
      store.searchEntities({
        productId: "other-product",
        query: "",
        limit: 10,
      }),
      [],
    );
    store.close();
  });
});

test("inventorySummary reports bounded aggregate counts and coverage buckets", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });

    const mkRequirement = (id: string): CanonicalEntity => ({
      id,
      tenantId: "solera",
      productId: "fl-titling",
      type: "requirement",
      title: id,
      provenance: provenance(id),
    });
    const mkTest = (id: string, type: CanonicalEntity["type"], source: string): CanonicalEntity => ({
      id,
      tenantId: "solera",
      productId: "fl-titling",
      type,
      title: id,
      provenance: { ...provenance(id), source },
    });
    const verifies = (from: string, to: string, confidence = 0.9): TraceLink => ({
      id: `link:${from}:${to}`,
      fromEntityId: from,
      toEntityId: to,
      type: "verifies",
      origin: "explicit",
      confidence,
      provenance: provenance(`${from}:${to}`),
    });

    // R1: both manual and automation. R2: manual only. R3: neither.
    store.addEntity(mkRequirement("requirement:R1"));
    store.addEntity(mkRequirement("requirement:R2"));
    store.addEntity(mkRequirement("requirement:R3"));
    store.addEntity(mkTest("manual-test:M1", "manual-test", "testrail"));
    store.addEntity(mkTest("manual-test:M2", "manual-test", "testrail"));
    store.addEntity(mkTest("test:T1", "test", "github"));
    store.addEntity(mkTest("test:U1", "test", "github"));
    store.addTraceLink(verifies("manual-test:M1", "requirement:R1", 0.8));
    store.addTraceLink(verifies("test:T1", "requirement:R1", 1));
    store.addTraceLink(verifies("manual-test:M2", "requirement:R2", 0.6));

    const summary = store.inventorySummary();

    assert.equal(summary.entities.total, 7);
    assert.equal(summary.entities.byType.requirement, 3);
    assert.equal(summary.entities.byType["manual-test"], 2);
    assert.equal(summary.entities.byType.test, 2);
    assert.equal(summary.traceLinks.total, 3);
    assert.equal(summary.traceLinks.byType.verifies, 3);
    assert.equal(summary.coverage.requirementTotal, 3);
    assert.equal(summary.coverage.withManual, 2);
    assert.equal(summary.coverage.withAutomation, 1);
    assert.equal(summary.coverage.withBoth, 1);
    assert.equal(summary.coverage.withNeither, 1);
    assert.equal(summary.coverage.unmappedTests, 1);
    assert.equal(summary.coverage.verifyLinkTotal, 3);
    assert.ok(
      summary.coverage.averageVerifyLinkConfidence !== null
        && Math.abs(summary.coverage.averageVerifyLinkConfidence - 0.8) < 1e-9,
    );
    assert.deepEqual(
      summary.canonicalSourceProvenance.map((row) => row.source).sort(),
      ["github", "jira", "testrail"],
    );

    store.close();
  });
});

test("inventorySummary returns zeroed aggregates for an empty scope", () => {
  withStoreDirectory((directory) => {
    const store = new SqliteKnowledgeStore({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
    });
    const summary = store.inventorySummary();
    assert.equal(summary.entities.total, 0);
    assert.equal(summary.coverage.requirementTotal, 0);
    assert.equal(summary.coverage.unmappedTests, 0);
    assert.equal(summary.coverage.averageVerifyLinkConfidence, null);
    assert.deepEqual(summary.canonicalSourceProvenance, []);
    store.close();
  });
});
