import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { TestRailNormalizer } from "@tkl/normalizer-testrail";

const fixturePath = fileURLToPath(
  new URL("../fixtures/testrail/suite-case-normalization.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  suite: RawEvidenceRecord;
  case: RawEvidenceRecord;
};
const traceabilityFixturePath = fileURLToPath(
  new URL("../fixtures/testrail/case-traceability.json", import.meta.url),
);
const traceabilityFixture = JSON.parse(readFileSync(traceabilityFixturePath, "utf-8")) as {
  case: RawEvidenceRecord;
};

test("TestRail suite/case evidence becomes product-scoped canonical manual-test knowledge", async () => {
  const normalizer = new TestRailNormalizer();
  const store = new InMemoryKnowledgeStore();
  const suite = await normalizer.normalize(fixture.suite);
  const testCase = await normalizer.normalize(fixture.case);

  for (const entity of [...suite.entities, ...testCase.entities]) {
    store.addEntity(entity);
  }
  for (const claim of [...suite.claims, ...testCase.claims]) {
    store.addClaim(claim);
  }
  for (const link of testCase.traceLinks) {
    store.addTraceLink(link);
  }

  assert.equal(store.getEntity("test-suite:testrail:12")?.productId, "fl-titling");
  assert.equal(store.getEntity("manual-test:testrail:1201")?.type, "manual-test");
  assert.deepEqual(
    store.getTraceLinks("test-suite:testrail:12").map((link) => link.id),
    ["link:testrail:suite:12:case:1201"],
  );
});

test("configured TestRail references link a case to existing Jira and GitHub knowledge", async () => {
  const normalizer = new TestRailNormalizer({
    jiraReferenceField: "custom_jira_references",
    githubAutomationReferenceField: "custom_github_automation",
  });
  const store = new InMemoryKnowledgeStore();
  const result = await normalizer.normalize(traceabilityFixture.case);
  const sourceProvenance = result.entities[0].provenance;

  store.addEntity({
    id: "test-suite:testrail:12",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test-suite",
    title: "Sanitized suite",
    provenance: sourceProvenance,
  });
  store.addEntity({
    id: "requirement:STT-1234",
    tenantId: "solera",
    productId: "fl-titling",
    type: "requirement",
    title: "Sanitized Jira requirement",
    provenance: sourceProvenance,
  });
  store.addEntity({
    id: "test:github:4321",
    tenantId: "solera",
    productId: "fl-titling",
    type: "test",
    title: "Sanitized GitHub automation",
    provenance: sourceProvenance,
  });
  store.upsert(result);

  assert.deepEqual(
    store.getTraceLinks("manual-test:testrail:1202").map((link) => [
      link.toEntityId,
      link.type,
      link.origin,
      link.confidence,
    ]),
    [
      ["manual-test:testrail:1202", "contains", "explicit", 1],
      ["requirement:STT-1234", "verifies", "explicit", 1],
      ["test:github:4321", "relates_to", "explicit", 1],
    ],
  );
});
