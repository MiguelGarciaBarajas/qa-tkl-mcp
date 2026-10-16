import test from "node:test";
import assert from "node:assert/strict";
import { loadGoldenDataset } from "./goldenDataset.ts";
import { runEvaluation } from "./harness.ts";

/**
 * Exercises the evaluation harness against the committed golden dataset using the
 * real Jira/GitHub normalizers and coverage/conflict analyzers (no mocks). Asserts
 * dataset integrity and known, deliberately-designed outcomes per fixture category -
 * see `tests/fixtures/golden-dataset/manifest.json` for what each category represents.
 */

test("golden dataset loads with one expected outcome per ticket and per-category evidence", () => {
  const { manifest, tickets } = loadGoldenDataset();
  assert.ok(tickets.length >= 20 && tickets.length <= 30, "dataset should contain 20-30 tickets");
  assert.equal(tickets.length, manifest.tickets.length);

  for (const ticket of tickets) {
    assert.ok(ticket.jiraRecords.length >= 1, `${ticket.key} must have at least one Jira record`);
    assert.ok(ticket.expected.requirementId.startsWith("requirement:"));
  }
});

test("runEvaluation scores every ticket and produces a full EvaluationMetrics report", async () => {
  const report = await runEvaluation();

  assert.equal(report.ticketResults.length, report.metrics.ticketCount);
  assert.ok(report.metrics.ticketCount >= 20);

  for (const metric of [
    report.metrics.precision,
    report.metrics.recall,
    report.metrics.provenanceCompleteness,
    report.metrics.qaAcceptanceRate,
  ]) {
    assert.ok(metric >= 0 && metric <= 1, `ratio metrics must be within [0, 1], got ${metric}`);
  }
  assert.ok(report.metrics.freshnessHours > 0);
  assert.ok(report.metrics.latencyMsP95 >= report.metrics.latencyMsP50);
});

test("clean-single-pr and clean-multi-pr tickets are fully covered", async () => {
  const report = await runEvaluation();
  const clean = report.ticketResults.filter(
    (r) => r.category === "clean-single-pr" || r.category === "clean-multi-pr",
  );
  assert.ok(clean.length > 0);
  for (const result of clean) {
    assert.equal(result.actualCovered, true, `${result.ticketKey} should be covered`);
    assert.ok(result.numerator >= Math.min(result.denominator, 1));
  }
});

test("known gap: ConflictAnalyzer false-flags any ticket with more than one acceptance criterion", async () => {
  // @tkl/analyzer-conflicts groups claims purely by attribute name and flags >1 distinct
  // value as disagreement - it does not distinguish "these are two different, expected
  // list items" (e.g. AC #1 and AC #2 of the same story) from "these are two competing
  // answers to the same question" (e.g. two revisions disagreeing on one AC's wording).
  // This test pins down and quantifies that measured behavior; it is not something this
  // harness should paper over, since the golden dataset's job is to surface exactly this
  // kind of gap for the Knowledge and Traceability workstream to address.
  const report = await runEvaluation();
  const nonConflictCategoryResults = report.ticketResults.filter((r) => r.category !== "conflicting-claims");
  assert.ok(nonConflictCategoryResults.length > 0);
  for (const result of nonConflictCategoryResults) {
    const expectedFalsePositive = result.denominator > 1;
    assert.equal(
      result.actualConflict,
      expectedFalsePositive,
      `${result.ticketKey}: expected actualConflict=${expectedFalsePositive} for denominator=${result.denominator}`,
    );
  }

  assert.ok(
    report.conflictDetection.precision < 1,
    "conflict-detection precision should measurably reflect the multi-AC false-positive gap",
  );
  assert.equal(report.conflictDetection.recall, 1, "genuine conflicting-revision tickets must still be caught");
});

test("no-evidence tickets correctly report zero coverage (true negative)", async () => {
  const report = await runEvaluation();
  const noEvidence = report.ticketResults.filter((r) => r.category === "no-evidence");
  assert.ok(noEvidence.length > 0);
  for (const result of noEvidence) {
    assert.equal(result.actualCovered, false);
    assert.equal(result.expectedCovered, false);
    assert.equal(result.numerator, 0);
  }
});

test("prose-only-reference tickets expose a real recall gap: expected covered but not detected", async () => {
  const report = await runEvaluation();
  const proseOnly = report.ticketResults.filter((r) => r.category === "prose-only-reference");
  assert.ok(proseOnly.length > 0);
  for (const result of proseOnly) {
    assert.equal(result.expectedCovered, true, `${result.ticketKey} is verified in prose per the golden label`);
    assert.equal(
      result.actualCovered,
      false,
      `${result.ticketKey}: current GitHubNormalizer cannot see prose-only references (known gap)`,
    );
  }
});

test("conflicting-claims tickets are flagged as open conflicts", async () => {
  const report = await runEvaluation();
  const conflicting = report.ticketResults.filter((r) => r.category === "conflicting-claims");
  assert.ok(conflicting.length > 0);
  for (const result of conflicting) {
    assert.equal(result.actualConflict, true, `${result.ticketKey} should be flagged as conflicting`);
    assert.equal(result.expectedConflict, true);
  }
});

test("runEvaluation is repeatable: every non-timing field is identical across runs", async () => {
  const first = await runEvaluation();
  const second = await runEvaluation();

  const strip = (r: Awaited<ReturnType<typeof runEvaluation>>) => ({
    metrics: { ...r.metrics, latencyMsP50: 0, latencyMsP95: 0 },
    ticketResults: r.ticketResults.map(({ latencyMs: _latencyMs, ...rest }) => rest),
  });

  assert.deepEqual(strip(first), strip(second));
});
