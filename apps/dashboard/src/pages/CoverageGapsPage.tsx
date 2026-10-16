import { type FormEvent, useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { hashSearchParam } from "../routing/hashSearchParams";

function displayJiraId(id: string): string {
  return id.replace(/^(requirement|story):/, "");
}

export function CoverageGapsPage() {
  const initialQuery = hashSearchParam("q");
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const { data, loading, error } = useAsync(
    () => getTklApiClient().getCoverageGaps(query),
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
        title="Coverage Gaps"
        description="Prioritize requirements that are missing trusted test coverage. Every result preserves its numerator, denominator and link confidence."
        icon="grid"
        summary={`${data?.filter((gap) => gap.denominator === 0 || gap.numerator / gap.denominator < 1).length ?? 0} gaps detected`}
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
        <span>Coverage is calculated for up to 8 matching Jira work items.</span>
      </form>
      {loading && <p role="status">Loading coverage gaps…</p>}
      {error && <p role="alert">Failed to load coverage gaps: {error.message}</p>}
      {!loading && !error && data?.length === 0 && (
        <div className="page__empty">
          <strong>No matching Jira work items found.</strong>
          <span>Try a Jira key such as STT-123 or words from the summary.</span>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Requirement</th>
            <th>Story</th>
            <th>Coverage</th>
            <th>Link confidence</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((gap) => {
            const ratio = gap.denominator === 0 ? 0 : gap.numerator / gap.denominator;
            const isGap = ratio < 1;
            return (
              <tr key={gap.requirementId}>
                <td>{gap.requirementTitle}</td>
                <td>{displayJiraId(gap.storyId)}</td>
                <td>
                  <span className={isGap ? "badge badge--warn" : "badge badge--ok"}>
                    {gap.numerator}/{gap.denominator}
                  </span>
                </td>
                <td>{gap.linkConfidence}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
