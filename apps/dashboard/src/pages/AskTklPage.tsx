import { type FormEvent, useState } from "react";
import { getTklApiClient } from "../api/client";
import type { AskTklRun } from "../contracts/types";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { hashSearchParam } from "../routing/hashSearchParams";

interface Exchange {
  id: string;
  question: string;
  result: AskTklRun;
}

export function AskTklPage() {
  const [question, setQuestion] = useState(hashSearchParam("q"));
  const [workItemId, setWorkItemId] = useState(hashSearchParam("workItemId"));
  const [history, setHistory] = useState<Exchange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getTklApiClient().askTkl({
        question: trimmedQuestion,
        ...(workItemId.trim() ? { workItemId: workItemId.trim() } : {}),
      });
      setHistory((current) => [
        ...current,
        { id: result.runId, question: trimmedQuestion, result },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Ask TKL failed."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Grounded QA assistant"
        title="Ask TKL"
        description="Ask product and QA questions. Answers are deterministically assembled from authenticated, read-only TKL capabilities and abstain when evidence is missing."
        icon="search"
        summary="Phase 7 · Read only"
      />

      <div className="ask-tkl">
        <div className="ask-tkl__transcript" aria-live="polite">
          {history.length === 0 && (
            <div className="page__empty">
              <strong>Start with a grounded question</strong>
              <span>
                Try “What changed under STT-3731, which tests cover it, and what remains
                unverified?” The Jira key field is optional when the question includes it.
              </span>
            </div>
          )}
          {history.map((exchange) => (
            <div className="ask-tkl__exchange" key={exchange.id}>
              <article className="ask-tkl__message ask-tkl__message--user">
                <span>You</span>
                <p>{exchange.question}</p>
              </article>
              <AskTklAnswer result={exchange.result} />
            </div>
          ))}
        </div>

        <form className="card ask-tkl__composer" onSubmit={submit}>
          <label>
            Question
            <textarea
              aria-label="Ask TKL question"
              maxLength={2000}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask about requirements, coverage, tests, reliability, or knowledge conflicts…"
              required
              rows={4}
              value={question}
            />
          </label>
          <label>
            Jira key <span>(optional)</span>
            <input
              aria-label="Optional Jira key"
              onChange={(event) => setWorkItemId(event.target.value)}
              pattern="[A-Za-z][A-Za-z0-9_]*-[0-9]+"
              placeholder="STT-3731"
              value={workItemId}
            />
          </label>
          <button className="button button--primary" disabled={loading} type="submit">
            <Icon name="sparkles" size={17} />
            {loading ? "Consulting TKL…" : "Ask TKL"}
          </button>
          <p>
            No conversation memory, external LLM, source writes, or unsupported product
            inference is used.
          </p>
        </form>
        {error && <p role="alert">Ask TKL failed: {error.message}</p>}
      </div>
    </section>
  );
}

function AskTklAnswer({ result }: { result: AskTklRun }) {
  const statusClass = result.status === "answered" ? "badge--ok" : "badge--warn";
  const citationTarget = (citation: AskTklRun["citations"][number]) =>
    citation.sourceUrl ?? citation.href;

  return (
    <article className="ask-tkl__message ask-tkl__message--assistant">
      <div className="traceability-card__heading">
        <div>
          <span>Ask TKL</span>
          <strong>{result.intent.primary.replaceAll("-", " ")}</strong>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${statusClass}`}>{result.status.replaceAll("-", " ")}</span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>

      <p className="ask-tkl__answer">{result.answer}</p>

      <dl className="ask-tkl__metadata">
        <div>
          <dt>Scope</dt>
          <dd>{result.scope.interpretation}</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {result.freshness.status}
            {result.freshness.newestObservedAt
              ? ` · newest ${new Date(result.freshness.newestObservedAt).toLocaleString()}`
              : " · no dated evidence"}
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{result.confidence.rationale}</dd>
        </div>
        {result.evidenceMode && (
          <div>
            <dt>Evidence mode</dt>
            <dd>{result.evidenceMode.replaceAll("-", " ")}</dd>
          </div>
        )}
        {result.investigation && (
          <div>
            <dt>Investigation</dt>
            <dd>
              {result.investigation.status.replaceAll("-", " ")}
              {result.investigation.stopReason ? ` · ${result.investigation.stopReason}` : ""}
            </dd>
          </div>
        )}
      </dl>

      {result.investigation?.required && (
        <div className="ask-tkl__section ask-tkl__section--investigation">
          <h3>Investigation plan</h3>
          <ol>
            {result.investigation.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}

      {result.claims && result.claims.length > 0 && (
        <details className="ask-tkl__section ask-tkl__claims">
          <summary>Claim classification ({result.claims.length})</summary>
          <ul>
            {result.claims.map((claim, index) => (
              <li key={`${claim.type}-${claim.evidence ?? "unlinked"}-${index}`}>
                <strong>{claim.type}</strong>: {claim.text}
                {claim.evidence ? ` · evidence ${claim.evidence}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.citations.length > 0 && (
        <div className="ask-tkl__section">
          <h3>Sources</h3>
          <ol>
            {result.citations.map((citation) => (
              <li key={citation.id}>
                <a href={citationTarget(citation)} rel="noreferrer" target="_blank">
                  [{citation.id}] {citation.source}:{citation.sourceId}
                </a>
                <span>
                  version {citation.sourceVersion} · observed{" "}
                  {new Date(citation.observedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.conflicts.length > 0 && (
        <div className="ask-tkl__section ask-tkl__section--warning">
          <h3>Open conflicts</h3>
          <ul>
            {result.conflicts.map((conflict) => (
              <li key={conflict.id}>{conflict.entityId}: {conflict.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {result.limitations.length > 0 && (
        <div className="ask-tkl__section ask-tkl__section--warning">
          <h3>Limitations</h3>
          <ul>{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}

      {result.nextActions.length > 0 && (
        <div className="ask-tkl__section">
          <h3>Suggested next action</h3>
          <ul>{result.nextActions.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      )}

      <details className="agent-result__evidence">
        <summary>Read-only capabilities used ({result.toolCalls.length})</summary>
        <ul>
          {result.toolCalls.map((tool, index) => (
            <li key={`${tool.capability}-${index}`}>
              <strong>{tool.capability}</strong>: {tool.summary}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
