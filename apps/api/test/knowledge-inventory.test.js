import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteKnowledgeStore } from "@tkl/knowledge-store";
import { InMemoryRawEvidenceStore } from "@tkl/raw-evidence-store";
import { createApplication } from "../src/app.js";
import { createKnowledgeInventoryService } from "../src/knowledge-inventory-service.js";

const TENANT = "solera";
const PRODUCT = "fl-titling";

function provenance(sourceId, source = "jira") {
  return {
    source,
    sourceId,
    sourceVersion: "1",
    contentHash: `hash-${sourceId}`,
    observedAt: "2026-09-10T00:00:00.000Z",
    normalizerId: "normalizer",
    normalizerVersion: "0.1.0",
  };
}

function entity(id, type, source) {
  return {
    id,
    tenantId: TENANT,
    productId: PRODUCT,
    type,
    title: id,
    provenance: provenance(id, source),
  };
}

function verifies(from, to, confidence = 1) {
  return {
    id: `link:${from}:${to}`,
    fromEntityId: from,
    toEntityId: to,
    type: "verifies",
    origin: "explicit",
    confidence,
    provenance: provenance(`${from}:${to}`),
  };
}

function rawRecord(overrides = {}) {
  return {
    tenantId: TENANT,
    productId: PRODUCT,
    source: "jira",
    sourceId: "STT-1",
    sourceVersion: "1",
    observedAt: "2026-09-10T00:00:00.000Z",
    contentType: "application/json",
    contentHash: "hash-1",
    payload: { summary: "fixture" },
    classification: "internal",
    ...overrides,
  };
}

async function withStore(run) {
  const directory = mkdtempSync(join(process.cwd(), ".tkl-inventory-test-"));
  const store = new SqliteKnowledgeStore({
    dataDirectory: directory,
    tenantId: TENANT,
    productId: PRODUCT,
  });
  try {
    return await run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedCanonical(store) {
  store.addEntity(entity("requirement:R1", "requirement", "jira"));
  store.addEntity(entity("requirement:R2", "requirement", "jira"));
  store.addEntity(entity("requirement:R3", "requirement", "jira"));
  store.addEntity(entity("manual-test:M1", "manual-test", "testrail"));
  store.addEntity(entity("test:T1", "test", "github"));
  store.addEntity(entity("test:U1", "test", "github"));
  store.addTraceLink(verifies("manual-test:M1", "requirement:R1", 0.9));
  store.addTraceLink(verifies("test:T1", "requirement:R1", 1));
  store.addTraceLink(verifies("manual-test:M1", "requirement:R2", 0.8));
}

function knowledgeServiceFor(store) {
  return {
    tenantId: TENANT,
    getStore(productId) {
      return productId === PRODUCT ? store : undefined;
    },
  };
}

async function seededRawStore() {
  const store = new InMemoryRawEvidenceStore({
    tenantId: TENANT,
    productId: PRODUCT,
    projectionFailureThreshold: 1,
  });
  await store.commit({
    connectorId: "connector.jira",
    records: [
      rawRecord({ sourceId: "STT-1", observedAt: "2026-09-10T00:00:00.000Z", idempotencyKey: "jira:1" }),
      rawRecord({ sourceId: "STT-2", observedAt: "2026-09-13T00:00:00.000Z", idempotencyKey: "jira:2" }),
    ],
  });
  await store.commit({
    connectorId: "connector.github",
    records: [
      rawRecord({ source: "github", sourceId: "42", observedAt: "2026-09-11T00:00:00.000Z", idempotencyKey: "github:42" }),
    ],
  });
  // Dead-letter one jira record (threshold is 1).
  await store.recordProjectionFailures(["jira:1"]);
  return store;
}

const connectionList = [
  {
    source: "jira",
    displayName: "Jira",
    status: "connected",
    configured: true,
    lastSyncAt: "2026-09-13T00:00:00.000Z",
    lastSuccessfulSyncAt: "2026-09-13T00:00:00.000Z",
    error: null,
  },
  {
    source: "testrail",
    displayName: "TestRail",
    status: "connected",
    configured: true,
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    error: null,
  },
];

test("aggregates bounded canonical, bronze, coverage, and gap metrics", async () => {
  await withStore(async (store) => {
    seedCanonical(store);
    const rawStore = await seededRawStore();
    const service = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      rawEvidenceStoreProvider: async () => rawStore,
      sourceConnectionService: { list: async () => connectionList },
      now: () => "2026-09-14T00:00:00.000Z",
    });

    const inventory = await service.getInventory({ productId: PRODUCT });

    // Canonical (Silver)
    assert.equal(inventory.canonicalKnowledge.available, true);
    assert.equal(inventory.canonicalKnowledge.entities.total, 6);
    assert.equal(inventory.canonicalKnowledge.traceLinks.total, 3);

    // Coverage / mapping
    assert.equal(inventory.coverage.requirementTotal, 3);
    assert.equal(inventory.coverage.withManual, 2);
    assert.equal(inventory.coverage.withAutomation, 1);
    assert.equal(inventory.coverage.withBoth, 1);
    assert.equal(inventory.coverage.withNeither, 1);
    assert.equal(inventory.coverage.unmappedTests, 1);
    assert.equal(inventory.coverage.model.confidenceThreshold, null);

    // Collected evidence (Bronze)
    assert.equal(inventory.collectedEvidence.available, true);
    assert.equal(inventory.collectedEvidence.totalRetainedRecords, 3);
    const jiraRow = inventory.collectedEvidence.bySource.find((row) => row.source === "jira");
    assert.equal(jiraRow.retainedRecords, 2);
    assert.equal(jiraRow.lastObservedAt, "2026-09-13T00:00:00.000Z");
    assert.equal(inventory.collectedEvidence.pendingProjection.attributable, false);
    assert.equal(inventory.collectedEvidence.deadLetter.total, 1);
    assert.deepEqual(inventory.collectedEvidence.deadLetter.bySource, [
      { source: "jira", count: 1 },
    ]);

    // Freshness
    assert.equal(inventory.freshness.newestObservedAt, "2026-09-13T00:00:00.000Z");

    // Actionable gaps present and severity-sorted
    const gapIds = inventory.actionableGaps.map((gap) => gap.id);
    assert.ok(gapIds.includes("missing-tests"));
    assert.ok(gapIds.includes("dead-letter"));
    assert.ok(gapIds.includes("stale-source"));
    assert.equal(inventory.meta.partial, false);
  });
});

test("does not call unbounded raw list APIs for large paths", async () => {
  await withStore(async (store) => {
    seedCanonical(store);
    const rawStore = await seededRawStore();
    const forbidden = ["listRecords", "listPendingProjectionRecords", "pageRecords"];
    const guarded = new Proxy(rawStore, {
      get(target, property, receiver) {
        if (forbidden.includes(property)) {
          return () => {
            throw new Error(`Unbounded API ${String(property)} must not be called`);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      rawEvidenceStoreProvider: async () => guarded,
      sourceConnectionService: { list: async () => connectionList },
    });

    const inventory = await service.getInventory({ productId: PRODUCT });
    assert.equal(inventory.collectedEvidence.available, true);
    assert.equal(inventory.collectedEvidence.totalRetainedRecords, 3);
  });
});

test("reports zero-state cleanly for an empty product", async () => {
  await withStore(async (store) => {
    const rawStore = new InMemoryRawEvidenceStore({ tenantId: TENANT, productId: PRODUCT });
    const service = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      rawEvidenceStoreProvider: async () => rawStore,
      sourceConnectionService: { list: async () => [] },
    });

    const inventory = await service.getInventory({ productId: PRODUCT });
    assert.equal(inventory.canonicalKnowledge.available, true);
    assert.equal(inventory.canonicalKnowledge.entities.total, 0);
    assert.equal(inventory.coverage.requirementTotal, 0);
    assert.equal(inventory.coverage.mappedCoverageRatio, null);
    assert.equal(inventory.collectedEvidence.totalRetainedRecords, 0);
    assert.deepEqual(inventory.actionableGaps, []);
    assert.equal(inventory.meta.partial, false);
  });
});

test("flags partial state when the raw evidence store is unavailable", async () => {
  await withStore(async (store) => {
    seedCanonical(store);
    const service = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      // no rawEvidenceStoreProvider wired
      sourceConnectionService: { list: async () => connectionList },
    });

    const inventory = await service.getInventory({ productId: PRODUCT });
    assert.equal(inventory.collectedEvidence.available, false);
    assert.equal(inventory.collectedEvidence.totalRetainedRecords, null);
    assert.equal(inventory.canonicalKnowledge.available, true);
    assert.equal(inventory.meta.partial, true);
    assert.ok(inventory.meta.notes.some((note) => note.includes("Bronze")));
  });
});

test("does not fabricate zeros when the canonical store cannot be opened", async () => {
  const service = createKnowledgeInventoryService({
    knowledgeService: {
      tenantId: TENANT,
      getStore() {
        throw new Error("store open failed");
      },
    },
    rawEvidenceStoreProvider: async () =>
      new InMemoryRawEvidenceStore({ tenantId: TENANT, productId: PRODUCT }),
    sourceConnectionService: { list: async () => [] },
  });

  const inventory = await service.getInventory({ productId: PRODUCT });
  assert.equal(inventory.canonicalKnowledge.available, false);
  assert.equal(inventory.canonicalKnowledge.entities.total, null);
  assert.equal(inventory.coverage.available, false);
  assert.equal(inventory.meta.partial, true);
});

test("isolates canonical metrics to the requested product", async () => {
  await withStore(async (store) => {
    seedCanonical(store);
    const service = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      rawEvidenceStoreProvider: async () =>
        new InMemoryRawEvidenceStore({ tenantId: TENANT, productId: "other-product" }),
      sourceConnectionService: { list: async () => [] },
    });

    const other = await service.getInventory({ productId: "other-product" });
    // getStore only returns the seeded store for PRODUCT, so a different product is empty.
    assert.equal(other.canonicalKnowledge.available, false);
    assert.equal(other.meta.partial, true);
  });
});

function requestInventory(application, path, authContext) {
  return application.handle({
    method: "GET",
    pathname: new URL(path, "http://localhost").pathname,
    url: new URL(path, "http://localhost"),
    authContext:
      authContext !== undefined
        ? authContext
        : {
            subject: "test-user",
            tenantId: TENANT,
            roles: ["reader"],
            permissions: [
              "knowledge:read",
              "coverage:read",
              "conflicts:read",
              "connections:read",
            ],
            productIds: [PRODUCT],
          },
  });
}

test("serves the knowledge inventory route with contract-valid output", async () => {
  await withStore(async (store) => {
    seedCanonical(store);
    const rawStore = await seededRawStore();
    const inventoryService = createKnowledgeInventoryService({
      knowledgeService: knowledgeServiceFor(store),
      rawEvidenceStoreProvider: async () => rawStore,
      sourceConnectionService: { list: async () => connectionList },
    });
    const application = createApplication({
      knowledgeService: knowledgeServiceFor(store),
      knowledgeInventoryService: inventoryService,
    });

    const response = await requestInventory(
      application,
      `/v1/intelligence/knowledge-inventory?productId=${PRODUCT}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.productId, PRODUCT);
    assert.equal(response.body.coverage.requirementTotal, 3);
    assert.ok(Array.isArray(response.body.actionableGaps));
    assert.ok(response.body.meta.limitations.length > 0);
  });
});

test("requires productId and all inventory read permissions on the inventory route", async () => {
  await withStore(async (store) => {
    const application = createApplication({
      knowledgeService: knowledgeServiceFor(store),
      knowledgeInventoryService: createKnowledgeInventoryService({
        knowledgeService: knowledgeServiceFor(store),
        rawEvidenceStoreProvider: async () =>
          new InMemoryRawEvidenceStore({ tenantId: TENANT, productId: PRODUCT }),
        sourceConnectionService: { list: async () => [] },
      }),
    });

    const missingProduct = await requestInventory(
      application,
      "/v1/intelligence/knowledge-inventory",
    );
    assert.equal(missingProduct.status, 400);
    assert.equal(missingProduct.body.error.details.parameter, "productId");

    const forbidden = await requestInventory(
      application,
      `/v1/intelligence/knowledge-inventory?productId=${PRODUCT}`,
      {
        subject: "test-user",
        tenantId: TENANT,
        roles: ["reader"],
        permissions: [],
        productIds: [PRODUCT],
      },
    );
    assert.equal(forbidden.status, 403);

    for (const missingPermission of [
      "knowledge:read",
      "coverage:read",
      "conflicts:read",
      "connections:read",
    ]) {
      const permissions = [
        "knowledge:read",
        "coverage:read",
        "conflicts:read",
        "connections:read",
      ].filter((permission) => permission !== missingPermission);
      const response = await requestInventory(
        application,
        `/v1/intelligence/knowledge-inventory?productId=${PRODUCT}`,
        {
          subject: "test-user",
          tenantId: TENANT,
          roles: ["reader"],
          permissions,
          productIds: [PRODUCT],
        },
      );
      assert.equal(response.status, 403, `missing ${missingPermission}`);
    }
  });
});
