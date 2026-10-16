# FL Titling Domain and Coverage Rules

## Status

This document separates the current implementation assumptions from product rules that
still require confirmation by the FL Titling QA/product owner. Agents must not invent
missing business rules.

## Current canonical interpretation

- A Jira story or acceptance criterion is requirement evidence.
- A TestRail case is manual-test evidence.
- A TestRail run/result is execution evidence; it does not by itself prove complete
  requirement coverage.
- A GitHub test artifact is automated-test evidence.
- Explicit source references are preferred over inferred relationships.
- Inferred links require confidence, provenance, and human review.
- Manual coverage, automated coverage, and recent execution status are separate
  dimensions.
- A failed or stale execution affects risk/freshness but does not erase the existence of
  a test case.

## Configurable coverage calculation

The analyzer now reports four independent dimensions:

- Manual requirement coverage from TestRail manual tests that explicitly verify the
  requirement.
- Automated requirement coverage from GitHub tests that verify the requirement directly
  or are explicitly related to a verifying manual test.
- Execution freshness from qualifying TestRail results within the configured window.
- Combined coverage from explicitly configured weights across the three dimensions.

The status-ID mapping, qualifying outcomes, freshness window, and combined weights are
injected as a versioned policy. Without that policy, execution freshness and combined
coverage return `not-evaluated`; the analyzer never invents product values. The legacy
numerator, denominator, confidence, and uncovered fields remain available for compatible
API consumers.

TestRail result normalization preserves `created_on` as an explicit ISO `executedAt`
claim so freshness uses execution time rather than collection time.

Manual and automated dimensions intentionally use a requirement-level denominator of
one. Current trace links target requirements, not individual acceptance-criteria claims,
so the analyzer reports the linked evidence but does not fabricate criterion-level
coverage. Criterion-level ratios remain unavailable until explicit criterion links or an
approved mapping policy exist.

## Product decisions still required

The QA/product owner must confirm:

- Which Jira issue types and fields represent testable requirements.
- Whether every acceptance criterion is independently coverable.
- Which TestRail custom fields contain Jira and automation references.
- Which TestRail case states are active, obsolete, blocked, or excluded.
- Which result statuses count as passed, failed, blocked, skipped, retest, or not run.
- How recent an execution must be to count as current evidence.
- Whether shared cases can cover multiple products/components.
- Required treatment of exploratory, negative, accessibility, API, and non-functional
  coverage.
- Which defect links affect risk and regression recommendations.

Until these rules are approved, use sanitized scenarios and label derived decisions as
provisional rather than approved product truth.
