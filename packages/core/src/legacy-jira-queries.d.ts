import type { CanonicalEntity, Claim, ConflictRecord, TraceLink } from "@tkl/contracts";
import type { KnowledgeStore } from "@tkl/knowledge-store";

/**
 * DEPRECATED compatibility declarations for the Jira-specific query helpers removed from
 * `TklApplicationService` in `@tkl/core` 0.3 (ARCH-106). Scheduled for removal in
 * `@tkl/core` 0.4.
 *
 * @deprecated Use the Application API knowledge service instead.
 */

export const LEGACY_JIRA_QUERY_METHODS: readonly [
  "getStoryTestContext",
  "analyzeRequirementCoverage",
  "explainTraceability",
  "listKnowledgeConflicts",
];

export const LEGACY_JIRA_QUERY_DEPRECATION_NOTICE: string;

export interface LegacyStoryTestContext {
  storyKey: string;
  entities: CanonicalEntity[];
  traceLinks: TraceLink[];
  provenanceRequired: true;
}

export interface LegacyRequirementCoverage {
  storyKey: string;
  status: "unevaluated";
  reason: string;
  linkedArtifacts: number;
  provenance: unknown[];
}

export interface LegacyTraceabilityExplanation {
  storyKey: string;
  links: TraceLink[];
  entities: CanonicalEntity[];
}

export interface LegacyKnowledgeConflicts {
  conflicts: Array<Claim | ConflictRecord>;
}

/** @deprecated Removed in `@tkl/core` 0.4. */
export interface DeprecatedJiraQueryAdapter {
  readonly deprecated: true;
  readonly removedIn: "@tkl/core 0.4";
  readonly replacement: "Application API knowledge service";
  getStoryTestContext(storyKey: string): LegacyStoryTestContext;
  analyzeRequirementCoverage(storyKey: string): LegacyRequirementCoverage;
  explainTraceability(storyKey: string): LegacyTraceabilityExplanation;
  listKnowledgeConflicts(): LegacyKnowledgeConflicts;
}

/** @deprecated Removed in `@tkl/core` 0.4. */
export function createDeprecatedJiraQueryAdapter(
  service: { store: KnowledgeStore },
  options?: { emitDeprecationWarning?: boolean },
): DeprecatedJiraQueryAdapter;
