import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { TestRailNormalizer } from "@tkl/normalizer-testrail";

const suiteCaseFixturePath = fileURLToPath(
  new URL("../fixtures/testrail/suite-case-normalization.json", import.meta.url),
);
const executionFixturePath = fileURLToPath(
  new URL("../fixtures/testrail/execution-normalization.json", import.meta.url),
);
const suiteCaseFixture = JSON.parse(readFileSync(suiteCaseFixturePath, "utf-8")) as {
  suite: RawEvidenceRecord;
  case: RawEvidenceRecord;
};
const executionFixture = JSON.parse(readFileSync(executionFixturePath, "utf-8")) as {
  run: RawEvidenceRecord;
  result: RawEvidenceRecord;
};

test("TestRail execution evidence remains product-scoped and links only explicit relationships", async () => {
  const normalizer = new TestRailNormalizer();
  const store = new InMemoryKnowledgeStore();
  const normalized = await Promise.all([
    normalizer.normalize(suiteCaseFixture.suite),
    normalizer.normalize(suiteCaseFixture.case),
    normalizer.normalize(executionFixture.run),
    normalizer.normalize(executionFixture.result),
  ]);

  for (const result of normalized) {
    for (const entity of result.entities) store.addEntity(entity);
  }
  for (const result of normalized) {
    for (const claim of result.claims) store.addClaim(claim);
    for (const link of result.traceLinks) store.addTraceLink(link);
  }

  const resultEntity = store.getEntity("test-execution:testrail:result:7701");
  assert.equal(resultEntity?.type, "test-execution");
  assert.equal(resultEntity?.productId, "fl-titling");
  assert.deepEqual(
    store.getClaims(resultEntity!.id).map((claim) => [claim.attribute, claim.value]),
    [
      ["status_id", "1"],
      ["status", "unknown"],
      ["executedAt", "2026-09-10T16:03:00.000Z"],
    ],
  );
  assert.deepEqual(
    store.getTraceLinks(resultEntity!.id).map((link) => link.id).sort(),
    [
      "link:testrail:result:7701:case:1201",
      "link:testrail:run:77:result:7701",
    ],
  );
});
