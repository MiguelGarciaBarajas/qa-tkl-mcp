import type { CanonicalEntity, Provenance, TraceLink } from "@tkl/contracts";

/**
 * Pure, dependency-free scoring functions used by the evaluation harness
 * (`@tkl/evaluation`). Kept separate from `harness.ts` so the math itself can be unit
 * tested without loading fixtures or running normalizers/analyzers.
 *
 * Owner: Clemente Herrera (Dashboard and Evaluation).
 */

export interface CoveragePrediction {
  ticketKey: string;
  expectedCovered: boolean;
  actualCovered: boolean;
}

export interface ConfusionCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

/** Classifies each prediction against its ground-truth label into a 2x2 confusion matrix. */
export function confusionCounts(predictions: CoveragePrediction[]): ConfusionCounts {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const { expectedCovered, actualCovered } of predictions) {
    if (expectedCovered && actualCovered) truePositives += 1;
    else if (!expectedCovered && actualCovered) falsePositives += 1;
    else if (expectedCovered && !actualCovered) falseNegatives += 1;
    else trueNegatives += 1;
  }

  return { truePositives, falsePositives, falseNegatives, trueNegatives };
}

/** Precision/recall from a confusion matrix. Returns 1 for a metric with no positive denominator (vacuously true). */
export function precisionRecall(counts: ConfusionCounts): { precision: number; recall: number } {
  const { truePositives, falsePositives, falseNegatives } = counts;
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    precision: precisionDenominator === 0 ? 1 : truePositives / precisionDenominator,
    recall: recallDenominator === 0 ? 1 : truePositives / recallDenominator,
  };
}

/** Fraction of provenance records that carry every field required to reconstruct "who/what/when produced this". */
export function provenanceCompleteness(provenanceRecords: Provenance[]): number {
  if (provenanceRecords.length === 0) return 1;
  const requiredFields: Array<keyof Provenance> = [
    "source",
    "sourceId",
    "sourceVersion",
    "contentHash",
    "observedAt",
    "normalizerId",
    "normalizerVersion",
  ];
  const complete = provenanceRecords.filter((provenance) =>
    requiredFields.every((field) => {
      const value = provenance[field];
      return typeof value === "string" && value.length > 0;
    }),
  );
  return complete.length / provenanceRecords.length;
}

/** Average age, in hours, of a set of observation timestamps relative to a fixed reference instant. */
export function averageFreshnessHours(observedAtTimestamps: string[], asOf: string): number {
  if (observedAtTimestamps.length === 0) return 0;
  const reference = Date.parse(asOf);
  const totalHours = observedAtTimestamps.reduce((sum, timestamp) => {
    const ageMs = reference - Date.parse(timestamp);
    return sum + ageMs / (1000 * 60 * 60);
  }, 0);
  return totalHours / observedAtTimestamps.length;
}

/** Linear-interpolation-free (nearest-rank) percentile, sufficient for small evaluation batches. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

export interface QaAcceptanceInput {
  fullyCovered: boolean;
  hasOpenConflict: boolean;
}

/** Fraction of tickets a QA reviewer would accept outright: fully covered and free of unresolved conflicts. */
export function qaAcceptanceRate(inputs: QaAcceptanceInput[]): number {
  if (inputs.length === 0) return 1;
  const accepted = inputs.filter((input) => input.fullyCovered && !input.hasOpenConflict);
  return accepted.length / inputs.length;
}

/** Collects every distinct provenance record attached to a set of entities and trace links. */
export function collectProvenance(entities: CanonicalEntity[], traceLinks: TraceLink[]): Provenance[] {
  return [...entities.map((entity) => entity.provenance), ...traceLinks.map((link) => link.provenance)];
}
