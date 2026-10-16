import test from "node:test";
import assert from "node:assert/strict";
import {
  averageFreshnessHours,
  confusionCounts,
  percentile,
  precisionRecall,
  provenanceCompleteness,
  qaAcceptanceRate,
} from "./metrics.ts";
import type { Provenance } from "@tkl/contracts";

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    source: "jira",
    sourceId: "STT-1",
    sourceVersion: "1",
    contentHash: "hash",
    observedAt: "2026-01-01T00:00:00.000Z",
    normalizerId: "jira-normalizer",
    normalizerVersion: "0.1.0",
    ...overrides,
  };
}

test("confusionCounts classifies expected/actual pairs into TP/FP/FN/TN", () => {
  const counts = confusionCounts([
    { ticketKey: "a", expectedCovered: true, actualCovered: true }, // TP
    { ticketKey: "b", expectedCovered: false, actualCovered: true }, // FP
    { ticketKey: "c", expectedCovered: true, actualCovered: false }, // FN
    { ticketKey: "d", expectedCovered: false, actualCovered: false }, // TN
  ]);
  assert.deepEqual(counts, {
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    trueNegatives: 1,
  });
});

test("precisionRecall computes standard ratios", () => {
  const { precision, recall } = precisionRecall({
    truePositives: 3,
    falsePositives: 1,
    falseNegatives: 2,
    trueNegatives: 5,
  });
  assert.equal(precision, 3 / 4);
  assert.equal(recall, 3 / 5);
});

test("precisionRecall is vacuously 1 when there is nothing to predict", () => {
  const { precision, recall } = precisionRecall({
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 4,
  });
  assert.equal(precision, 1);
  assert.equal(recall, 1);
});

test("provenanceCompleteness is 1.0 when every required field is populated", () => {
  const score = provenanceCompleteness([provenance(), provenance({ sourceId: "STT-2" })]);
  assert.equal(score, 1);
});

test("provenanceCompleteness penalizes records missing a required field", () => {
  const score = provenanceCompleteness([provenance(), provenance({ normalizerVersion: "" })]);
  assert.equal(score, 0.5);
});

test("provenanceCompleteness is vacuously 1 for an empty set", () => {
  assert.equal(provenanceCompleteness([]), 1);
});

test("averageFreshnessHours computes the mean age relative to a reference instant", () => {
  const hours = averageFreshnessHours(
    ["2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"],
    "2026-01-02T00:00:00.000Z",
  );
  // Ages are 24h and 12h old -> average 18h.
  assert.equal(hours, 18);
});

test("percentile returns the nearest-rank value for p50/p95", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 100);
});

test("percentile handles an empty series", () => {
  assert.equal(percentile([], 50), 0);
});

test("qaAcceptanceRate only accepts fully covered tickets with no open conflicts", () => {
  const rate = qaAcceptanceRate([
    { fullyCovered: true, hasOpenConflict: false },
    { fullyCovered: true, hasOpenConflict: true },
    { fullyCovered: false, hasOpenConflict: false },
    { fullyCovered: true, hasOpenConflict: false },
  ]);
  assert.equal(rate, 0.5);
});
