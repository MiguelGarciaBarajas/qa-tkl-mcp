import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { CanonicalEntity } from "@tkl/contracts";
import {
  renderApprovedTestRailKnowledgeToMarkdown,
  renderEntityToMarkdown,
} from "./render.ts";

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

test("refuses to render an entity with no approved claims", () => {
  const store = new InMemoryKnowledgeStore();
  const entity: CanonicalEntity = {
    id: "requirement:STT-1234",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "VIN validation",
    provenance: provenance(),
  };
  store.addEntity(entity);
  store.addClaim({
    id: "c1",
    entityId: entity.id,
    attribute: "acceptanceCriteria",
    value: "must reject invalid VIN",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  });

  assert.throws(() => renderEntityToMarkdown(entity, store));
});

test("renders title, approved acceptance criteria, and trace links only", () => {
  const store = new InMemoryKnowledgeStore();
  const entity: CanonicalEntity = {
    id: "requirement:STT-1234",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "VIN validation",
    provenance: provenance(),
  };
  store.addEntity(entity);
  store.addEntity({
    id: "test:github:4321",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "VIN validation test",
    provenance: provenance(),
  });
  store.addClaim({
    id: "c1",
    entityId: entity.id,
    attribute: "acceptanceCriteria",
    value: "must reject invalid VIN",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: provenance(),
  });
  store.addClaim({
    id: "c2",
    entityId: entity.id,
    attribute: "acceptanceCriteria",
    value: "unreviewed pending criterion",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  });
  store.addTraceLink({
    id: "link-1",
    fromEntityId: "test:github:4321",
    toEntityId: entity.id,
    type: "verifies",
    origin: "explicit",
    confidence: 0.9,
    provenance: provenance(),
  });

  const markdown = renderEntityToMarkdown(entity, store);

  assert.match(markdown, /# VIN validation/);
  assert.match(markdown, /must reject invalid VIN/);
  assert.doesNotMatch(markdown, /unreviewed pending criterion/);
  assert.match(markdown, /verifies .* test:github:4321/);
});

test("exports approved TestRail suites, cases, and executions while omitting pending knowledge", () => {
  const store = new InMemoryKnowledgeStore();
  const testRailProvenance = {
    ...provenance(),
    source: "testrail",
    sourceVersion: "1789056000",
  };
  const entities: CanonicalEntity[] = [
    {
      id: "test-suite:testrail:12",
      tenantId: "solera",
      productId: "fl-titling",
      type: "test-suite",
      title: "Regression suite",
      provenance: { ...testRailProvenance, sourceId: "12" },
    },
    {
      id: "manual-test:testrail:1201",
      tenantId: "solera",
      productId: "fl-titling",
      type: "manual-test",
      title: "Approved case",
      provenance: { ...testRailProvenance, sourceId: "1201" },
    },
    {
      id: "test-execution:testrail:result:7701",
      tenantId: "solera",
      productId: "fl-titling",
      type: "test-execution",
      title: "Approved result",
      provenance: { ...testRailProvenance, sourceId: "7701" },
    },
  ];
  entities.forEach((entity) => store.addEntity(entity));
  store.addClaim({
    id: "claim:suite:name",
    entityId: entities[0].id,
    attribute: "name",
    value: "Regression suite",
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: entities[0].provenance,
  });
  store.addClaim({
    id: "claim:case:title",
    entityId: entities[1].id,
    attribute: "title",
    value: "Approved case",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: entities[1].provenance,
  });
  store.addClaim({
    id: "claim:result:status",
    entityId: entities[2].id,
    attribute: "status",
    value: "passed",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: entities[2].provenance,
  });

  const markdown = renderApprovedTestRailKnowledgeToMarkdown(entities, store);

  assert.doesNotMatch(markdown, /Regression suite/);
  assert.match(markdown, /# Approved case/);
  assert.match(markdown, /\*\*Title:\*\* Approved case/);
  assert.doesNotMatch(markdown, /# Approved result/);
  assert.match(markdown, /# TestRail Test-Execution 7701/);
  assert.match(markdown, /\*\*Status:\*\* passed/);
});

test("refuses a combined TestRail export when no entity has approved claims", () => {
  const store = new InMemoryKnowledgeStore();
  const entity: CanonicalEntity = {
    id: "test-suite:testrail:12",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test-suite",
    title: "Pending suite",
    provenance: { ...provenance(), source: "testrail", sourceId: "12" },
  };
  store.addEntity(entity);

  assert.throws(
    () => renderApprovedTestRailKnowledgeToMarkdown([entity], store),
    /no approved entities/,
  );
});

test("TestRail export excludes approved claims whose provenance belongs to another source", () => {
  const store = new InMemoryKnowledgeStore();
  const entity: CanonicalEntity = {
    id: "manual-test:testrail:1201",
    tenantId: "solera",
    productId: "fl-titling",
    type: "manual-test",
    title: "Cross-source case",
    provenance: [
      { ...provenance(), source: "testrail", sourceId: "1201" },
      { ...provenance(), source: "jira", sourceId: "STT-1234" },
    ],
  };
  store.addEntity(entity);
  store.addClaim({
    id: "claim:jira:description",
    entityId: entity.id,
    attribute: "description",
    value: "Jira-only approved text",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: { ...provenance(), source: "jira", sourceId: "STT-1234" },
  });

  assert.throws(
    () => renderApprovedTestRailKnowledgeToMarkdown([entity], store),
    /no approved entities/,
  );
});
