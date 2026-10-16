# Knowledge Inventory / Quality Overview

The **Knowledge Inventory** (also surfaced as *Quality Overview*) is a single, bounded,
aggregate-only intelligence snapshot for one tenant/product scope. It answers "what do we
actually have, how good is it, and what should we fix next?" without loading raw payloads or
scanning full corpora, and **without contacting or synchronizing any source** (including
TestRail and ReportPortal).

- **API:** `GET /v1/intelligence/knowledge-inventory?productId=<id>[&source=<source>]`
- **Permission:** `knowledge:read` (tenant + product scoped, same as other read views).
- **Contract:** `knowledge_inventory` (see `packages/contracts/src/index.js`).
- **Service:** `apps/api/src/knowledge-inventory-service.js` composes durable stores through
  their *count/metadata* primitives only.
- **Dashboard:** Intelligence → **Knowledge Inventory**.

## Why this exists

Connector Health's **Records (24h)** is current-process / recent runtime sync activity. It is
**not** total retained knowledge and must never be read as inventory. A zero there does not
imply data loss and does not by itself justify a resync — the durable Bronze/Silver/Gold
stores retain knowledge across process restarts. This view reports the durable totals so
runtime health and durable inventory are never conflated.

## Bounded-by-design

The aggregate is built to stay bounded on the active ~3 GB corpus:

- **Canonical (Silver):** one `KnowledgeStore.inventorySummary()` call runs only indexed
  `COUNT`/`GROUP BY` queries (`packages/knowledge-store` — `SqliteKnowledgeStore`). No entity,
  claim, trace-link, review, or payload body is materialized.
- **Collected evidence (Bronze):** `RawEvidenceStore.sourceInventory()` does one pass over
  durable index fields (`source`, `observedAt`, `connectorId`) — never `listRecords()` and
  never a payload decrypt. Backlogs use `countPendingProjectionRecords()` /
  `countDeadLetterProjectionRecords()`, and dead-letter attribution uses the bounded
  `listDeadLetterProjectionRecords(limit)` metadata (truncation is reported, not hidden).
- The service **never** calls `listRecords()` or any unbounded list API. This is enforced by
  a test (`apps/api/test/knowledge-inventory.test.js` — "does not call unbounded raw list
  APIs for large paths").

## Reported tiers

1. **Collected evidence (Bronze):** retained raw records per source, first/last observed
   freshness, connectors, store-wide pending-projection total, and dead-letter total with
   per-connector attribution where available.
2. **Canonical knowledge (Silver):** entity counts by type; claim counts by status; trace
   link total, per-type, and deferred; total and open conflicts; review count; entity
   provenance grouped by source.
3. **Coverage / mapping quality:** see the exact model below.
4. **Pipeline status (Gold + backlogs):** serving-projection backlog and whether serving is
   current; raw→canonical projection backlog; dead-letter backlog.
5. **Sync status:** connected-source runtime status and last successful sync, explicitly
   labeled as runtime health, not durable inventory.
6. **Actionable gaps:** severity-ranked categories with counts and a recommended next action
   (missing tests, missing automation, unmapped tests, unresolved conflicts, deferred links,
   projection/serving backlog, dead-letter, stale/errored source).
7. **Meta:** `generatedAt`, `partial`, `truncated`, `notes`, and `limitations`.

## Coverage / mapping model (exact semantics)

Coverage is measured only over canonical **requirement + story** entities.

- **Denominator:** all canonical requirement + story entities in the product scope.
- **Numerator (mapped):** a requirement/story linked by **at least one explicit-origin
  `verifies` trace link** from a matching test entity.
  - **Manual coverage:** the verifying test entity has type `manual-test`.
  - **Automation coverage:** the verifying test entity has type `test`, *or* a `manual-test`
    that itself has an explicit `relates_to` link to a `test`.
- **Trust signal:** trace link `origin === "explicit"` — the same signal the
  `@tkl/analyzer-coverage` per-requirement analyzer uses.
- **Confidence threshold:** **none.** No numeric link-confidence cutoff is applied to the
  mapping buckets. The average verify-link confidence is surfaced separately for transparency,
  so the view never claims certainty the data does not support.
- **Unmapped tests:** `test`/`manual-test` entities with no outgoing explicit `verifies` link.

### Documented limitations

- Canonical (Silver) counts are **product-scoped**; the optional `source` filter narrows only
  the Bronze tier. Per-source canonical slicing is intentionally omitted to keep queries
  bounded.
- Jira **epic** is not a distinct canonical entity type; requirement and story counts are
  reported and coverage is measured against them.
- Pending-projection counts are store-wide and **not attributable** to a single source.
  Dead-letter counts are attributed by connector where the metadata allows it, otherwise
  reported as a total (`unattributed`).

## Failure and partial-state behavior

Each tier carries an `available` flag. If a durable read fails or a dependency is not wired,
that tier is flagged unavailable, its counts are `null`, and `meta.partial` is set to `true`
with an explanatory note. The aggregate **fails explicitly rather than fabricating zero
counts** — a real empty scope returns genuine zeros with `partial: false`, which is a
distinct, truthful state.

## Operational guidance

- A high **missing-tests** or **no test mapped** count means author/link tests, not resync.
- A **raw→canonical backlog** or **serving backlog** is drained by the projection/maintenance
  jobs (see [evidence-maintenance.md](evidence-maintenance.md) and
  [knowledge-serving-projections.md](knowledge-serving-projections.md)); it does not require a
  source sync.
- **Dead-letter** records indicate repeated projection failures — investigate the normalizer
  defect, then requeue; do not resync the source blindly.
- **Stale/errored source** gaps (connected but never successfully synced, or reporting an
  error) are the only gaps that legitimately point to running a sync.
