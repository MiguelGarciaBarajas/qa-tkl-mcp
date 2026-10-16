import { useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { PageHeader } from "../components/PageHeader";
import type {
  KnowledgeInventory,
  KnowledgeInventoryGapSeverity,
} from "../contracts/types";

const SEVERITY_CLASS: Record<KnowledgeInventoryGapSeverity, string> = {
  high: "badge badge--error",
  medium: "badge badge--warn",
  low: "badge badge--muted",
};

function num(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function percent(ratio: number | null | undefined): string {
  return typeof ratio === "number" ? `${(ratio * 100).toFixed(0)}%` : "—";
}

function timestamp(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "never";
}

export function KnowledgeInventoryPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync<KnowledgeInventory>(
    () => getTklApiClient().getKnowledgeInventory(),
    [refreshKey],
  );

  if (loading && !data) return <p role="status">Loading knowledge inventory…</p>;
  if (error) {
    return (
      <p role="alert">Failed to load knowledge inventory: {error.message}</p>
    );
  }
  if (!data) {
    return (
      <section>
        <PageHeader
          eyebrow="Intelligence"
          title="Knowledge Inventory"
          description="One aggregate view of collected evidence, canonical knowledge, mapping quality, pipeline health, and actionable gaps."
          icon="database"
          summary="No inventory available"
        />
        <div className="page__empty">
          <strong>No knowledge inventory is available yet.</strong>
          <span>Connect and synchronize a source to begin building durable workspace knowledge.</span>
          <a className="button button--primary" href="#/source-connections">Configure sources</a>
        </div>
      </section>
    );
  }

  const { collectedEvidence, canonicalKnowledge, coverage, pipeline, syncStatus } = data;
  const summaryParts = [
    `${num(collectedEvidence.totalRetainedRecords)} retained`,
    `${num(canonicalKnowledge.entities.total)} entities`,
    data.meta.partial ? "partial" : "complete",
  ];

  const summaryCards: Array<{ label: string; value: string }> = [
    { label: "Retained evidence (Bronze)", value: num(collectedEvidence.totalRetainedRecords) },
    { label: "Canonical entities (Silver)", value: num(canonicalKnowledge.entities.total) },
    { label: "Mapped coverage", value: percent(coverage.mappedCoverageRatio) },
    { label: "Open conflicts", value: num(canonicalKnowledge.conflicts.open) },
    {
      label: "Serving (Gold) status",
      value:
        pipeline.servingCurrent === null
          ? "—"
          : pipeline.servingCurrent
            ? "Current"
            : `Backlog ${num(pipeline.servingProjectionBacklog)}`,
    },
    { label: "Dead-letter records", value: num(pipeline.rawDeadLetterBacklog) },
  ];

  const syncBySource = new Map(syncStatus.sources.map((entry) => [entry.source, entry]));

  return (
    <section>
      <PageHeader
        eyebrow="Intelligence"
        title="Knowledge Inventory"
        description="One aggregate view of collected evidence, canonical knowledge, mapping quality, pipeline health, and actionable gaps. All counts are bounded aggregates over durable stores."
        icon="database"
        summary={summaryParts.join(" · ")}
      />

      <p className="page__notes" role="note">
        Generated {timestamp(data.meta.generatedAt)}.{" "}
        {data.meta.partial
          ? "Some tiers are unavailable — figures below are partial and flagged, never fabricated zeros."
          : "All tiers reported successfully."}{" "}
        <button
          type="button"
          className="button"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          Refresh
        </button>
      </p>

      <div className="metrics-grid">
        {summaryCards.map((card) => (
          <div key={card.label} className="metrics-grid__item">
            <span className="metrics-grid__value">{card.value}</span>
            <span className="metrics-grid__label">{card.label}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Source Inventory (Bronze)</h3>
        <p className="page__hint">
          Retained raw evidence per source and its freshness. This is durable, retained
          knowledge — distinct from the recent runtime activity on Connector Health.
        </p>
        {collectedEvidence.available ? (
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Retained records</th>
                <th>Last observed</th>
                <th>Connection</th>
                <th>Last successful sync</th>
              </tr>
            </thead>
            <tbody>
              {collectedEvidence.bySource.length === 0 && (
                <tr>
                  <td colSpan={5}>No raw evidence has been retained yet.</td>
                </tr>
              )}
              {collectedEvidence.bySource.map((row) => {
                const sync = syncBySource.get(row.source);
                return (
                  <tr key={row.source}>
                    <td>{row.source}</td>
                    <td>{num(row.retainedRecords)}</td>
                    <td>{timestamp(row.lastObservedAt)}</td>
                    <td>{sync ? sync.status : "unknown"}</td>
                    <td>{sync ? timestamp(sync.lastSuccessfulSyncAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="page__notes" role="status">
            Collected-evidence inventory is unavailable in this deployment.
          </p>
        )}
        <p className="page__hint">
          Pending projection to canonical: <strong>{num(collectedEvidence.pendingProjection.total)}</strong>{" "}
          (store-wide, not attributable to one source). Dead-lettered:{" "}
          <strong>{num(collectedEvidence.deadLetter.total)}</strong>
          {collectedEvidence.deadLetter.bySource.length > 0 && (
            <>
              {" "}(
              {collectedEvidence.deadLetter.bySource
                .map((entry) => `${entry.source}: ${entry.count}`)
                .join(", ")}
              )
            </>
          )}
          .
        </p>
      </div>

      <div className="card">
        <h3>Canonical Knowledge (Silver)</h3>
        {canonicalKnowledge.available ? (
          <>
            <div className="metrics-grid">
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.entities.total)}</span>
                <span className="metrics-grid__label">Entities</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.claims.total)}</span>
                <span className="metrics-grid__label">Claims</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.traceLinks.total)}</span>
                <span className="metrics-grid__label">Trace links</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.traceLinks.deferred)}</span>
                <span className="metrics-grid__label">Deferred links</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.conflicts.open)}</span>
                <span className="metrics-grid__label">Open conflicts</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(canonicalKnowledge.reviews.total)}</span>
                <span className="metrics-grid__label">Reviews</span>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Entity type</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(canonicalKnowledge.entities.byType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => (
                    <tr key={type}>
                      <td>{type}</td>
                      <td>{num(count)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="page__hint">
              Claims by status:{" "}
              {Object.entries(canonicalKnowledge.claims.byStatus)
                .map(([status, count]) => `${status} ${count}`)
                .join(" · ") || "none"}
              .
            </p>
          </>
        ) : (
          <p className="page__notes" role="status">
            Canonical knowledge metrics are unavailable for this product.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Coverage &amp; Mapping</h3>
        {coverage.available ? (
          <>
            <div className="metrics-grid">
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(coverage.requirementTotal)}</span>
                <span className="metrics-grid__label">Requirements + stories</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{percent(coverage.manualCoverageRatio)}</span>
                <span className="metrics-grid__label">Manual coverage</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{percent(coverage.automationCoverageRatio)}</span>
                <span className="metrics-grid__label">Automation coverage</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(coverage.withNeither)}</span>
                <span className="metrics-grid__label">No test mapped</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">{num(coverage.unmappedTests)}</span>
                <span className="metrics-grid__label">Unmapped tests</span>
              </div>
              <div className="metrics-grid__item">
                <span className="metrics-grid__value">
                  {coverage.averageVerifyLinkConfidence === null
                    ? "—"
                    : coverage.averageVerifyLinkConfidence.toFixed(2)}
                </span>
                <span className="metrics-grid__label">Avg verify-link confidence</span>
              </div>
            </div>
            <p className="page__hint">
              <strong>Numerator:</strong> {coverage.model.numerator}{" "}
              <strong>Denominator:</strong> {coverage.model.denominator}{" "}
              <strong>Trust signal:</strong> {coverage.model.trustSignal}{" "}
              {coverage.model.confidenceThresholdNote}
            </p>
          </>
        ) : (
          <p className="page__notes" role="status">
            Coverage metrics are unavailable for this product.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Actionable Gaps</h3>
        {data.actionableGaps.length === 0 ? (
          <p className="page__notes" role="status">
            No actionable gaps detected across the reported tiers.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Gap</th>
                <th>Count</th>
                <th>Recommended action</th>
              </tr>
            </thead>
            <tbody>
              {data.actionableGaps.map((gap) => (
                <tr key={gap.id}>
                  <td>
                    <span className={SEVERITY_CLASS[gap.severity]}>{gap.severity}</span>
                  </td>
                  <td>{gap.title}</td>
                  <td>{num(gap.count)}</td>
                  <td>{gap.recommendedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Pipeline Status</h3>
        <div className="metrics-grid">
          <div className="metrics-grid__item">
            <span className="metrics-grid__value">
              {pipeline.servingCurrent === null ? "—" : pipeline.servingCurrent ? "Current" : "Behind"}
            </span>
            <span className="metrics-grid__label">Serving (Gold)</span>
          </div>
          <div className="metrics-grid__item">
            <span className="metrics-grid__value">{num(pipeline.servingProjectionBacklog)}</span>
            <span className="metrics-grid__label">Serving backlog</span>
          </div>
          <div className="metrics-grid__item">
            <span className="metrics-grid__value">{num(pipeline.rawProjectionBacklog)}</span>
            <span className="metrics-grid__label">Raw → canonical backlog</span>
          </div>
          <div className="metrics-grid__item">
            <span className="metrics-grid__value">{num(pipeline.rawDeadLetterBacklog)}</span>
            <span className="metrics-grid__label">Dead-letter backlog</span>
          </div>
        </div>
        <p className="page__hint">{syncStatus.note}</p>
      </div>

      <div className="card">
        <h3>Notes &amp; limitations</h3>
        <ul className="page__notes">
          {[...data.meta.notes, ...data.meta.limitations].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
