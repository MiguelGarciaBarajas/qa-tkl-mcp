# @tkl/evaluation

Golden dataset and evaluation harness for the Dashboard and Evaluation workstream
(Clemente Herrera). Runs the **real** Knowledge and Traceability pipeline - the same
`JiraNormalizer` / `GitHubNormalizer` / `CoverageAnalyzer` / `ConflictAnalyzer` used in
production, not the dashboard's temporary mocks - against a committed set of synthetic
FL Titling tickets, and scores the result against hand-labeled expected outcomes.

## Why this exists

Per `docs/team/TKL-Team-Work-Plan.md` (Evaluation, section 9) and the Definition of
Done, evaluation results must be **repeatable from committed fixtures**, and no
improvement may be claimed without a measured result. This package is that measurement
surface: it does not modify normalizers or analyzers, it only observes and scores them.

## Layout

- `tests/fixtures/golden-dataset/` (repo root) - the committed dataset: 25 synthetic FL
  Titling tickets, each with raw Jira/GitHub evidence and a hand-authored
  `expected.json` label. See that directory's `README.md` for the category design.
- `scripts/generate-golden-dataset.ts` - the single source of truth that produces the
  dataset above. Re-run it and review the diff before committing any dataset change;
  do not hand-edit the generated fixture/expected JSON files.
- `src/goldenDataset.ts` - loads the committed manifest + per-ticket fixtures.
- `src/metrics.ts` - pure, dependency-free scoring functions (precision/recall,
  provenance completeness, freshness, percentiles, QA acceptance rate). Unit tested in
  `src/metrics.test.ts` without touching fixtures or normalizers.
- `src/harness.ts` - wires fixtures through the real normalizers/analyzers per ticket
  and aggregates an `EvaluationMetrics` report (same shape the dashboard's Evaluation
  page already renders from mock data in `apps/dashboard/src/contracts/types.ts`).
- `src/cli.ts` - prints a full evaluation report as JSON to stdout.

## Usage

```bash
# Regenerate the golden dataset (only after changing scripts/generate-golden-dataset.ts)
npm run generate-dataset --workspace=@tkl/evaluation

# Run the harness and print an EvaluationMetrics report
npm run evaluate --workspace=@tkl/evaluation

# Run the harness's own unit + integration tests
npm run test --workspace=@tkl/evaluation
```

Reports printed by `evaluate` are generated output, not fixtures - do not commit them
(see `.gitignore`'s `packages/evaluation/reports/` and `reports/` entries).

## A known, measured gap this harness surfaces

`@tkl/analyzer-conflicts` groups a requirement's claims purely by attribute name and
flags any attribute with more than one distinct value as a disagreement. This does not
distinguish "two different, expected list items" (e.g. acceptance criterion #1 and #2
of the same story) from "two competing answers to the same question" (e.g. two
independently-approved Jira revisions disagreeing on one criterion's wording). As a
result, **any golden-dataset ticket with more than one acceptance criterion is flagged
as conflicting today**, even with zero real disagreement.

The harness does not paper over this: `report.conflictDetection` quantifies it
(precision measurably below 1, recall of genuine conflicts still 1), and
`src/harness.test.ts` pins the exact mechanism down. This is a real finding for the
Knowledge and Traceability workstream (owner of `plugins/analyzers/conflicts`) to
address - out of scope for this package to fix directly.

## Metrics reported

| Field                    | Meaning                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `precision` / `recall`   | Coverage detection: does `numerator > 0` match the golden "covered" label? |
| `provenanceCompleteness` | Fraction of produced entities/trace links with a fully-populated `Provenance`. |
| `freshnessHours`         | Average age (hours) of dataset evidence relative to the dataset's fixed `asOf`. |
| `latencyMsP50/P95`       | Measured, in-process normalize+analyze latency per ticket on this run (not a fixture value - expect it to vary machine to machine). |
| `qaAcceptanceRate`       | Fraction of tickets that are fully covered *and* free of open conflicts. |
