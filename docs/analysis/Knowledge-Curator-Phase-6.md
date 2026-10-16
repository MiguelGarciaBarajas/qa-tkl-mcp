# Phase 6 Knowledge Curator

## Purpose

The Knowledge Curator turns canonical quality-knowledge anomalies into reviewable
proposals. It does not publish knowledge, resolve conflicts, merge entities, or edit
source systems.

## Request and scope

`POST /v1/agents/knowledge-curator/runs?productId=<id>`

```json
{
  "workItemId": "STT-123"
}
```

The API validates the Jira key, authenticates the tenant/product, and requires
`conflicts:read`. The knowledge service locates that Jira requirement and follows only
canonical `contains` links beneath it. Connected tests and trace links become the scoped
review set. A bounded same-product candidate set is used only for comparison; candidates
from another product or tenant are never visible.

## Findings and proposals

The result distinguishes observations from proposed review actions:

| Finding | Proposed review | Automatic behavior |
|---|---|---|
| Open conflict | Compare cited claims and, only when safe, preview approved/rejected statuses | None |
| Duplicate entity | Select a survivor/alias strategy after provenance and lifecycle review | None |
| Duplicate intent | Retain, rewrite, or consolidate intent while preserving both evidence histories | None |
| Missing trace link | Review a proposed inferred mapping or repair a missing explicit endpoint | None |
| Stale claim/business rule | Retain, update from current evidence, or reject after owner review | None |

Each proposal includes:

- Exact product and Jira hierarchy scope.
- Entity, claim, and evidence IDs.
- Full available provenance (`source`, source ID/version, content hash, observation time,
  and normalizer identity/version).
- Confidence and rationale.
- Before/after or action preview.
- Known limitations.
- `approval.required: true` and reviewer role `knowledge-reviewer`.

## Conservative rules

- Multi-valued attributes such as acceptance criteria and labels never get an
  automatically preferred conflict winner.
- A scalar current-version claim may be shown as a medium-confidence review suggestion
  only when it is the sole current claim and every conflicting claim came from the same
  source.
- Duplicate and mapping candidates use symmetric Jaccard token similarity. Titles and
  intent profiles are normalized once, and subset text is not treated as a perfect match.
  Similarity does not establish semantic equivalence.
- Findings may compare hierarchy requirements with same-product candidates, but only the
  exact IDs in `scopeRequirementIds` can anchor a finding. Connected neighbors cannot
  expand the finding scope.
- Staleness defaults to 180 days from the run timestamp. It indicates review age only,
  not incorrectness.
- Unsupported or ambiguous evidence produces `abstain`.
- Candidate entities, claims, links, and findings are bounded deterministically. A run
  performs at most 10,000 similarity comparisons, and any evidence or analysis truncation
  is disclosed in `limitations`.

## Read-only guarantee and audit

The agent receives a read context and returns plain proposal data. It has no store writer,
source client, conflict-review call, or approved-write capability. API execution uses the
standard `api.request` audit event with operation `run_knowledge_curator_agent`, product,
subject, outcome, status, correlation ID, and duration. The audit event does not contain
claim values or credentials.

The existing `POST /v1/knowledge/conflicts/review` route remains a separate explicit human
workflow. Running the curator cannot invoke it.
