import type {
  Analyzer,
  Claim,
  ConflictRecord,
  PluginManifest,
} from "@tkl/contracts";
import type { KnowledgeStore } from "@tkl/knowledge-store";

export interface ConflictAnalyzerInput {
  store: KnowledgeStore;
  entityId: string;
  now?: () => string;
}

/**
 * Detects claims that disagree about the same attribute of the same entity (e.g. two
 * differently worded acceptance criteria claiming to define the same field). Conflicts
 * are surfaced as `open` records and must remain visible until a human reviews them -
 * this analyzer never auto-resolves or discards a conflicting claim.
 *
 * Owner: Josue Misael Torres (Knowledge and Traceability). Reads from `KnowledgeStore`
 * only.
 */
export class ConflictAnalyzer implements Analyzer<ConflictAnalyzerInput, ConflictRecord[]> {
  manifest: PluginManifest = {
    id: "tkl.analyzer.conflicts",
    version: "0.1.0",
    contractVersion: "0.1.0",
    capabilities: ["conflict-detection"],
    requiredPermissions: ["knowledge-store:read", "knowledge-store:write"],
  };

  async analyze({ store, entityId, now }: ConflictAnalyzerInput): Promise<ConflictRecord[]> {
    const claims = store.getClaims(entityId).filter((claim) => claim.status !== "rejected");
    const byAttribute = new Map<string, Claim[]>();
    for (const claim of claims) {
      const bucket = byAttribute.get(claim.attribute) ?? [];
      bucket.push(claim);
      byAttribute.set(claim.attribute, bucket);
    }

    const detectedAt = (now ?? (() => new Date().toISOString()))();
    const conflicts: ConflictRecord[] = [];

    for (const [attribute, attributeClaims] of byAttribute) {
      const distinctValues = new Set(attributeClaims.map((c) => JSON.stringify(c.value)));
      if (distinctValues.size <= 1) continue;

      const conflict: ConflictRecord = {
        id: `conflict:${entityId}:${attribute}`,
        entityId,
        claimIds: attributeClaims.map((c) => c.id),
        reason: `${attributeClaims.length} claims disagree on "${attribute}"`,
        detectedAt,
        status: "open",
      };
      conflicts.push(conflict);
      store.addConflict(conflict);
    }

    return conflicts;
  }
}
