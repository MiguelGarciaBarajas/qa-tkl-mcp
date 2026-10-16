import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import { JiraNormalizer } from "@tkl/normalizer-jira";
import { GitHubNormalizer } from "@tkl/normalizer-github";
import { CoverageAnalyzer } from "@tkl/analyzer-coverage";
import { ConflictAnalyzer } from "@tkl/analyzer-conflicts";
import { loadGoldenDataset, type GoldenTicket } from "./goldenDataset.ts";
import {
  averageFreshnessHours,
  confusionCounts,
  percentile,
  precisionRecall,
  provenanceCompleteness,
  qaAcceptanceRate,
  type CoveragePrediction,
} from "./metrics.ts";
import type { EvaluationMetrics } from "./types.ts";
import type { Provenance } from "@tkl/contracts";

/**
 * Runs the golden dataset through the real Jira/GitHub normalizers and
 * coverage/conflict analyzers (the actual Knowledge and Traceability pipeline, not the
 * dashboard's temporary mocks) and scores the result against the hand-labeled expected
 * outcomes committed alongside each fixture.
 *
 * Per the Definition of Done, results must be repeatable from committed fixtures: every
 * non-timing field is a deterministic function of the golden dataset. Per-ticket
 * processing latency is genuinely measured on this run and will vary machine to
 * machine - it is reported, not asserted, for that reason.
 *
 * Owner: Clemente Herrera (Dashboard and Evaluation).
 */

const CONFLICT_DETECTION_TIME = () => "2026-09-15T00:00:00.000Z";

export interface TicketResult {
  ticketKey: string;
  category: string;
  expectedCovered: boolean;
  actualCovered: boolean;
  denominator: number;
  numerator: number;
  linkConfidence: number;
  expectedConflict: boolean;
  actualConflict: boolean;
  latencyMs: number;
}

export interface EvaluationReport {
  metrics: EvaluationMetrics;
  ticketResults: TicketResult[];
  /**
   * Precision/recall of the conflict analyzer's `open` conflict flag versus the golden
   * labels, tracked separately from `metrics` (which mirrors the dashboard's existing
   * `EvaluationMetrics` shape). Kept apart because the current `@tkl/analyzer-conflicts`
   * implementation has a known, measured false-positive gap: it treats any attribute
   * with more than one distinct value - including legitimately multi-valued attributes
   * such as a story's list of acceptance criteria - as a disagreement. That means any
   * golden-dataset ticket with more than one acceptance criterion is flagged as
   * conflicting even when there is no real disagreement. This is a genuine finding for
   * the Knowledge and Traceability workstream, not a dataset defect - do not "fix" it by
   * quietly shrinking every fixture to one acceptance criterion.
   */
  conflictDetection: { precision: number; recall: number };
}

/** Normalizes a single ticket's fixtures into a fresh, isolated knowledge store and returns its provenance records. */
async function normalizeTicket(
  ticket: GoldenTicket,
): Promise<{ store: InMemoryKnowledgeStore; provenance: Provenance[] }> {
  const store = new InMemoryKnowledgeStore();
  const jiraNormalizer = new JiraNormalizer();
  const githubNormalizer = new GitHubNormalizer();
  const provenance: Provenance[] = [];

  for (const record of ticket.jiraRecords) {
    const normalized = await jiraNormalizer.normalize(record);
    for (const entity of normalized.entities) {
      store.addEntity(entity);
      provenance.push(entity.provenance);
    }
    // Simulate human review approving claims produced from explicit Jira fields, as the
    // shared contract test does - this is what makes them visible to the coverage
    // analyzer's `getApprovedClaims` and eligible for conflict detection.
    for (const claim of normalized.claims) store.addClaim({ ...claim, status: "approved" });
  }

  for (const record of ticket.githubRecords) {
    const normalized = await githubNormalizer.normalize(record);
    for (const entity of normalized.entities) {
      store.addEntity(entity);
      provenance.push(entity.provenance);
    }
    for (const link of normalized.traceLinks) {
      store.addTraceLink(link);
      provenance.push(link.provenance);
    }
  }

  return { store, provenance };
}

async function evaluateTicket(ticket: GoldenTicket): Promise<{ result: TicketResult; provenance: Provenance[] }> {
  const startedAt = performance.now();

  const { store, provenance } = await normalizeTicket(ticket);

  const coverage = await new CoverageAnalyzer().analyze({ store, requirementId: ticket.requirementId });
  const conflicts = await new ConflictAnalyzer().analyze({
    store,
    entityId: ticket.requirementId,
    now: CONFLICT_DETECTION_TIME,
  });

  const latencyMs = performance.now() - startedAt;

  const result: TicketResult = {
    ticketKey: ticket.key,
    category: ticket.category,
    expectedCovered: ticket.expected.expectedCovered,
    actualCovered: coverage.numerator > 0,
    denominator: coverage.denominator,
    numerator: coverage.numerator,
    linkConfidence: coverage.linkConfidence,
    expectedConflict: ticket.expected.expectedConflict,
    actualConflict: conflicts.length > 0,
    latencyMs,
  };

  return { result, provenance };
}

/** Runs the full golden dataset through the real pipeline and computes aggregate `EvaluationMetrics`. */
export async function runEvaluation(): Promise<EvaluationReport> {
  const { manifest, tickets } = loadGoldenDataset();

  const ticketResults: TicketResult[] = [];
  const allProvenance: Provenance[] = [];
  const observedAtTimestamps: string[] = [];

  for (const ticket of tickets) {
    for (const record of ticket.jiraRecords) observedAtTimestamps.push(record.observedAt);
    for (const record of ticket.githubRecords) observedAtTimestamps.push(record.observedAt);

    const { result, provenance } = await evaluateTicket(ticket);
    ticketResults.push(result);
    allProvenance.push(...provenance);
  }

  const predictions: CoveragePrediction[] = ticketResults.map((r) => ({
    ticketKey: r.ticketKey,
    expectedCovered: r.expectedCovered,
    actualCovered: r.actualCovered,
  }));
  const { precision, recall } = precisionRecall(confusionCounts(predictions));

  const conflictPredictions: CoveragePrediction[] = ticketResults.map((r) => ({
    ticketKey: r.ticketKey,
    expectedCovered: r.expectedConflict,
    actualCovered: r.actualConflict,
  }));
  const conflictDetection = precisionRecall(confusionCounts(conflictPredictions));

  const latencies = ticketResults.map((r) => r.latencyMs);

  const metrics: EvaluationMetrics = {
    datasetVersion: manifest.datasetVersion,
    ticketCount: tickets.length,
    precision,
    recall,
    provenanceCompleteness: provenanceCompleteness(allProvenance),
    freshnessHours: averageFreshnessHours(observedAtTimestamps, manifest.asOf),
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    qaAcceptanceRate: qaAcceptanceRate(
      ticketResults.map((r) => ({
        fullyCovered: r.numerator >= r.denominator,
        hasOpenConflict: r.actualConflict,
      })),
    ),
  };

  return { metrics, ticketResults, conflictDetection };
}
