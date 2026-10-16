/**
 * DEPRECATED compatibility surface (ARCH-106).
 *
 * `@tkl/core` 0.2 exposed four Jira-specific query helpers directly on
 * `TklApplicationService`: `getStoryTestContext`, `analyzeRequirementCoverage`,
 * `explainTraceability`, and `listKnowledgeConflicts`. They hard-coded the Jira
 * `STT-<number>` key format, ignored tenant/product scope, and returned shapes that are
 * incompatible with the source-agnostic Application API contract
 * (`apps/api/src/knowledge-service.js`, `ApplicationResultMap`).
 *
 * `@tkl/core` 0.3 removes them from the primary service. This module is the isolated,
 * frozen compatibility path required by `docs/architecture/TKL-Contract-Versioning.md`
 * step 2/3: byte-for-byte the 0.2 runtime behavior, reachable only through the explicit
 * `@tkl/core/legacy-jira-queries` subpath, and never mixed back into the primary service.
 *
 * Do not build new functionality on this module. It is scheduled for removal in
 * `@tkl/core` 0.4; migrate to the Application API knowledge service instead
 * (see `docs/architecture/ADR-002-Core-Jira-Query-Surface-Migration.md`).
 *
 * @deprecated Removed in `@tkl/core` 0.4. Use the Application API knowledge service.
 */

export const LEGACY_JIRA_QUERY_METHODS = Object.freeze([
  "getStoryTestContext",
  "analyzeRequirementCoverage",
  "explainTraceability",
  "listKnowledgeConflicts",
]);

export const LEGACY_JIRA_QUERY_DEPRECATION_NOTICE =
  "@tkl/core/legacy-jira-queries is a deprecated ARCH-106 compatibility adapter for the "
  + "Jira-specific query helpers removed from TklApplicationService in @tkl/core 0.3. "
  + "It is source-specific, not tenant/product scoped, and will be removed in @tkl/core 0.4. "
  + "Migrate to the Application API knowledge service "
  + "(see docs/architecture/ADR-002-Core-Jira-Query-Surface-Migration.md).";

/**
 * Wraps a `TklApplicationService` (or any object exposing a compatible knowledge `store`)
 * in the removed 0.2 Jira query surface.
 *
 * @deprecated Removed in `@tkl/core` 0.4.
 */
export function createDeprecatedJiraQueryAdapter(service, { emitDeprecationWarning = true } = {}) {
  const store = service?.store;
  if (
    !store
    || typeof store.getEntity !== "function"
    || typeof store.getTraceLinks !== "function"
    || typeof store.conflicts !== "function"
  ) {
    throw new TypeError(
      "createDeprecatedJiraQueryAdapter requires a TklApplicationService with a knowledge store",
    );
  }

  if (emitDeprecationWarning) {
    process.emitWarning(LEGACY_JIRA_QUERY_DEPRECATION_NOTICE, "DeprecationWarning");
  }

  return Object.freeze({
    deprecated: true,
    removedIn: "@tkl/core 0.4",
    replacement: "Application API knowledge service",

    getStoryTestContext(storyKey) {
      if (typeof storyKey !== "string" || !/^STT-\d+$/.test(storyKey)) {
        throw new TypeError("storyKey must match STT-<number>");
      }
      const requirementId = `requirement:${storyKey}`;
      const traceLinks = store.getTraceLinks(requirementId);
      const entityIds = new Set([
        requirementId,
        ...traceLinks.flatMap((link) => [link.fromEntityId, link.toEntityId]),
      ]);
      const entities = [...entityIds]
        .map((entityId) => store.getEntity(entityId))
        .filter(Boolean);
      return {
        storyKey,
        entities,
        traceLinks,
        provenanceRequired: true,
      };
    },

    analyzeRequirementCoverage(storyKey) {
      const context = this.getStoryTestContext(storyKey);
      const links = context.traceLinks.filter((link) => link.type === "verifies");
      return {
        storyKey,
        status: "unevaluated",
        reason: "No canonical requirements and approved test links are available",
        linkedArtifacts: links.length,
        provenance: context.entities.flatMap((entity) => entity.provenance ?? []),
      };
    },

    explainTraceability(storyKey) {
      const context = this.getStoryTestContext(storyKey);
      return { storyKey, links: context.traceLinks, entities: context.entities };
    },

    listKnowledgeConflicts() {
      return { conflicts: store.conflicts() };
    },
  });
}
