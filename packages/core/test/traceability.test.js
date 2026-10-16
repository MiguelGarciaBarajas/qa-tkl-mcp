import test from "node:test";
import assert from "node:assert/strict";
import { createRawEvidenceRecord } from "@tkl/contracts";
import { prepareTraceability } from "../src/index.js";

test("prepares deterministic provenance references without inventing coverage", () => {
  const record = createRawEvidenceRecord({
    tenantId: "tenant-test",
    productId: "fl-titling",
    source: "jira",
    sourceId: "STT-3731",
    sourceVersion: "2026-09-10",
    observedAt: "2026-09-10T16:00:00.000Z",
    contentType: "jira.issue",
    payload: { summary: "FL Modernization" },
    classification: "internal",
  });
  const result = prepareTraceability([record]);
  assert.equal(result.sources[0].sourceId, "STT-3731");
  assert.equal(result.relationships.length, 0);
  assert.equal(result.coverage.status, "not-evaluated");
});
