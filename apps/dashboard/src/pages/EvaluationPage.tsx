import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { PageHeader } from "../components/PageHeader";

export function EvaluationPage() {
  const { data, loading, error } = useAsync(() => getTklApiClient().getEvaluationMetrics());

  const metrics: Array<{ label: string; value: string }> = data ? [
    { label: "Dataset version", value: data.datasetVersion },
    { label: "Ticket count", value: String(data.ticketCount) },
    { label: "Precision", value: `${(data.precision * 100).toFixed(0)}%` },
    { label: "Recall", value: `${(data.recall * 100).toFixed(0)}%` },
    { label: "Provenance completeness", value: `${(data.provenanceCompleteness * 100).toFixed(0)}%` },
    { label: "Freshness", value: `${data.freshnessHours.toFixed(1)}h` },
    { label: "Latency p50", value: `${data.latencyMsP50.toFixed(1)}ms` },
    { label: "Latency p95", value: `${data.latencyMsP95.toFixed(1)}ms` },
    { label: "QA acceptance rate", value: `${(data.qaAcceptanceRate * 100).toFixed(0)}%` },
  ] : [];

  return (
    <section>
      <PageHeader
        eyebrow="Model quality"
        title="Evaluation"
        description="Measure knowledge quality against the committed golden dataset. Every metric represents a reproducible run, not an estimated improvement."
        icon="chart"
        summary={data ? `Dataset ${data.datasetVersion}` : "Golden dataset"}
      />
      <p className="page__notes">
        These metrics evaluate the normalization and analysis pipeline against 25
        reviewed synthetic FL Titling scenarios. They do not claim that live Jira,
        TestRail, GitHub, or ReportPortal data is complete.
      </p>
      {loading && <p role="status">Loading evaluation metrics…</p>}
      {error && <p role="alert">Failed to load evaluation metrics: {error.message}</p>}
      {data && (
        <div className="metrics-grid">
          {metrics.map((m) => (
            <div key={m.label} className="metrics-grid__item">
              <span className="metrics-grid__value">{m.value}</span>
              <span className="metrics-grid__label">{m.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
