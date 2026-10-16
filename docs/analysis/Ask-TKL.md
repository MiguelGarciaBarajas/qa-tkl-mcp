# Ask TKL

Ask TKL is the Phase 7 read-only question interface for the Test Knowledge Library. It
does not answer from a language model's memory. A deterministic classifier routes each
question to one implemented, product-scoped capability:

| Intent | Capability |
|---|---|
| Coverage, change impact, unverified scope | Coverage & Context Analyst |
| New or negative manual cases | Test Designer |
| Existing TestRail case quality | TestRail Improvement |
| Repository-aware automation planning | Automation Designer |
| Repeated failures and defects | Reliability & Defect Intelligence |
| Conflicts, duplicates, mappings, staleness | Knowledge Curator |
| General product/QA lookup | Bounded canonical knowledge search |

Specialized capabilities require one exact Jira key, either in `workItemId` or in the
question. A mismatch or multiple keys causes abstention. General lookup searches at most
four derived terms and returns at most twelve canonical entities. Answers include at
most twelve deduplicated citations and three detail lines/actions.

## Trust contract

Every response includes:

- Interpreted product and Jira scope.
- Intent and read-only capabilities invoked.
- A concise answer with citation markers.
- Direct source links when present, otherwise authenticated TKL provenance links.
- Oldest/newest evidence timestamps and a 30-day freshness assessment.
- Confidence with explicit downgrade for stale evidence or open conflicts.
- Scoped conflicts, limitations, and suggested next actions.
- Explicit `abstained` or `not-found` status when support is insufficient.

The API requires `ask:read`, enforces tenant/product isolation, rate limits the
caller, and records an `ask_tkl` audit event. The orchestrator has no source client,
mutation method, external LLM, or approved-write capability.
