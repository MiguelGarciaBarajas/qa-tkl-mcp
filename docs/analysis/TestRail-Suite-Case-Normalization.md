# TestRail Suite and Case Normalization

## Scope

This document defines the fixture-based behavior implemented for backlog item `KNW-101`.
The TestRail normalizer consumes raw evidence only; it does not call TestRail or resolve
configuration and credentials.

| Raw evidence type | Canonical entity | Explicit claims |
|---|---|---|
| `testrail.suite` | `test-suite` | `name` |
| `testrail.case` | `manual-test` | `title`, optional `type_id`, optional `priority_id` |

The `test-suite`, `manual-test`, and `contains` types are supplied by
`@tkl/contracts` as of `ARCH-101`.

## Provenance

Every normalized entity, claim, and trace link preserves the raw evidence source,
source ID/version, content hash, and observation timestamp. It also identifies the
responsible TestRail normalizer and version. Claims have `origin: "explicit"`,
`confidence: 1`, and `status: "pending"`; no inferred or approved knowledge is created
by normalization.

## Suite Membership

The normalizer creates a `contains` link from
`test-suite:testrail:<suite-id>` to `manual-test:testrail:<case-id>` only when the case
payload explicitly provides `suite_id`.

A valid case that does not contain `suite_id` is still emitted as a `manual-test`, but
has no suite-membership link. The current sanitized connector fixture is supported in
this state. Suite membership is never inferred from a case title, source URL, or
collection order.

## Required Source Ingestion Handoff

Jorge Santiago's TestRail connector should preserve the parent suite ID in the
`testrail.case` raw payload when the TestRail API response omits it. The connector already
knows this ID while collecting cases. This is required to build suite-to-case links from
real evidence without inference. `KNW-101` is fixture-complete, but production suite
membership remains unavailable until this Source Ingestion handoff is complete.

## Explicit Cross-Source References

The normalizer accepts configurable TestRail case field names for:

- Jira requirement keys such as `STT-1234`.
- Reviewed canonical GitHub automation IDs such as `test:github:4321`.

The source adapter must map the approved TestRail custom fields into the configured
field names without changing their values. The normalizer emits explicit,
confidence-`1` `verifies` and `relates_to` links, deduplicates repeated references, and
rejects malformed values. With no configured field names, it creates no cross-source
links.

## Identity and Scope Safety

The normalized TestRail suite/case ID must equal the positive integer resource ID in the
raw record's `sourceId`; payload IDs that disagree with `sourceId` are rejected. The
in-memory store rejects dangling links and cross-tenant/product links. It also refuses
to overwrite an existing canonical ID with a record from another tenant or product.

## Exclusions

Coverage, freshness, persistence, and review lifecycle changes remain separate backlog
items. Actual TestRail custom field names still require QA/product approval and belong
in non-secret product configuration.
