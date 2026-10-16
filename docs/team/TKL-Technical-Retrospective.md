# TKL Technical Retrospective

## What worked well

- The repository established clear boundaries between connectors, encrypted raw evidence,
  normalization, canonical knowledge, API, MCP, and dashboard.
- Jira, GitHub, TestRail, Confluence, and ReportPortal now share the same ingestion and
  persistence path instead of creating source-specific shortcuts.
- Security controls are generally fail closed: credential references, no secret readback,
  source allowlists, SSRF protections, encrypted persistence, explicit authorization, and
  sanitized errors.
- The quality gate combines unit, contract, integration, browser, secret, and dependency
  checks. Restart-oriented tests validate behavior that ordinary in-memory tests miss.
- Human review and provenance are modeled as operational behavior, not only documentation.

## What the integrated PRs missed

- Some authorization and transport checks were implemented at adjacent layers but not at
  the earliest state-allocation boundary. Tenant validation and MCP token verification
  should have been explicit acceptance criteria.
- New source support was wired into ingestion before every consumer-side source union and
  label map was updated, allowing the dashboard to attribute unknown sources to Jira.
- HTTP adapters accepted malformed successful envelopes as empty datasets. A `200` response
  must still satisfy the provider schema before a checkpoint can advance.
- Canonical persistence used atomic rename but did not match the raw-evidence store's
  stronger flush protocol.
- Operational surfaces and product configuration lagged behind implementation: live smoke,
  planned plugin declarations, backlog evidence, and architecture decisions were not
  updated in the same change.
- The proposal's future-state model and the MVP's actual contract were not separated
  clearly enough, which made missing capabilities look accidentally omitted.

## Integration lessons

1. A source is not complete when its connector passes. Completion includes registry,
   configuration, persistence, normalization, API/MCP exposure, dashboard attribution,
   live-smoke support, documentation, and a restart-safe vertical slice.
2. Provider clients must validate successful response envelopes and scope before returning
   records or pagination cursors.
3. Authentication must occur before allocating sessions, caches, queues, or other bounded
   resources.
4. Durable stores need an explicit commit point and consistent flush/recovery semantics.
5. Cross-package additions need an exhaustive source matrix so string unions, mappings,
   health views, runbooks, and tests cannot drift independently.

## Recommended ownership and definition of done

- Assign one integration owner for every cross-cutting capability, even when connector,
  UI, and platform work are split across contributors.
- Require a source onboarding checklist covering configuration, secrets, connector,
  evidence type, normalizer, knowledge mapping, health, UI, live smoke, runbook, and
  integration/restart tests.
- Require negative contract tests for malformed `200` responses, checkpoint drift,
  out-of-scope records, replay, and restart recovery.
- Treat proposal-only capabilities as explicit versioned backlog items. Producer plugin
  lineage, failure-history queries, richer feature/business-rule entities, and generalized
  plugin composition must not be implied by unrelated fields.
- Keep deployment same-origin for the MVP. Any CORS change requires an allowlist, preflight
  behavior, credential policy, and browser integration tests.
