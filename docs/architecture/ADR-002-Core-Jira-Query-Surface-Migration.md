# ADR-002: Remove the Jira-Specific Query Surface from `@tkl/core`

- **Status:** Accepted
- **Date:** 2026-09-11
- **Backlog item:** `ARCH-106`
- **Decision owners:** Miguel Barajas (platform/contracts), with API (`Carlos`),
  MCP/gateway (`Carlos`), ingestion (`Jorge`), and dashboard (`Clemente`) workstream review
- **Supersedes/extends:** `TKL-Contract-Versioning.md` -> *Core Service 0.2 Migration*

## Context

`@tkl/core` 0.2 exposed four query helpers directly on `TklApplicationService`:

| Removed method | Problem |
|---|---|
| `getStoryTestContext(storyKey)` | Hard-coded the Jira `STT-<number>` key regex and the `requirement:<jiraKey>` identifier convention |
| `analyzeRequirementCoverage(storyKey)` | Returned a fixed `status: "unevaluated"` placeholder; never called an analyzer plugin |
| `explainTraceability(storyKey)` | Returned an ad-hoc `{ links, entities }` shape with no product scope |
| `listKnowledgeConflicts()` | Returned every conflict in the store with no tenant, product, or source scope |

They violate three standing architecture rules:

1. **ADR-001 implementation rule 1/2** - core orchestration must not contain
   source-specific logic. The `STT-<number>` regex is Jira-specific by construction.
2. **Tenant/product scope** (`TKL-Contract-Versioning.md` review checklist) - none of the
   helpers accepted or enforced `tenantId`/`productId`, so they could read across product
   boundaries inside a shared store.
3. **Source-agnostic API/MCP schemas** - the live Application API implements the real,
   contract-compliant surface in `apps/api/src/knowledge-service.js` with
   `{ productId, source, storyId | requirementId }` requests and
   `ApplicationResultMap`-shaped responses. The core helpers are an obsolete duplicate
   with incompatible signatures *and* incompatible return shapes.

The `INT-101` repository audit (`docs/analysis/TKL-Repository-Audit-2026-09-11.md`)
confirmed the duplication and recorded that removal is a breaking public-contract change
which must follow the documented pre-1.0 migration process rather than being deleted
opportunistically during an integration fix.

## Affected Consumers (evidence)

Repository-wide search for `getStoryTestContext|analyzeRequirementCoverage|explainTraceability|listKnowledgeConflicts`
and for `@tkl/core|TklApplicationService`:

| Location | Uses the removed core methods? | Evidence |
|---|---|---|
| `apps/api/src/knowledge-service.js` | **No** | Imports `TklApplicationService` and calls `ingest()` only (`context.ingestionService.ingest(...)`). Its identically named methods are its own contract-compliant implementations over `@tkl/knowledge-store`, with `productId`/`source` scoping and provenance |
| `apps/api/src/app.js` | No | Routes call the *knowledge service* interface (`{productId, source, storyId}`), typed in the local `@property` JSDoc block |
| `apps/mcp-gateway/src/{index,gateway,client}.js` | No | Method names belong to the HTTP Application API client (`createApplicationApiClient`) and the MCP tool-name map; the gateway never imports `@tkl/core` (its `@tkl/core` dependency entry is unused metadata) |
| `apps/api/test/app.test.js`, `apps/mcp-gateway/test/gateway.test.js` | No | Exercise the API/gateway interfaces with fake services, not the core class |
| `packages/ingestion/src/index.js` | No | Imports `composeConfiguredPlugins` only |
| `packages/core/test/{service,traceability}.test.js` | No | Cover `ingest()` and `prepareTraceability()` |
| `packages/core/test/types.contract.ts` | Declaration only | Referenced the class type; updated in this change |
| `tests/integration/stt-3731-vertical-slice.test.js`, `tests/contract/**` | No | Drive the API/MCP surfaces |

**Result: zero runtime consumers of the removed methods outside `@tkl/core` itself.** The
compatibility adapter below therefore exists for out-of-tree/unreleased callers and for
the process requirement (step 2/3), not to unblock a known in-repo consumer.

## Decision

1. Remove `getStoryTestContext`, `analyzeRequirementCoverage`, `explainTraceability`, and
   `listKnowledgeConflicts` from `TklApplicationService` (runtime and declarations). The
   primary core surface is now `ingest()`, `prepareTraceability()`, and
   `composeConfiguredPlugins()`.
2. Publish the removed behavior unchanged in an isolated, explicitly deprecated adapter:
   `createDeprecatedJiraQueryAdapter(service)` in
   `packages/core/src/legacy-jira-queries.js`, reachable **only** through the
   `@tkl/core/legacy-jira-queries` subpath export. It is never re-mixed into the primary
   service, it is frozen, it exposes exactly the four legacy methods, and it emits a
   `DeprecationWarning` on creation (suppressible with
   `{ emitDeprecationWarning: false }` for tests).
3. Treat this as a pre-1.0 breaking change: `@tkl/core` `0.2.0` -> `0.3.0`, with every
   exact internal dependency pin and `package-lock.json` entry updated in the same change.
4. Do **not** introduce a persisted-data migration. The removed helpers were pure reads
   over `@tkl/knowledge-store`; no stored entity, claim, trace link, conflict, checkpoint,
   or evidence record changes shape.

## Migration Instructions

**Preferred - migrate to the Application API knowledge service** (source-agnostic, scoped,
provenance-complete):

| Removed core call | Replacement |
|---|---|
| `service.getStoryTestContext("STT-3731")` | `knowledgeService.getStoryTestContext({ productId, source, storyId: "STT-3731" })` |
| `service.analyzeRequirementCoverage("STT-3731")` | `knowledgeService.analyzeRequirementCoverage({ productId, source, requirementId: "STT-3731" })` |
| `service.explainTraceability("STT-3731")` | `knowledgeService.explainTraceability({ productId, source, requirementId: "STT-3731" })` |
| `service.listKnowledgeConflicts()` | `knowledgeService.listKnowledgeConflicts({ productId, source })` |

Agent/tool consumers should call the MCP tools `get_story_test_context`,
`analyze_requirement_coverage`, `explain_traceability`, and `list_knowledge_conflicts`,
which are already wired to that API.

**Temporary - pin the deprecated adapter** only if a caller cannot migrate inside the
compatibility window:

```js
import { TklApplicationService } from "@tkl/core";
import { createDeprecatedJiraQueryAdapter } from "@tkl/core/legacy-jira-queries";

const service = new TklApplicationService({ store, normalizers });
const legacy = createDeprecatedJiraQueryAdapter(service);
legacy.getStoryTestContext("STT-3731"); // identical 0.2 behavior and shape
```

Note that the adapter keeps the original limitations on purpose: Jira-only key format, no
tenant/product scoping, and a placeholder coverage verdict. It is not a supported
long-term interface.

## Compatibility Window and Removal Plan

- **`@tkl/core` 0.3.x** - adapter available, deprecated, warning on every creation.
  Contract tests pin both the reduced primary surface and the adapter behavior.
- **Exit criteria** - no repository consumer imports `@tkl/core/legacy-jira-queries`
  (verified by search at the next contract review) and no external workstream has
  registered a dependency on it.
- **`@tkl/core` 0.4.0** - delete `src/legacy-jira-queries.{js,d.ts}`, the subpath export,
  and its tests. That deletion is itself a pre-1.0 breaking change and repeats this
  process (proposal, tests, consumer migration, matrix update).

## Rollback

The change is code-only and additive-to-remove; there is no data component.

1. Revert the `@tkl/core` commit(s) for `ARCH-106`, which restores the four methods on
   `TklApplicationService`, `packages/core/src/index.d.ts`, and the 0.2 test surface.
2. Restore the `"@tkl/core": "0.2.0"` pins in `apps/api/package.json`,
   `apps/mcp-gateway/package.json`, `packages/ingestion/package.json`, and
   `package-lock.json`, then run `npm install --package-lock-only`.
3. No store rebuild, re-ingestion, checkpoint reset, or evidence replay is required: the
   canonical knowledge, raw evidence, and checkpoint schemas are untouched.
4. Partial rollback is also safe - keeping `@tkl/core/legacy-jira-queries` while reverting
   nothing else restores the full 0.2 behavior for any caller through one import change.

## Consequences

### Positive

- Core contains no Jira-specific logic, satisfying ADR-001 rules 1 and 2.
- Exactly one query surface (the Application API) is authoritative, so tenant/product
  scope and provenance cannot be bypassed through a second, unscoped path.
- The deprecated path is discoverable, isolated, warned, and dated.

### Trade-offs

- One extra published subpath must be maintained until 0.4.
- Consumers that pinned `@tkl/core` 0.2 must take a coordinated minor bump.

## Validation

- `packages/core`: `npm test` (runtime + `tsc`) covering the reduced primary surface, the
  adapter's preserved shapes, the subpath export, the frozen surface, the
  `DeprecationWarning`, and `@ts-expect-error` declaration checks in
  `test/types.contract.ts`.
- Repository gates: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:contract`, `npm run test:integration`.

## Related Documents

- `TKL-Contract-Versioning.md` (compatibility matrix, migration process)
- `ADR-001-Modular-TKL-with-MCP.md`
- `../analysis/TKL-Repository-Audit-2026-09-11.md`
- `../team/TKL-Delivery-Backlog.md` (`ARCH-106`)
