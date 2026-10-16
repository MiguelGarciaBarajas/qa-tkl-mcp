import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import { TklApplicationService } from "../src/index.js";
import {
  createDeprecatedJiraQueryAdapter,
  LEGACY_JIRA_QUERY_DEPRECATION_NOTICE,
  LEGACY_JIRA_QUERY_METHODS,
} from "../src/legacy-jira-queries.js";

const provenance = {
  source: "jira",
  sourceId: "STT-3731",
  sourceVersion: "1",
  observedAt: "2026-09-10T16:00:00.000Z",
  contentHash: "a".repeat(64),
  normalizerId: "fixture",
  normalizerVersion: "0.1.0",
};

function seededService() {
  const store = new InMemoryKnowledgeStore();
  store.addEntity({
    id: "requirement:STT-3731",
    tenantId: "tenant-test",
    productId: "fl-titling",
    type: "requirement",
    title: "FL Modernization",
    provenance,
  });
  store.addEntity({
    id: "test:C-1",
    tenantId: "tenant-test",
    productId: "fl-titling",
    type: "test",
    title: "Titling regression",
    provenance: { ...provenance, source: "testrail", sourceId: "C-1" },
  });
  store.addTraceLink({
    id: "link:STT-3731->C-1",
    fromEntityId: "test:C-1",
    toEntityId: "requirement:STT-3731",
    type: "verifies",
    origin: "explicit",
    confidence: 1,
    provenance,
  });
  store.addConflict({
    id: "conflict:STT-3731",
    entityId: "requirement:STT-3731",
    claimIds: ["claim:a", "claim:b"],
    reason: "Conflicting status claims",
    detectedAt: "2026-09-10T16:05:00.000Z",
    status: "open",
  });
  return new TklApplicationService({ store });
}

test("the primary core service no longer exposes Jira-specific query helpers", () => {
  const service = new TklApplicationService();
  for (const method of LEGACY_JIRA_QUERY_METHODS) {
    assert.equal(
      typeof service[method],
      "undefined",
      `TklApplicationService must not expose ${method} (ARCH-106)`,
    );
    assert.equal(method in service, false);
  }
  assert.equal(typeof service.ingest, "function");
});

test("the deprecated adapter preserves the removed 0.2 story context behavior", () => {
  const legacy = createDeprecatedJiraQueryAdapter(seededService(), {
    emitDeprecationWarning: false,
  });

  const context = legacy.getStoryTestContext("STT-3731");
  assert.equal(context.storyKey, "STT-3731");
  assert.equal(context.provenanceRequired, true);
  assert.deepEqual(context.traceLinks.map((link) => link.id), ["link:STT-3731->C-1"]);
  assert.deepEqual(
    context.entities.map((entity) => entity.id).sort(),
    ["requirement:STT-3731", "test:C-1"],
  );
});

test("the deprecated adapter rejects keys outside the Jira STT-<number> format", () => {
  const legacy = createDeprecatedJiraQueryAdapter(seededService(), {
    emitDeprecationWarning: false,
  });

  assert.throws(() => legacy.getStoryTestContext("FLT-2001"), /storyKey must match STT-<number>/);
  assert.throws(() => legacy.getStoryTestContext(3731), /storyKey must match STT-<number>/);
});

test("the deprecated adapter preserves the removed coverage and traceability shapes", () => {
  const legacy = createDeprecatedJiraQueryAdapter(seededService(), {
    emitDeprecationWarning: false,
  });

  const coverage = legacy.analyzeRequirementCoverage("STT-3731");
  assert.equal(coverage.status, "unevaluated");
  assert.equal(coverage.linkedArtifacts, 1);
  assert.match(coverage.reason, /No canonical requirements and approved test links/);
  assert.equal(coverage.provenance.length, 2);

  const explanation = legacy.explainTraceability("STT-3731");
  assert.deepEqual(Object.keys(explanation), ["storyKey", "links", "entities"]);
  assert.equal(explanation.links.length, 1);
  assert.equal(explanation.entities.length, 2);
});

test("the deprecated adapter preserves the removed conflict listing shape", () => {
  const legacy = createDeprecatedJiraQueryAdapter(seededService(), {
    emitDeprecationWarning: false,
  });

  assert.deepEqual(
    legacy.listKnowledgeConflicts(),
    { conflicts: [{
      id: "conflict:STT-3731",
      entityId: "requirement:STT-3731",
      claimIds: ["claim:a", "claim:b"],
      reason: "Conflicting status claims",
      detectedAt: "2026-09-10T16:05:00.000Z",
      status: "open",
    }] },
  );
});

test("the deprecated adapter exposes only the legacy surface and stays isolated", () => {
  const service = seededService();
  const legacy = createDeprecatedJiraQueryAdapter(service, { emitDeprecationWarning: false });

  assert.equal(legacy.deprecated, true);
  assert.equal(legacy.removedIn, "@tkl/core 0.4");
  assert.deepEqual(
    Object.keys(legacy).filter((key) => typeof legacy[key] === "function").sort(),
    [...LEGACY_JIRA_QUERY_METHODS].sort(),
  );
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal(typeof service.getStoryTestContext, "undefined");
});

test("the deprecated adapter requires a service with a knowledge store", () => {
  assert.throws(
    () => createDeprecatedJiraQueryAdapter(undefined),
    /requires a TklApplicationService with a knowledge store/,
  );
  assert.throws(
    () => createDeprecatedJiraQueryAdapter({ store: {} }),
    /requires a TklApplicationService with a knowledge store/,
  );
});

test("the deprecated adapter emits a deprecation warning by default", async () => {
  const warnings = [];
  const capture = (warning) => warnings.push(warning);
  process.on("warning", capture);
  try {
    createDeprecatedJiraQueryAdapter(seededService());
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", capture);
  }

  const deprecation = warnings.find((warning) => warning.name === "DeprecationWarning");
  assert.ok(deprecation, "expected a DeprecationWarning");
  assert.equal(deprecation.message, LEGACY_JIRA_QUERY_DEPRECATION_NOTICE);
  assert.match(deprecation.message, /removed in @tkl\/core 0\.4/);
});

test("the deprecated adapter is reachable through the package subpath export", async () => {
  const viaSubpath = await import("@tkl/core/legacy-jira-queries");
  assert.equal(
    viaSubpath.createDeprecatedJiraQueryAdapter,
    createDeprecatedJiraQueryAdapter,
  );
});
