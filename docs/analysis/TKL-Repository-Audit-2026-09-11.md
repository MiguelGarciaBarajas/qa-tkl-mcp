# TKL Repository Alignment Audit

Date: 2026-09-11

## Conclusion

The repository is aligned with the accepted modular architecture:

```text
Connectors -> Raw Evidence -> Normalization -> Canonical Knowledge
           -> Application API -> MCP Gateway -> Dashboard/Agents
```

Source adapters, evidence persistence, canonical knowledge, API/MCP boundaries, and the
dashboard remain separated. MCP and UI code do not call Jira, GitHub, or TestRail
directly, and credentials remain behind references and injected resolvers.

The audit found several implementation defects and two missing delivery items. The
implementation defects listed below are corrected by the same change set as `INT-101`.
The missing items are added to the delivery backlog rather than represented as already
complete.

## Corrected findings

| Area | Finding | Resolution |
|---|---|---|
| Integration | The existing vertical slice covered Jira and synthetic GitHub only, bypassed raw-evidence persistence, and called an in-process provider instead of the API-backed gateway | `INT-101` now composes Jira, GitHub, and TestRail, commits records and checkpoints, normalizes canonical knowledge, and verifies context, traceability, coverage, resources, provenance, and secret exclusion through API-backed MCP calls |
| Tenant isolation | API authorization supplied product scope but did not pass the configured tenant to policy enforcement | Every protected API capability now authorizes against the knowledge service tenant, and tenant-scoped authorization fails closed when the identity has no matching tenant |
| MCP controls | HTTP requests provided authorization but no subject, leaving per-subject gateway rate limiting inactive | Gateway derives a non-reversible SHA-256 correlation key from authorization when no verified subject is supplied; raw authorization is never logged |
| MCP audit | Gateway errors lacked an HTTP status and resource reads emitted no audit event | Client errors now carry status `400`; tool and resource failures record consistent status, outcome, product, and sanitized subject correlation |
| MCP in-process scope | Search callers could override the provider's configured tenant/product through object spread order | The provider-owned scope now always overrides caller input |
| Coverage | Pending and rejected acceptance-criteria claims were included in coverage denominators | Coverage now uses approved acceptance criteria only |
| GitHub recovery | Resuming from an update-sorted page cursor could permanently skip pull requests reordered ahead of that cursor | Resumed syncs replay pull-request and changed-file pagination from page zero and rely on deterministic evidence idempotency |

## Remaining planned work

| Item | Status | Reason |
|---|---|---|
| `ARCH-106` | RESOLVED | `@tkl/core` 0.3 removes the obsolete Jira-specific query helpers from `TklApplicationService` through the documented pre-1.0 migration process, preserving them only in the deprecated `@tkl/core/legacy-jira-queries` adapter (`docs/architecture/ADR-002-Core-Jira-Query-Surface-Migration.md`) |
| `API-103` | READY | The durable `KNW-107` review lifecycle exists, but no authenticated application command endpoint exposes it to `UI-104` |
| `MCP-103` | RESOLVED | The gateway now implements JSON-RPC 2.0 framing, `initialize` capability/version negotiation, the Streamable HTTP session lifecycle (issue, bind, validate, expire, terminate), and RFC 9728 protected-resource metadata from configured issuer/resource values, failing closed in production when that configuration is absent. The read-only allowlist, authorization forwarding, tenant/product scope, rate limiting, audit, and redaction are unchanged; protocol and transport conformance are covered by `apps/mcp-gateway/test/{protocol,sessions,oauth-metadata}.test.js` and `tests/integration/mcp-103-transport.test.js` |
| `LIVE-101` / `LIVE-102` | BLOCKED-EXTERNAL | Live Jira/TestRail configuration, credentials, and approved execution evidence are not available in the repository |
| MCP gateway OAuth issuer and resource URI | BLOCKED-EXTERNAL | `MCP-103` publishes protected-resource metadata from configuration only. The approved authorization server issuer, canonical resource URI, and scopes must be supplied by the platform owner before a production gateway can start |
| TestRail status and field mappings | BLOCKED-EXTERNAL | Product owners must approve status semantics and custom-field mappings before they can be treated as business truth |

## Active PR reviews

PR #24 proposes `OBS-101` and `OPS-102`. Its health-correlation integration coverage is
aligned, but its production-readiness claim must not be accepted until:

1. The configured production identity provider is actually wired into
   `createTokenAuthenticator`; the current proposed startup path otherwise rejects every
   token when static tokens are correctly disabled.
2. Both service entry points validate the actual product configuration so enabled
   connector credential references participate in the secret-resolution checklist.
3. The proposed `createEnvIdentityAdapter` default verifier is removed. As proposed it
   accepted any non-empty bearer string and parsed JSON token contents into
   roles/permissions/products, so a caller could self-assert `admin` and `"*"` product
   access; `TKL_IDENTITY_PROVIDER` is only a label and verified nothing. The branch now
   requires an injected verifier, maps only verified claims (never defaulting to reader
   or wildcard access), and fails the new `identity_verifier` startup control so a
   production process without a wired verifier refuses to start. `OPS-102` is therefore
   `BLOCKED-EXTERNAL`, not `DONE`, until the approved identity provider is supplied.

These findings concern code that is not present on `main` and therefore are not copied
into this branch.

PR #25 proposes `API-103` and `UI-104`. Its authenticated review boundary, one-way
conflict lifecycle, and dashboard API-client integration are aligned, but a supported
source-scoped review request currently returns a false `404`: the implementation applies
source matching directly to a conflict record even though provenance belongs to the
conflicted entity. The existing entity-scope check is sufficient. `API-103` and `UI-104`
remain pending until the PR fixes that path and is merged.
