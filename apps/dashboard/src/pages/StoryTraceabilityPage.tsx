import { type FormEvent, useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { TicketContextStatus } from "../components/TicketContextStatus";
import { hashSearchParam } from "../routing/hashSearchParams";
import type { LinkConfidence, Provenance, TestRef, TestType } from "../contracts/types";

const CONFIDENCE_LABEL: Record<LinkConfidence, string> = {
  explicit: "Explicit",
  "inferred-high": "Inferred (high)",
  "inferred-low": "Inferred (low)",
};

const TEST_TYPE_LABEL: Record<TestType, string> = {
  manual: "Manual",
  automated: "Automated",
};

const SOURCE_LABEL: Record<Provenance["source"], string> = {
  jira: "Jira",
  github: "GitHub",
  testrail: "TestRail",
  confluence: "Confluence",
  reportportal: "ReportPortal",
};

/**
 * Reports a factual elapsed-time string for the test's last execution, or "Not yet
 * executed" when there is none. Deliberately does NOT judge freshness as stale/fresh —
 * that threshold is a product decision (see `analyze_requirement_coverage`'s
 * requirement-level freshness dimension), not something to invent per-test here.
 */
function executionFreshnessLabel(lastExecutedAt: string | null | undefined): string {
  if (lastExecutedAt === undefined) return "Unknown";
  if (lastExecutedAt === null) return "Not yet executed";
  const elapsedMs = Date.now() - new Date(lastExecutedAt).getTime();
  if (elapsedMs < 0) return `Executed ${new Date(lastExecutedAt).toLocaleString()}`;

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `Executed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Executed ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Executed ${days}d ago`;
}

function provenanceLabel(provenance: TestRef["provenance"]): string {
  return `${SOURCE_LABEL[provenance.source]} (v${provenance.sourceVersion})`;
}

function reviewLabel(reviewed: boolean | null): string {
  if (reviewed === null) return "Unknown";
  return reviewed ? "Yes" : "No";
}

function displayJiraId(id: string): string {
  return id.replace(/^(requirement|story):/, "");
}

export function StoryTraceabilityPage() {
  const initialQuery = hashSearchParam("q");
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const { data, loading, error } = useAsync(
    () => getTklApiClient().getStoryTraceability(query),
    [query],
  );

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(draftQuery.trim());
  };

  return (
    <section>
      <PageHeader
        eyebrow="Quality intelligence"
        title="Story Traceability"
        description="Follow each requirement from source evidence to manual and automated tests, execution freshness and review confidence."
        icon="route"
        summary={`${data?.length ?? 0} stories mapped`}
      />
      <form className="intelligence-search" onSubmit={search}>
        <label>
          Find a Jira ticket or epic
          <input
            aria-label="Find a Jira ticket or epic"
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search by key or title, for example STT-123"
            type="search"
            value={draftQuery}
          />
        </label>
        <button className="button button--primary" type="submit" disabled={loading}>
          <Icon name="search" size={17} />
          Search
        </button>
        <span>
          Showing up to 8 Jira work items per search. Jira boards are not collected by the current connector.
        </span>
      </form>
      <TicketContextStatus issueKey={query} />
      {loading && <p role="status">Loading story traceability…</p>}
      {error && <p role="alert">Failed to load traceability: {error.message}</p>}
      {!loading && !error && data?.length === 0 && (
        <div className="page__empty">
          <strong>No matching Jira work items found.</strong>
          <span>Try a Jira key such as STT-123 or words from the summary.</span>
        </div>
      )}
      {data?.map((story) => (
        <article key={story.storyId} className="card">
          <div className="traceability-card__heading">
            <h3>
              {displayJiraId(story.storyId)} — {story.storyTitle}
            </h3>
            <div className="traceability-card__badges">
              {story.issueType && <span className="badge badge--pending">{story.issueType}</span>}
              {story.status && <span className="badge badge--muted">{story.status}</span>}
            </div>
          </div>
          {(story.relatedRequirementCount ?? 0) > 0 && (
            <p className="page__hint">
              {story.relatedRequirementCount} related Jira work items found.
              {story.truncated
                ? ` Showing the first ${story.returnedRequirementCount}.`
                : ""}
            </p>
          )}
          {(story.relatedRequirementCount ?? 0) === 0 && story.tests.length === 0 && (
            <p className="page__notes">
              Only the Jira item itself is available. Epic hierarchy requires Jira data
              normalized with parent/epic links, while test coverage requires synchronized
              TestRail and GitHub evidence.
            </p>
          )}
          {story.requirements.length === 0 ? (
            <p className="page__empty">No canonical requirements linked yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Linked test(s)</th>
                  <th>Type</th>
                  <th>Execution freshness</th>
                  <th>Provenance</th>
                  <th>Confidence</th>
                  <th>Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {story.requirements.map((req) => {
                  const links = story.links.filter((l) => l.requirementId === req.id);
                  if (links.length === 0) {
                    return (
                      <tr key={req.id}>
                        <td>{req.title}</td>
                        <td className="page__empty">No linked test</td>
                        <td>—</td>
                        <td>—</td>
                        <td>{provenanceLabel(req.provenance)}</td>
                        <td>—</td>
                        <td>—</td>
                      </tr>
                    );
                  }
                  return links.map((link) => {
                    const test = story.tests.find((t) => t.id === link.testId);
                    return (
                      <tr key={`${req.id}-${link.testId}`}>
                        <td>{req.title}</td>
                        <td>{test?.title ?? link.testId}</td>
                        <td>{test ? TEST_TYPE_LABEL[test.type] : "—"}</td>
                        <td>{test ? executionFreshnessLabel(test.lastExecutedAt) : "—"}</td>
                        <td>{test ? provenanceLabel(test.provenance) : provenanceLabel(req.provenance)}</td>
                        <td>{CONFIDENCE_LABEL[link.confidence]}</td>
                        <td>{reviewLabel(link.reviewed)}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          )}
        </article>
      ))}
    </section>
  );
}
