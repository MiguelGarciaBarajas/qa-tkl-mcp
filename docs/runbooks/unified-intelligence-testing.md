# Unified Intelligence Test Guide

## Purpose

Validate the local-first Quality Intelligence flow without triggering broad source
synchronizations. Start at:

```text
http://localhost:5173/#/investigate
```

The local API health endpoint is:

```text
http://127.0.0.1:3000/health
```

## Prerequisites

1. Start the API and dashboard using
   [`local-demonstration.md`](./local-demonstration.md).
2. Confirm the API health response reports `status: "ok"`.
3. For live JIT retrieval, connect only the source required by the scenario under
   **Sources > Connections**.
4. Use non-production test records and credentials authorized for the tester.

## Core Smoke Test

1. Open **Investigate > Search**.
2. Confirm the search input accepts Jira keys, TestRail IDs, ReportPortal identities,
   names, and product terms.
3. Search for an unknown phrase such as `no-such-quality-artifact`.
4. Confirm the page displays a clear not-found state and remains responsive.
5. Search for a term that matches multiple local artifacts.
6. Confirm no artifact is silently selected and the user must choose a candidate.
7. Select a candidate.
8. Confirm the URL contains `q`, `source`, `type`, and `id`, and reloading preserves the
   investigation.

## Jira-First Scenario

Input:

```text
STT-<known-story>
```

Expected flow:

1. TKL checks canonical knowledge first.
2. On a miss, it retrieves the exact Jira issue and bounded related evidence.
3. The Jira requirement becomes the investigation anchor.
4. **Overview** shows the anchor, freshness, and provenance.
5. **Evidence** shows only grounded relationships.
6. **Actions** offers **Review coverage**, **Design tests**, and
   **Ask about this artifact**.
7. Open **Review coverage** and confirm **Quality Insights > Coverage** receives the
   Jira key from the investigation.
8. Repeating the same search reuses local knowledge instead of starting a broad sync.

## TestRail-First Scenario

Input:

```text
C<known-case-id>
```

Expected flow:

1. TKL checks canonical knowledge first.
2. On a miss, it calls TestRail `get_case/:id`; it does not enumerate suites.
3. The exact case is selected and persisted as canonical evidence.
4. Open **Actions**, then select **Improve test case**.
5. Confirm the assessment identifies only evidence-supported gaps such as missing
   preconditions, steps, or expected results.
6. A Jira relationship is optional. Its absence must not block case analysis or create a
   fabricated mapping.

## ReportPortal-First Scenario

Input:

```text
rp:<uniqueId-or-codeRef>
```

Expected flow:

1. TKL checks local execution knowledge first.
2. On a miss, it performs exact, bounded lookups by `uniqueId` and `codeRef`.
3. The newest matching execution becomes the anchor; prior executions remain visible as
   candidates/history.
4. Open **Actions**, then select **Analyze reliability**.
5. Confirm the result distinguishes flaky behavior, consistent failures, environment
   signals, and insufficient history.
6. Jira is optional; a test without a ticket can still receive a grounded reliability
   assessment.

## Name and Confluence Scenario

Input:

```text
<specific test or feature name>
```

Expected flow:

1. Local canonical titles and IDs are searched first.
2. Multiple matches require explicit selection.
3. If no local artifact matches and Confluence is connected, TKL runs one bounded CQL
   request per allowlisted space.
4. Confirm results never include pages outside the configured spaces.
5. Confirm the operation does not start a full Confluence synchronization.

## Evidence Graph Checks

For every selected artifact:

1. The selected record is the graph anchor.
2. Nodes show their source and artifact type.
3. Edges correspond to stored trace links; missing relationships remain missing.
4. The graph is bounded to two hops and 100 nodes.
5. Source links open in a new tab when provenance includes a URL.

## Operational Checks

1. Open **Sources > Health** and confirm the API remains healthy.
2. Start the same exact lookup twice and confirm it does not create overlapping remote
   operations.
3. Confirm **Sources > Connections** exposes Connect and Test connection, but no control
   that starts a broad source or repository synchronization.
4. Disconnect a source and repeat its JIT scenario. Confirm the UI reports the connector
   requirement without affecting local searches for other sources.

## Navigation Journeys

Validate these five user journeys from the primary navigation:

1. **Jira investigation to coverage:** Investigate > Search → select a Jira artifact →
   Actions → Review coverage. Confirm the Coverage tab is active and the Jira key is
   prefilled.
2. **TestRail improvement:** Investigate > Search → select a TestRail case → Actions →
   Improve test case. Confirm the proposal cites the selected case and exposes
   limitations.
3. **ReportPortal reliability:** Investigate > Search → select a ReportPortal identity →
   Actions → Analyze reliability. Confirm the result distinguishes evidence from
   insufficient history.
4. **Proposal and conflict review:** Review Queue > Proposals → generate and inspect a
   proposal → switch to Conflicts. Confirm each tab keeps its distinct review purpose
   and no change occurs without explicit approval.
5. **Source setup to health:** Sources > Connections → configure an authorized source →
   switch to Health. Confirm connector status is visible without returning to the
   primary navigation.

Also confirm the remaining grouped destinations work:

- **Investigate:** Search and Ask TKL.
- **Quality Insights:** Coverage and Traceability.
- **Knowledge Health:** Inventory and Evaluation.
- Previous bookmarked routes such as `#/intelligence`, `#/coverage-gaps`, and
  `#/source-connections` redirect to the equivalent new route without losing query
  parameters.

## Pass Criteria

- No page exposes or starts a broad sync.
- Exact IDs resolve deterministically.
- Ambiguous names require a human selection.
- Agent results cite stored evidence and expose limitations.
- No missing relation is presented as fact.
- The UI stays responsive and deep links survive reload.
- Credentials, tokens, and source payloads do not appear in logs or error messages.
