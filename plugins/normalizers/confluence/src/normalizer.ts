import type {
  CanonicalEntity,
  Claim,
  Normalizer,
  NormalizationResult,
  RawEvidenceRecord,
  TraceLink,
} from "@tkl/contracts";
import { assertRawEvidenceRecord } from "@tkl/contracts";

interface ConfluenceLabel {
  name?: unknown;
}

interface ConfluencePagePayload {
  id: string | number;
  title: string;
  space?: { key?: string };
  version?: { number?: number; when?: string };
  body?: { storage?: { value?: string } };
  metadata?: { labels?: { results?: ConfluenceLabel[] } };
}

const NORMALIZER_ID = "confluence-normalizer";
const NORMALIZER_VERSION = "0.1.0";
const REQUIREMENT_LABEL = "requirement";

function readConfluencePage(record: RawEvidenceRecord): ConfluencePagePayload | undefined {
  if (record.contentType !== "confluence.page") return undefined;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as Record<string, unknown>;
  if (
    (typeof candidate.id !== "string" && typeof candidate.id !== "number")
    || typeof candidate.title !== "string"
  ) {
    return undefined;
  }
  return candidate as unknown as ConfluencePagePayload;
}

function pageIdOf(page: ConfluencePagePayload): string {
  return String(page.id);
}

function labelNames(page: ConfluencePagePayload): string[] {
  const results = page.metadata?.labels?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((label) => (typeof label?.name === "string" ? label.name.trim() : ""))
    .filter((name) => name.length > 0);
}

function hasRequirementLabel(page: ConfluencePagePayload): boolean {
  return labelNames(page).some((name) => name.toLowerCase() === REQUIREMENT_LABEL);
}

const TAG_PATTERN = /<[^>]*>/g;
const CDATA_PATTERN = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const ENTITY_REPLACEMENTS: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Deterministically extracts plain text from Confluence "storage format"
 * XHTML. This never parses, renders, or executes the markup (no DOM, no
 * script evaluation) -- it only strips tags and decodes a fixed, safe set
 * of named/numeric character entities via string replacement, so a
 * malicious or malformed body can never cause anything beyond an
 * imperfect text extraction.
 */
export function extractStorageText(storageValue: unknown): string {
  if (typeof storageValue !== "string" || storageValue.length === 0) return "";
  let text = storageValue.replace(CDATA_PATTERN, " ").replace(TAG_PATTERN, " ");
  for (const [entity, replacement] of Object.entries(ENTITY_REPLACEMENTS)) {
    text = text.split(entity).join(replacement);
  }
  text = text.replace(/&#(\d+);/g, (_match, code: string) => {
    const codePoint = Number(code);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  });
  return text.replace(/\s+/g, " ").trim();
}

function provenance(record: RawEvidenceRecord) {
  return {
    source: record.source,
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    contentHash: record.contentHash,
    observedAt: record.observedAt,
    normalizerId: NORMALIZER_ID,
    normalizerVersion: NORMALIZER_VERSION,
  };
}

/**
 * Normalizes Confluence `confluence.page` RawEvidenceRecords into canonical
 * `requirement` entities. Only pages explicitly carrying a `requirement`
 * label (case-insensitive) are normalized into an entity/claims; every
 * other supported Confluence page record still normalizes successfully,
 * but produces an empty, valid result (no entities, claims, or trace
 * links) rather than an error, since the absence of the label is a
 * legitimate "out of scope for this normalizer" outcome, not a malformed
 * payload.
 *
 * Claims are limited to what the raw payload states explicitly
 * (description text extracted from the storage-format body, and the
 * page's labels); this normalizer never infers a trace link to a
 * requirement, test, or defect from a Confluence page.
 */
export class ConfluenceNormalizer implements Normalizer {
  supports(record: RawEvidenceRecord): boolean {
    return record.source === "confluence" && readConfluencePage(record) !== undefined;
  }

  async normalize(record: RawEvidenceRecord): Promise<NormalizationResult> {
    const result = normalizeConfluenceRecord(record);
    if (!result) {
      throw new Error(
        `ConfluenceNormalizer cannot normalize record ${record.sourceId}: unsupported payload shape`,
      );
    }
    return result;
  }
}

export function normalizeConfluenceRecord(
  record: RawEvidenceRecord,
): NormalizationResult | null {
  if (record.source !== "confluence") return null;
  assertRawEvidenceRecord(record);
  const page = readConfluencePage(record);
  if (!page) return null;

  // Pages without the requirement label are a valid "nothing to
  // normalize" outcome, never an error.
  if (!hasRequirementLabel(page)) {
    return { entities: [], claims: [], traceLinks: [] };
  }

  const sourceProvenance = provenance(record);
  const pageId = pageIdOf(page);
  const entityId = `requirement:confluence:${pageId}`;
  const entity: CanonicalEntity = {
    id: entityId,
    tenantId: record.tenantId,
    productId: record.productId,
    type: "requirement",
    title: page.title,
    provenance: sourceProvenance,
  };

  const claims: Claim[] = [];
  const description = extractStorageText(page.body?.storage?.value);
  if (description.length > 0) {
    claims.push({
      id: `claim:confluence:${pageId}:description`,
      entityId,
      attribute: "description",
      value: description,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
  }

  for (const [index, label] of labelNames(page).entries()) {
    claims.push({
      id: `claim:confluence:${pageId}:label:${index}`,
      entityId,
      attribute: "label",
      value: label,
      origin: "explicit",
      confidence: 1,
      status: "pending",
      provenance: sourceProvenance,
    });
  }

  // Confluence pages carry no explicit cross-entity references in this MVP;
  // no trace link is ever inferred from a page's content or labels.
  const traceLinks: TraceLink[] = [];

  return { entities: [entity], claims, traceLinks };
}
