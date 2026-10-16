import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { Claim } from "@tkl/contracts";
import { ConflictAnalyzer } from "./analyzer.ts";

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

test("detects and persists an open conflict when two claims disagree on the same attribute", async () => {
  const store = new InMemoryKnowledgeStore();
  const entityId = "requirement:STT-1234";

  const claims: Claim[] = [
    {
      id: "c1",
      entityId,
      attribute: "maxFieldLength",
      value: 17,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: provenance(),
    },
    {
      id: "c2",
      entityId,
      attribute: "maxFieldLength",
      value: 20,
      origin: "inferred",
      confidence: 0.6,
      status: "pending",
      provenance: provenance(),
    },
  ];
  claims.forEach((c) => store.addClaim(c));

  const analyzer = new ConflictAnalyzer();
  const conflicts = await analyzer.analyze({ entityId, store, now: () => "2026-09-10T00:00:00.000Z" });

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, "open");
  assert.deepEqual(conflicts[0].claimIds, ["c1", "c2"]);
  assert.equal(store.listOpenConflicts(entityId).length, 1);
});

test("no conflict is raised when claims for an attribute agree", async () => {
  const store = new InMemoryKnowledgeStore();
  const entityId = "requirement:STT-1234";

  store.addClaim({
    id: "c1",
    entityId,
    attribute: "maxFieldLength",
    value: 17,
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance: provenance(),
  });
  store.addClaim({
    id: "c2",
    entityId,
    attribute: "maxFieldLength",
    value: 17,
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: provenance(),
  });

  const analyzer = new ConflictAnalyzer();
  const conflicts = await analyzer.analyze({ entityId, store });

  assert.equal(conflicts.length, 0);
  assert.equal(store.listOpenConflicts(entityId).length, 0);
});

test("rejected TestRail claim revisions do not reopen a resolved conflict", async () => {
  const store = new InMemoryKnowledgeStore();
  const entityId = "manual-test:testrail:1201";
  store.addClaim({
    id: "claim:case:1201:title:old",
    entityId,
    attribute: "title",
    value: "Old title",
    origin: "explicit",
    confidence: 1,
    status: "rejected",
    provenance: { ...provenance(), source: "testrail", sourceId: "1201" },
  });
  store.addClaim({
    id: "claim:case:1201:title:new",
    entityId,
    attribute: "title",
    value: "Approved title",
    origin: "explicit",
    confidence: 1,
    status: "approved",
    provenance: {
      ...provenance(),
      source: "testrail",
      sourceId: "1201",
      sourceVersion: "4",
    },
  });

  const conflicts = await new ConflictAnalyzer().analyze({ entityId, store });

  assert.deepEqual(conflicts, []);
  assert.deepEqual(store.listOpenConflicts(entityId), []);
});
