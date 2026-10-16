import type { CanonicalEntity, Claim } from "@tkl/contracts";
import type { KnowledgeStore } from "@tkl/knowledge-store";

/**
 * Renders a single canonical entity to Markdown for human review/export.
 *
 * Per ADR-001 and the Definition of Done, Markdown is a generated export of *approved*
 * canonical knowledge only - it is never the operational source of truth, and this
 * function will refuse to render an entity that has zero approved claims (pending or
 * rejected claims are omitted, not rendered as fact).
 *
 * Owner: Josue Misael Torres (Knowledge and Traceability).
 */
export function renderEntityToMarkdown(entity: CanonicalEntity, store: KnowledgeStore): string {
  const approvedClaims = store.getApprovedClaims(entity.id);
  if (approvedClaims.length === 0) {
    throw new Error(
      `Refusing to export entity ${entity.id}: no approved claims. ` +
        "Markdown export must only reflect human-reviewed canonical knowledge.",
    );
  }

  return renderEntityWithClaims(entity, approvedClaims, store);
}

function renderEntityWithClaims(
  entity: CanonicalEntity,
  approvedClaims: Claim[],
  store: KnowledgeStore,
): string {
  const traceLinks = store.getTraceLinks(entity.id);

  const lines: string[] = [];
  lines.push(`# ${entity.title}`);
  lines.push("");
  lines.push(`- **Type:** ${entity.type}`);
  for (const source of provenanceEntries(entity)) {
    lines.push(`- **Source:** ${source.source} (${source.sourceId}, v${source.sourceVersion})`);
  }
  lines.push("");

  const description = approvedClaims.find((c) => c.attribute === "description");
  if (description) {
    lines.push(String(description.value));
    lines.push("");
  }

  const acceptanceCriteria = approvedClaims.filter((c) => c.attribute === "acceptanceCriteria");
  if (acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria");
    lines.push("");
    for (const claim of acceptanceCriteria) {
      lines.push(`- ${String(claim.value)}`);
    }
    lines.push("");
  }

  const additionalClaims = approvedClaims.filter(
    (claim) => claim.attribute !== "description" && claim.attribute !== "acceptanceCriteria",
  );
  if (additionalClaims.length > 0) {
    lines.push("## Approved Knowledge");
    lines.push("");
    for (const claim of additionalClaims) {
      lines.push(`- **${formatAttribute(claim.attribute)}:** ${formatValue(claim.value)}`);
    }
    lines.push("");
  }

  if (traceLinks.length > 0) {
    lines.push("## Traceability");
    lines.push("");
    for (const link of traceLinks) {
      const other = link.fromEntityId === entity.id ? link.toEntityId : link.fromEntityId;
      lines.push(`- ${link.type} \u2194 ${other} (confidence: ${link.confidence})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function renderApprovedTestRailKnowledgeToMarkdown(
  entities: CanonicalEntity[],
  store: KnowledgeStore,
): string {
  const exportable = entities
    .filter((entity) => ["test-suite", "manual-test", "test-execution"].includes(entity.type))
    .filter((entity) => provenanceEntries(entity).some((entry) => entry.source === "testrail"))
    .map((entity) => ({
      entity,
      claims: store.getApprovedClaims(entity.id).filter((claim) =>
        claimProvenanceEntries(claim).some((entry) => entry.source === "testrail")),
    }))
    .filter(({ claims }) => claims.length > 0)
    .sort((left, right) => left.entity.id.localeCompare(right.entity.id));

  if (exportable.length === 0) {
    throw new Error("Refusing to export TestRail knowledge: no approved entities");
  }

  return exportable
    .map(({ entity, claims }) => {
      const approvedTitle = claims.find((claim) =>
        claim.attribute === "title" || claim.attribute === "name");
      const exportEntity = {
        ...entity,
        title: approvedTitle
          ? formatValue(approvedTitle.value)
          : `TestRail ${formatAttribute(entity.type)} ${testRailSourceId(entity)}`,
      };
      return renderEntityWithClaims(exportEntity, claims, store).trimEnd();
    })
    .join("\n\n---\n\n") + "\n";
}

function provenanceEntries(entity: CanonicalEntity) {
  return Array.isArray(entity.provenance) ? entity.provenance : [entity.provenance];
}

function claimProvenanceEntries(claim: Claim) {
  return Array.isArray(claim.provenance) ? claim.provenance : [claim.provenance];
}

function testRailSourceId(entity: CanonicalEntity): string {
  return provenanceEntries(entity).find((entry) => entry.source === "testrail")!.sourceId;
}

function formatAttribute(attribute: string): string {
  return attribute
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
