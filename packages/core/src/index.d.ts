import type {
  NormalizationResult,
  Normalizer,
  ProductConfiguration,
  RawEvidenceRecord,
} from "@tkl/contracts";
import type { KnowledgeStore } from "@tkl/knowledge-store";
import type { PluginRegistry } from "@tkl/plugin-registry";

export interface ConfiguredPlugin<TPlugin = unknown> {
  pluginId: string;
  instance: TPlugin;
}

export interface ConfiguredPlatform<TPlugin = unknown> {
  configuration: ProductConfiguration;
  getPlugin(pluginId: string): TPlugin | undefined;
  listPlugins(): ConfiguredPlugin<TPlugin>[];
}

export function composeConfiguredPlugins<TPlugin = unknown>(options: {
  configuration: ProductConfiguration;
  registry: PluginRegistry;
  dependencies?: Record<string, Record<string, unknown>>;
}): ConfiguredPlatform<TPlugin>;

export type NormalizerFunction = (
  record: RawEvidenceRecord,
) => NormalizationResult | null | Promise<NormalizationResult | null>;

/**
 * Source-agnostic application service. Ingestion orchestration only: the Jira-specific
 * query helpers (`getStoryTestContext`, `analyzeRequirementCoverage`,
 * `explainTraceability`, `listKnowledgeConflicts`) were removed in `@tkl/core` 0.3 and
 * live in the deprecated `@tkl/core/legacy-jira-queries` adapter (ARCH-106).
 */
export class TklApplicationService {
  constructor(options?: {
    store?: KnowledgeStore;
    normalizers?: Array<Normalizer | NormalizerFunction>;
    unsupportedRecordPolicy?: "error" | "skip";
  });
  readonly store: KnowledgeStore;
  readonly normalizers: Array<Normalizer | NormalizerFunction>;
  readonly unsupportedRecordPolicy: "error" | "skip";
  ingest(records: RawEvidenceRecord[]): Promise<NormalizationResult>;
}

export function prepareTraceability(records: RawEvidenceRecord[]): {
  sources: Array<{
    source: string;
    sourceId: string;
    sourceVersion: string;
    contentHash: string;
    provenanceKey: string;
  }>;
  relationships: unknown[];
  coverage: {
    status: "not-evaluated";
    reason: string;
  };
};
