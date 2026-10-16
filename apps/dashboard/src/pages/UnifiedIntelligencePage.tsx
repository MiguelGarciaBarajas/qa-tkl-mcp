import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getTklApiClient } from "../api/client";
import type {
  ArtifactCandidate,
  ArtifactResolution,
  ArtifactSource,
  EvidenceGraph,
  ReliabilityDefectIntelligenceAgentRun,
  TestRailImprovementAgentRun,
} from "../contracts/types";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";

const SOURCE_LABEL: Record<ArtifactSource, string> = {
  jira: "Jira",
  testrail: "TestRail",
  github: "GitHub",
  reportportal: "ReportPortal",
  confluence: "Confluence",
};

function displayExternalId(candidate: ArtifactCandidate): string {
  return candidate.ref.source === "testrail"
    ? `C${candidate.ref.externalId}`
    : candidate.ref.externalId;
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% match`;
}

function sourceStateClass(state: string): string {
  return ["complete", "local"].includes(state)
    ? "badge--ok"
    : state === "partial" ? "badge--warn" : "badge--muted";
}

export function UnifiedIntelligencePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const [draft, setDraft] = useState(initialQuery);
  const [resolution, setResolution] = useState<ArtifactResolution | null>(null);
  const [selected, setSelected] = useState<ArtifactCandidate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const resolve = async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getTklApiClient().resolveArtifacts(query);
      setResolution(result);
      setSelected(result.selected);
    } catch (caught) {
      setResolution(null);
      setSelected(null);
      setError(caught instanceof Error ? caught : new Error("Artifact resolution failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialQuery) void resolve(initialQuery);
    // The URL is the source of truth for deep-linked searches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = draft.trim();
    if (!query) return;
    if (query === initialQuery) {
      void resolve(query);
      return;
    }
    setSearchParams({ q: query });
  };

  const choose = (candidate: ArtifactCandidate) => {
    setSelected(candidate);
    setSearchParams({
      q: resolution?.query ?? draft.trim(),
      source: candidate.ref.source,
      type: candidate.ref.type,
      id: candidate.ref.externalId,
    });
  };

  return (
    <section>
      <PageHeader
        eyebrow="Unified quality intelligence"
        title="Search & Investigate"
        description="Start with a Jira key, TestRail case ID, ReportPortal identity, test name, or product term. TKL resolves the artifact before expanding its evidence."
        icon="search"
        summary="Local-first · Read only"
      />

      <form className="unified-search" onSubmit={submit} role="search">
        <label htmlFor="artifact-query">Find a quality artifact</label>
        <div className="unified-search__controls">
          <Icon name="search" size={20} />
          <input
            autoComplete="off"
            id="artifact-query"
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="STT-3731, C1201, rp:unique-id, or a test name"
            required
            type="search"
            value={draft}
          />
          <button className="button button--primary" disabled={loading} type="submit">
            {loading ? "Resolving…" : "Search"}
          </button>
        </div>
        <p>
          Exact identifiers are preferred. Text searches may ask you to choose between
          candidates before any additional context is loaded.
        </p>
      </form>

      {error && <p className="page__notes" role="alert">Search failed: {error.message}</p>}

      {!loading && resolution?.status === "not-found" && (
        <div className="page__empty">
          <strong>No local artifact matched “{resolution.query}”.</strong>
          <span>
            Exact Jira and TestRail identifiers are retrieved on demand when their
            connectors are available. Try a more specific identifier or test name.
          </span>
        </div>
      )}

      {resolution && resolution.candidates.length > 0 && (
        <div className="artifact-results">
          <div className="artifact-results__heading">
            <div>
              <span className="page-heading__eyebrow">Resolved candidates</span>
              <h3>
                {resolution.status === "ambiguous"
                  ? "Choose the artifact you meant"
                  : "Artifact resolved"}
              </h3>
            </div>
            <span className="badge badge--muted">
              {resolution.candidates.length} result{resolution.candidates.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="artifact-results__list">
            {resolution.candidates.map((candidate) => {
              const active = selected?.canonicalId === candidate.canonicalId;
              return (
                <button
                  aria-pressed={active}
                  className={`artifact-candidate${active ? " artifact-candidate--selected" : ""}`}
                  key={candidate.canonicalId}
                  onClick={() => choose(candidate)}
                  type="button"
                >
                  <span className="artifact-candidate__source">
                    {SOURCE_LABEL[candidate.ref.source]}
                  </span>
                  <strong>{candidate.title}</strong>
                  <span>{displayExternalId(candidate)} · {candidate.ref.type.replaceAll("-", " ")}</span>
                  <small>{confidenceLabel(candidate.confidence)}</small>
                  <Icon name="arrow-right" size={18} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selected && (
        <InvestigationSummary candidate={selected} key={selected.canonicalId} />
      )}
    </section>
  );
}

function InvestigationSummary({ candidate }: { candidate: ArtifactCandidate }) {
  const [activeTab, setActiveTab] = useState<"overview" | "evidence" | "actions">(
    "overview",
  );
  const [analysis, setAnalysis] = useState<TestRailImprovementAgentRun | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [reliability, setReliability] =
    useState<ReliabilityDefectIntelligenceAgentRun | null>(null);
  const [graph, setGraph] = useState<EvidenceGraph | null>(null);
  const canImproveTestRail = candidate.ref.source === "testrail"
    && candidate.ref.type === "test-case";
  const canAnalyzeReliability = candidate.ref.source === "reportportal"
    && candidate.ref.type === "execution"
    && Boolean(candidate.matchedIdentity);

  useEffect(() => {
    const operation = getTklApiClient().getEvidenceGraph;
    if (!operation) return;
    void operation.call(getTklApiClient(), candidate.canonicalId)
      .then(setGraph)
      .catch(() => setGraph(null));
  }, [candidate.canonicalId]);

  const improveTestCase = async () => {
    const operation = getTklApiClient().runTestRailCaseImprovementAgent;
    if (!operation) {
      setAnalysisError("TestRail case improvement is unavailable.");
      return;
    }
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      setAnalysis(await operation.call(
        getTklApiClient(),
        candidate.ref.externalId,
      ));
    } catch (caught) {
      setAnalysisError(
        caught instanceof Error ? caught.message : "TestRail case analysis failed.",
      );
    } finally {
      setAnalysisLoading(false);
    }
  };

  const analyzeReliability = async () => {
    const operation = getTklApiClient().runReportPortalReliabilityAgent;
    if (!operation || !candidate.matchedIdentity) {
      setAnalysisError("ReportPortal reliability analysis is unavailable.");
      return;
    }
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      setReliability(await operation.call(
        getTklApiClient(),
        candidate.matchedIdentity,
      ));
    } catch (caught) {
      setAnalysisError(
        caught instanceof Error ? caught.message : "Reliability analysis failed.",
      );
    } finally {
      setAnalysisLoading(false);
    }
  };

  return (
    <article className="card investigation-summary">
      <div className="investigation-summary__header">
        <div>
          <span className="page-heading__eyebrow">Investigation anchor</span>
          <h3>{candidate.title}</h3>
          <p>{SOURCE_LABEL[candidate.ref.source]} · {displayExternalId(candidate)}</p>
        </div>
        <span className="badge badge--ok">Resolved</span>
      </div>
      <div className="investigation-tabs" role="tablist" aria-label="Investigation details">
        {(["overview", "evidence", "actions"] as const).map((tab) => (
          <button
            aria-controls={`investigation-panel-${tab}`}
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "investigation-tabs__active" : ""}
            id={`investigation-tab-${tab}`}
            key={tab}
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {activeTab === "overview" && (
        <section
          aria-labelledby="investigation-tab-overview"
          id="investigation-panel-overview"
          role="tabpanel"
        >
          <dl className="investigation-summary__metadata">
            <div>
              <dt>Artifact type</dt>
              <dd>{candidate.ref.type.replaceAll("-", " ")}</dd>
            </div>
            <div>
              <dt>Match</dt>
              <dd>{candidate.match.replaceAll("-", " ")}</dd>
            </div>
            <div>
              <dt>Freshness</dt>
              <dd>
                {candidate.observedAt
                  ? new Date(candidate.observedAt).toLocaleString()
                  : "No timestamp available"}
              </dd>
            </div>
          </dl>
          <p className="investigation-summary__notice">
            Related evidence is traversed from this anchor with bounded, reviewable
            relationships. Missing links remain explicit rather than inferred as facts.
          </p>
          {candidate.sourceUrl && (
            <a
              className="button button--secondary"
              href={candidate.sourceUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open source record
              <Icon name="arrow-right" size={16} />
            </a>
          )}
        </section>
      )}
      {activeTab === "evidence" && (
        <section
          aria-labelledby="investigation-tab-evidence"
          id="investigation-panel-evidence"
          role="tabpanel"
        >
          {graph ? (
            <div className="investigation-analysis">
              <div className="investigation-analysis__heading">
                <h3>Evidence graph</h3>
                <span className="badge badge--muted">
                  {graph.nodes.length} nodes · {graph.edges.length} links
                </span>
              </div>
              {graph.nodes.length <= 1 ? (
                <p className="investigation-analysis__empty">
                  No related evidence has been linked to this artifact yet.
                </p>
              ) : (
                <ul>
                  {graph.nodes
                    .filter((node) => node.id !== graph.anchorId)
                    .map((node) => (
                      <li key={node.id}>
                        <strong>{node.title}</strong>
                        <span>{node.source ?? "derived"} · {node.type.replaceAll("-", " ")}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : (
            <p role="status">Loading related evidence…</p>
          )}
        </section>
      )}
      {activeTab === "actions" && (
        <section
          aria-labelledby="investigation-tab-actions"
          id="investigation-panel-actions"
          role="tabpanel"
        >
          <div className="investigation-actions" aria-label="Guided actions">
            {candidate.ref.source === "jira" && (
              <>
                <Link
                  className="button button--secondary"
                  to={`/insights/coverage?q=${encodeURIComponent(candidate.ref.externalId)}`}
                >
                  Review coverage
                </Link>
                <Link
                  className="button button--secondary"
                  to={`/reviews/proposals?workItemId=${encodeURIComponent(candidate.ref.externalId)}`}
                >
                  Design tests
                </Link>
              </>
            )}
            {canImproveTestRail && (
              <button
                className="button button--primary"
                disabled={analysisLoading}
                onClick={() => void improveTestCase()}
                type="button"
              >
                <Icon name="sparkles" size={16} />
                {analysisLoading ? "Analyzing case…" : "Improve test case"}
              </button>
            )}
            {canAnalyzeReliability && (
              <button
                className="button button--primary"
                disabled={analysisLoading}
                onClick={() => void analyzeReliability()}
                type="button"
              >
                <Icon name="sparkles" size={16} />
                {analysisLoading ? "Analyzing history…" : "Analyze reliability"}
              </button>
            )}
            <Link
              className="button button--secondary"
              to={`/investigate/ask?q=${encodeURIComponent(
                `What should QA know about ${displayExternalId(candidate)}?`,
              )}`}
            >
              Ask about this artifact
            </Link>
          </div>
          {analysisError && (
            <p className="page__notes" role="alert">Analysis failed: {analysisError}</p>
          )}
          {analysis && (
            <div className="investigation-analysis" aria-live="polite">
          <div className="investigation-analysis__heading">
            <h3>Test case assessment</h3>
            <span className={`badge ${
              analysis.status === "ready-for-review" ? "badge--ok" : "badge--warn"
            }`}>
              {analysis.status.replaceAll("-", " ")}
            </span>
          </div>
          <p>{analysis.summary}</p>
          {analysis.evidence.sourceStatus
            && Object.keys(analysis.evidence.sourceStatus).length > 0 && (
            <section className="source-context" aria-labelledby="source-context-heading">
              <div className="source-context__heading">
                <div>
                  <span className="page-heading__eyebrow">Connected ≠ linked</span>
                  <h4 id="source-context-heading">Evidence retrieved for this case</h4>
                </div>
                <span className="badge badge--muted">
                  {Object.values(analysis.evidence.sourceStatus)
                    .filter((status) => status.linked).length} linked
                </span>
              </div>
              <ul className="source-context__grid">
                {Object.entries(analysis.evidence.sourceStatus).map(([source, status]) => (
                  <li key={source}>
                    <div>
                      <strong>{SOURCE_LABEL[source as ArtifactSource] ?? source}</strong>
                      <span>{status.detail}</span>
                    </div>
                    <span className={`badge ${sourceStateClass(status.state)}`}>
                      {status.state.replaceAll("-", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(analysis.evidence.candidateRelationships?.length ?? 0) > 0 && (
            <details className="source-context__candidates">
              <summary>
                {analysis.evidence.candidateRelationships?.length} similar case candidate(s)
                need review
              </summary>
              <ul>
                {analysis.evidence.candidateRelationships?.map((relationship) => (
                  <li key={relationship.id}>
                    <strong>{Math.round(relationship.confidence * 100)}% similar</strong>
                    <span>
                      {relationship.toEntityId.replace("manual-test:testrail:", "C")} ·{" "}
                      {relationship.rationale}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {analysis.proposals.length === 0 ? (
            <p className="investigation-analysis__empty">
              No supported changes were proposed from the available evidence.
            </p>
          ) : (
            <ul>
              {analysis.proposals.flatMap((proposal) =>
                proposal.findings.map((finding) => (
                  <li key={`${proposal.id}:${finding.id}`}>
                    <strong>{finding.category.replaceAll("-", " ")}</strong>
                    <span>{finding.detail}</span>
                  </li>
                )))}
            </ul>
          )}
            </div>
          )}
          {reliability && (
            <div className="investigation-analysis" aria-live="polite">
          <div className="investigation-analysis__heading">
            <h3>Execution reliability</h3>
            <span className={`badge ${
              reliability.status === "ready-for-review" ? "badge--ok" : "badge--warn"
            }`}>
              {reliability.status.replaceAll("-", " ")}
            </span>
          </div>
          <p>{reliability.summary}</p>
          {reliability.analyses.length === 0 ? (
            <p className="investigation-analysis__empty">
              More independent executions are required for a grounded classification.
            </p>
          ) : (
            <ul>
              {reliability.analyses.map((item) => (
                <li key={item.identity.key}>
                  <strong>{item.classification.replaceAll("-", " ")}</strong>
                  <span>{item.rationale}</span>
                </li>
              ))}
            </ul>
          )}
            </div>
          )}
        </section>
      )}
    </article>
  );
}
