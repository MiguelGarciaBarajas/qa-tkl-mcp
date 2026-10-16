import { useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { PageHeader } from "../components/PageHeader";
import type { ConflictStatus, KnowledgeConflict } from "../contracts/types";

const STATUS_LABEL: Record<ConflictStatus, string> = {
  open: "Open",
  reviewed: "Reviewed",
};

const STATUS_CLASS: Record<ConflictStatus, string> = {
  open: "badge badge--warn",
  reviewed: "badge badge--ok",
};

interface ReviewDraft {
  approvedClaimIds: Set<string>;
  note: string;
}

function emptyDraft(): ReviewDraft {
  return { approvedClaimIds: new Set(), note: "" };
}

export function ConflictsPage() {
  const { data, loading, error } = useAsync(() => getTklApiClient().getKnowledgeConflicts());
  /**
   * Reviewed conflicts are layered on top of the fetched data instead of copied into local
   * state via an effect, so a submitted review is reflected immediately without triggering
   * an extra render pass or risking staleness against a later refetch of `data`.
   */
  const [reviewedOverrides, setReviewedOverrides] = useState<Record<string, KnowledgeConflict>>({});
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});

  if (loading) return <p>Loading knowledge conflicts…</p>;
  if (error) return <p role="alert">Failed to load conflicts: {error.message}</p>;

  const conflicts = (data ?? []).map((conflict) => reviewedOverrides[conflict.id] ?? conflict);

  const draftFor = (conflict: KnowledgeConflict): ReviewDraft => drafts[conflict.id] ?? emptyDraft();

  function updateDraft(conflictId: string, update: (draft: ReviewDraft) => ReviewDraft) {
    setDrafts((current) => ({ ...current, [conflictId]: update(current[conflictId] ?? emptyDraft()) }));
  }

  function toggleClaim(conflictId: string, claimId: string) {
    updateDraft(conflictId, (draft) => {
      const approvedClaimIds = new Set(draft.approvedClaimIds);
      if (approvedClaimIds.has(claimId)) approvedClaimIds.delete(claimId);
      else approvedClaimIds.add(claimId);
      return { ...draft, approvedClaimIds };
    });
  }

  function setNote(conflictId: string, note: string) {
    updateDraft(conflictId, (draft) => ({ ...draft, note }));
  }

  async function submitReview(conflict: KnowledgeConflict) {
    const draft = draftFor(conflict);
    const approvedClaimIds = [...draft.approvedClaimIds];
    if (approvedClaimIds.length === 0) {
      setReviewErrors((current) => ({
        ...current,
        [conflict.id]: "Select at least one claim to approve before submitting a review.",
      }));
      return;
    }

    setSubmittingId(conflict.id);
    setReviewErrors((current) => {
      const next = { ...current };
      delete next[conflict.id];
      return next;
    });

    try {
      const reviewed = await getTklApiClient().reviewKnowledgeConflict({
        conflictId: conflict.id,
        approvedClaimIds,
        note: draft.note.trim() ? draft.note.trim() : undefined,
      });
      setReviewedOverrides((current) => ({ ...current, [reviewed.id]: reviewed }));
      setDrafts((current) => {
        const next = { ...current };
        delete next[conflict.id];
        return next;
      });
    } catch (submitError) {
      setReviewErrors((current) => ({
        ...current,
        [conflict.id]: submitError instanceof Error ? submitError.message : "Failed to submit the review.",
      }));
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <section>
      <PageHeader
        eyebrow="Human governance"
        title="Knowledge Conflicts"
        description="Resolve contradictory source claims with an explicit, durable human decision. Reviewed conflicts remain immutable."
        icon="warning"
        summary={`${conflicts.filter((conflict) => conflict.status === "open").length} awaiting review`}
      />
      {conflicts.length === 0 && <p className="page__empty">No open conflicts.</p>}
      {conflicts.map((conflict) => {
        const draft = draftFor(conflict);
        const isReviewed = conflict.status === "reviewed";
        const isSubmitting = submittingId === conflict.id;
        const reviewError = reviewErrors[conflict.id];

        return (
          <article key={conflict.id} className="card">
            <h3>{conflict.entityTitle}</h3>
            <p>{conflict.description}</p>
            <p className="page__hint">Detected {new Date(conflict.detectedAt).toLocaleString()}</p>
            <div className="conflict__actions">
              <span className={STATUS_CLASS[conflict.status]}>{STATUS_LABEL[conflict.status]}</span>
            </div>
            {!isReviewed && (
              <div className="conflict__review">
                <p className="page__hint">Select the claim(s) that should be approved:</p>
                <ul>
                  {conflict.claimIds.map((claimId) => (
                    <li key={claimId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={draft.approvedClaimIds.has(claimId)}
                          disabled={isSubmitting}
                          onChange={() => toggleClaim(conflict.id, claimId)}
                        />
                        {claimId}
                      </label>
                    </li>
                  ))}
                </ul>
                <label>
                  Note (optional)
                  <textarea
                    value={draft.note}
                    disabled={isSubmitting}
                    onChange={(event) => setNote(conflict.id, event.target.value)}
                  />
                </label>
                <button className="button button--primary" disabled={isSubmitting} onClick={() => submitReview(conflict)}>
                  {isSubmitting ? "Submitting…" : "Submit review"}
                </button>
                {reviewError && <p role="alert">{reviewError}</p>}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
