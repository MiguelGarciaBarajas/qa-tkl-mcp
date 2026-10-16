# TKL Contract Compatibility and Versioning

## Purpose

This document defines how shared TKL contracts and plugins evolve without breaking
independent workstreams or product configurations.

## Current Compatibility Family

- Platform contract: `0.1`
- Compatible plugin contract versions: `0.1.x`
- Product configuration schema: `0.1`

The plugin registry compares the major/minor contract family. A platform using `0.1`
accepts plugins declaring `0.1`, `0.1.0`, or another `0.1.x` patch. It rejects `0.2.x`
and later families until an explicit migration is completed.

## Compatibility Matrix

| Module | Contract family | Shared input | Shared output |
|---|---:|---|---|
| Connector plugins | `0.1.x` | Product scope, non-secret settings, credential reference, optional checkpoint | `RawEvidenceRecord`, `ConnectorHealth` |
| Normalizer plugins | `0.1.x` | `RawEvidenceRecord` | `NormalizationResult` |
| Analyzer plugins | `0.1.x` | Canonical/store query input | Typed analysis result |
| Knowledge store | `0.1.x` | Canonical entities, claims, trace links, conflicts | Product-scoped queries |
| Core application service (`@tkl/core` `0.3.x`) | `0.1.x` | `RawEvidenceRecord[]`, injected store/normalizers, product configuration | `NormalizationResult`, composed plugin platform |
| Core legacy adapter (`@tkl/core/legacy-jira-queries`) | *deprecated, removed in `@tkl/core` 0.4* | Jira `STT-<number>` key | Pre-0.3 unscoped story/coverage/traceability/conflict shapes |
| Application API | `0.1.x` | Validated source-agnostic request | `ApplicationResultMap` response |
| MCP gateway | `0.1.x` | Strict tool/resource input | Application API result with provenance |
| Product configuration | `0.1` | Non-secret JSON configuration | Enabled plugin composition |

## Version Rules

### Patch-compatible change

Keep the same contract family for:

- Adding an optional field.
- Adding a new union value that existing consumers safely ignore.
- Adding a new API capability without modifying an existing one.
- Clarifying validation without rejecting previously valid, intended values.
- Fixing declarations to match existing runtime behavior.

### Breaking change

Increment the contract family before:

- Removing or renaming a field.
- Making an optional field required.
- Changing field meaning, data classification, or identifier semantics.
- Changing sync/checkpoint behavior incompatibly.
- Removing a tool, resource, capability, or result field.
- Tightening validation in a way that rejects an intentionally supported payload.

While the platform is pre-1.0, breaking changes increment the minor family:
`0.1` -> `0.2`. After 1.0, standard semantic-versioning major rules apply.

## Required Migration Process

1. Open an ADR or contract proposal describing the reason and affected modules.
2. Add the new declarations/runtime validation without deleting the old contract.
3. Add compatibility fixtures and contract tests for old and new consumers.
4. Obtain approval from Miguel Barajas and every affected workstream owner.
5. Publish adapters or dual-read support when existing persisted data is affected.
6. Migrate product configuration and plugin manifests.
7. Verify connector, normalization, store, API, MCP, dashboard, and integration tests.
8. Remove the old contract only after every registered consumer has migrated.
9. Document rollback and update this matrix.

## Core Service 0.2 Migration

`@tkl/core` 0.2 removes source-specific normalizer imports from core:

- Callers must inject normalizer functions or `Normalizer` implementations.
- `ingest()` is asynchronous and must be awaited.
- Ingestion fails explicitly when no normalizer is configured or supports a record.
- Unsupported evidence may be skipped only with the explicit
  `unsupportedRecordPolicy: "skip"` migration option.
- Composition/bootstrap code owns plugin and normalizer registration.

This is an intentional breaking application-service change. API/MCP workspace dependency
metadata is updated to `@tkl/core` 0.2, and the fixture vertical slice demonstrates the
required migration.

## Core Service 0.3 Migration (ARCH-106)

`@tkl/core` 0.3 removes the obsolete Jira-specific query helpers from the primary
`TklApplicationService` surface: `getStoryTestContext`, `analyzeRequirementCoverage`,
`explainTraceability`, and `listKnowledgeConflicts`. They hard-coded the Jira
`STT-<number>` key format, carried no tenant/product scope, and duplicated the
source-agnostic Application API (`ApplicationResultMap`) with incompatible request and
response shapes.

- The primary core surface is now `ingest()`, `prepareTraceability()`, and
  `composeConfiguredPlugins()`.
- The removed behavior is preserved unchanged in the isolated, explicitly deprecated
  `@tkl/core/legacy-jira-queries` subpath export
  (`createDeprecatedJiraQueryAdapter(service)`), which emits a `DeprecationWarning` and is
  never mixed back into the primary service.
- Callers must migrate to the Application API knowledge service (`{ productId, source,
  storyId | requirementId }`) or the equivalent MCP tools.
- No persisted data changes: the helpers were pure reads over `@tkl/knowledge-store`.
- The compatibility adapter is removed in `@tkl/core` 0.4.

This is an intentional breaking application-service change. API/MCP/ingestion workspace
dependency metadata and `package-lock.json` are updated to `@tkl/core` 0.3, and contract
tests pin both the reduced primary surface and the legacy adapter. Rationale, consumer
evidence, migration instructions, compatibility window, and rollback are recorded in
`ADR-002-Core-Jira-Query-Surface-Migration.md`.

## Product Configuration Evolution

- Every file declares `configVersion`.
- Configuration contains credential references only, never credential values.
- A new optional source/plugin setting is patch-compatible.
- Renaming a setting, changing its type, or making it required needs a new configuration
  version and migration.
- Unknown contract/config versions fail explicitly; they must not silently use defaults.

## Review Checklist

- Does the change preserve tenant/product scope?
- Is provenance still complete and immutable?
- Can older registered plugins continue to load?
- Are API/MCP schemas still source agnostic?
- Are persisted records and checkpoints migratable?
- Are secrets excluded from schemas, fixtures, logs, and errors?
- Do contract and vertical-slice tests prove compatibility?
