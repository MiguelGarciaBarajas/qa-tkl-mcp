import { assertRawEvidenceRecord, sha256 } from "@tkl/contracts";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
export { composeConfiguredPlugins } from "./composition.js";

export function prepareTraceability(evidenceRecords) {
  if (!Array.isArray(evidenceRecords)) throw new TypeError("Evidence records must be an array");
  const sources = evidenceRecords.map(assertRawEvidenceRecord).map((record) => ({
    source: record.source,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    contentHash: record.contentHash,
    provenanceKey: sha256(`${record.source}:${record.sourceId}:${record.sourceVersion}:${record.contentHash}`),
  }));
  return {
    sources,
    relationships: [],
    coverage: { status: "not-evaluated", reason: "No canonical requirements or test links supplied" },
  };
}

/**
 * Source-agnostic application service. It owns ingestion orchestration only; product
 * scoped query surfaces belong to the Application API (`ApplicationResultMap`), not to
 * core. The Jira-specific `STT-<number>` query helpers removed in `@tkl/core` 0.3 live in
 * the deprecated `@tkl/core/legacy-jira-queries` adapter (ARCH-106).
 */
export class TklApplicationService {
  constructor({
    store = new InMemoryKnowledgeStore(),
    normalizers = [],
    unsupportedRecordPolicy = "error",
  } = {}) {
    if (!["error", "skip"].includes(unsupportedRecordPolicy)) {
      throw new TypeError('unsupportedRecordPolicy must be "error" or "skip"');
    }
    this.store = store;
    this.normalizers = [...normalizers];
    this.unsupportedRecordPolicy = unsupportedRecordPolicy;
  }

  async ingest(records) {
    if (this.normalizers.length === 0) {
      throw new TypeError("At least one normalizer must be configured before ingestion");
    }
    const result = { entities: [], claims: [], traceLinks: [] };
    for (const record of records) {
      assertRawEvidenceRecord(record);
      let normalized = null;
      for (const normalizer of this.normalizers) {
        if (typeof normalizer === "function") {
          normalized = await normalizer(record);
        } else if (
          normalizer
          && typeof normalizer.normalize === "function"
          && (typeof normalizer.supports !== "function" || normalizer.supports(record))
        ) {
          normalized = await normalizer.normalize(record);
        }
        if (normalized) break;
      }
      if (!normalized) {
        if (this.unsupportedRecordPolicy === "skip") continue;
        throw new TypeError(
          `No configured normalizer supports ${record.source}:${record.contentType}`,
        );
      }
      result.entities.push(...(normalized.entities ?? []));
      result.claims.push(...(normalized.claims ?? []));
      result.traceLinks.push(...(normalized.traceLinks ?? []));
    }
    this.store.upsert(result);
    return result;
  }

}
