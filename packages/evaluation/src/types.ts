/**
 * Aggregate evaluation report shape. Intentionally identical to the `EvaluationMetrics`
 * type the dashboard app (`apps/dashboard/src/contracts/types.ts`) already renders on
 * its Evaluation page from mock data, so a future wiring change only needs to swap the
 * data source, not the shape.
 *
 * Owner: Clemente Herrera (Dashboard and Evaluation).
 */
export interface EvaluationMetrics {
  datasetVersion: string;
  ticketCount: number;
  precision: number;
  recall: number;
  provenanceCompleteness: number;
  freshnessHours: number;
  latencyMsP50: number;
  latencyMsP95: number;
  qaAcceptanceRate: number;
}
