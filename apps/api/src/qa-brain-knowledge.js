import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  assertRawEvidenceRecord,
  createRawEvidenceRecord,
  sha256,
} from "@tkl/contracts";

const NORMALIZER_ID = "qa-brain-normalizer";
const NORMALIZER_VERSION = "0.1.0";
const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 200;
const MAX_RECORD_BYTES = 64_000;
const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const TESTRAIL_CASE_PATTERN = /\bC(\d{4,})\b/g;
const JSON_DATASETS = Object.freeze({
  "wiki/docs/section-flow-map.json": {
    collection: "entries",
    idField: "id",
    kind: "product-workflow",
  },
  "wiki/docs/legacy-gen3-flow-map.json": {
    collection: "entries",
    idField: "ticketKey",
    kind: "legacy-parity-mapping",
  },
  "wiki/docs/testrail-legacy-cases.json": {
    collection: "cases",
    idField: "caseId",
    kind: "testrail-legacy-case",
  },
});

export function loadQaBrainEvidence({
  rootPath,
  tenantId,
  productId,
  now = () => new Date().toISOString(),
  maxFiles = MAX_FILES,
} = {}) {
  const root = typeof rootPath === "string" ? resolve(rootPath) : "";
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    throw new TypeError("TKL_QA_BRAIN_PATH must identify an existing directory.");
  }
  const paths = collectAllowlistedPaths(root).slice(0, maxFiles);
  const records = [];
  const skipped = [];
  for (const path of paths) {
    const relativePath = normalizeRelativePath(relative(root, path));
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path: relativePath, reason: "file_too_large" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (relativePath.endsWith(".md")) {
      const { frontmatter, body, bodyStartLine } = parseFrontmatter(text);
      for (const chunk of chunkMarkdown(body, bodyStartLine)) {
        const payload = {
          repository: "vs-titling-qa-brain",
          path: relativePath,
          title: chunk.title,
          heading: chunk.heading,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          kind: classifyMarkdown(relativePath),
          frontmatter,
          content: chunk.content,
          references: extractReferences(chunk.content),
        };
        appendBoundedRecord(records, skipped, {
          tenantId,
          productId,
          relativePath,
          sourceEntryId: `L${chunk.lineStart}-L${chunk.lineEnd}`,
          payload,
          observedAt: now(),
        });
      }
      continue;
    }
    const dataset = JSON_DATASETS[relativePath];
    if (!dataset) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      skipped.push({ path: relativePath, reason: "invalid_json" });
      continue;
    }
    const entries = Array.isArray(parsed?.[dataset.collection])
      ? parsed[dataset.collection]
      : [];
    entries.forEach((entry, index) => {
      const stableId = safeText(entry?.[dataset.idField]) || String(index + 1);
      const payload = {
        repository: "vs-titling-qa-brain",
        path: relativePath,
        title: safeText(entry?.title) || stableId,
        heading: safeText(entry?.title) || stableId,
        lineStart: 1,
        lineEnd: text.split(/\r?\n/).length,
        kind: dataset.kind,
        frontmatter: {},
        content: JSON.stringify(entry),
        rawContent: entry,
        references: extractReferences(JSON.stringify(entry)),
      };
      appendBoundedRecord(records, skipped, {
        tenantId,
        productId,
        relativePath,
        sourceEntryId: stableId,
        payload,
        observedAt: now(),
      });
    });
  }
  return { records, skipped, filesInspected: paths.length };
}

export class QaBrainNormalizer {
  supports(record) {
    return record?.source === "qa-brain" && record?.contentType === "qa-brain.knowledge";
  }

  async normalize(record) {
    assertRawEvidenceRecord(record);
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || typeof payload.content !== "string") {
      throw new TypeError("QA brain evidence payload is invalid.");
    }
    const entityHash = createHash("sha256")
      .update(`${payload.path}\0${payload.heading}\0${record.sourceId}`)
      .digest("hex")
      .slice(0, 24);
    const entityId = `documentation:qa-brain:${entityHash}`;
    const sourceProvenance = {
      source: record.source,
      sourceId: record.sourceId,
      sourceVersion: record.sourceVersion,
      contentHash: record.contentHash,
      observedAt: record.observedAt,
      normalizerId: NORMALIZER_ID,
      normalizerVersion: NORMALIZER_VERSION,
    };
    const entity = {
      id: entityId,
      tenantId: record.tenantId,
      productId: record.productId,
      type: "documentation",
      title: safeText(payload.title) || safeText(payload.heading) || payload.path,
      metadata: {
        repository: payload.repository,
        path: payload.path,
        heading: payload.heading,
        lineStart: payload.lineStart,
        lineEnd: payload.lineEnd,
        kind: payload.kind,
      },
      provenance: sourceProvenance,
    };
    const claims = [
      claim(entityId, "content", payload.content, sourceProvenance),
      claim(entityId, "path", payload.path, sourceProvenance),
      claim(entityId, "knowledgeKind", payload.kind, sourceProvenance),
    ];
    if (payload.frontmatter && Object.keys(payload.frontmatter).length > 0) {
      claims.push(claim(entityId, "frontmatter", payload.frontmatter, sourceProvenance));
    }
    const references = payload.references ?? {};
    if (Array.isArray(references.jiraKeys) && references.jiraKeys.length > 0) {
      claims.push(claim(entityId, "jiraKeys", references.jiraKeys, sourceProvenance));
    }
    if (Array.isArray(references.testRailCaseIds) && references.testRailCaseIds.length > 0) {
      claims.push(claim(
        entityId,
        "testRailCaseIds",
        references.testRailCaseIds,
        sourceProvenance,
      ));
    }
    const traceLinks = [
      ...(references.jiraKeys ?? []).map((key) => ({
        id: `link:qa-brain:${entityHash}:jira:${key}`,
        fromEntityId: entityId,
        toEntityId: `requirement:${key}`,
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      })),
      ...(references.testRailCaseIds ?? []).map((caseId) => ({
        id: `link:qa-brain:${entityHash}:testrail:${caseId}`,
        fromEntityId: entityId,
        toEntityId: `manual-test:testrail:${caseId}`,
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: sourceProvenance,
      })),
    ];
    return { entities: [entity], claims, traceLinks };
  }
}

function collectAllowlistedPaths(root) {
  const skillsRoot = resolve(root, "skills");
  const paths = [];
  if (existsSync(skillsRoot)) {
    walk(skillsRoot, paths, (path) => {
      const relativePath = normalizeRelativePath(relative(root, path));
      return relativePath.endsWith(".md")
        && relativePath !== "skills/domain/test-data.md"
        && !relativePath.includes("/qae-test-accounts");
    });
  }
  for (const relativePath of Object.keys(JSON_DATASETS)) {
    const path = resolve(root, ...relativePath.split("/"));
    if (existsSync(path) && statSync(path).isFile()) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

function walk(directory, results, include) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, results, include);
    } else if (entry.isFile() && include(path)) {
      results.push(path);
    }
  }
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: text, bodyStartLine: 1 };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { frontmatter: {}, body: text, bodyStartLine: 1 };
  const end = closing + 1;
  const frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) frontmatter[match[1]] = match[2].trim();
  }
  return {
    frontmatter,
    body: lines.slice(end + 1).join("\n"),
    bodyStartLine: end + 2,
  };
}

function chunkMarkdown(body, bodyStartLine) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ index, heading: match[2].trim() });
  });
  if (headings.length === 0) {
    const content = body.trim();
    return content ? [{
      title: "QA brain knowledge",
      heading: "QA brain knowledge",
      lineStart: bodyStartLine,
      lineEnd: bodyStartLine + lines.length - 1,
      content,
    }] : [];
  }
  return headings.flatMap((item, position) => {
    const endIndex = headings[position + 1]?.index ?? lines.length;
    const content = lines.slice(item.index, endIndex).join("\n").trim();
    if (!content || /^#{1,3}\s+MOVED\b/i.test(content)) return [];
    return [{
      title: item.heading,
      heading: item.heading,
      lineStart: bodyStartLine + item.index,
      lineEnd: bodyStartLine + endIndex - 1,
      content,
    }];
  });
}

function appendBoundedRecord(records, skipped, {
  tenantId,
  productId,
  relativePath,
  sourceEntryId,
  payload,
  observedAt,
}) {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RECORD_BYTES) {
    skipped.push({ path: relativePath, sourceEntryId, reason: "record_too_large" });
    return;
  }
  const sourceId = `${relativePath}#${sourceEntryId}`;
  const sourceVersion = sha256(payload);
  records.push(createRawEvidenceRecord({
    tenantId,
    productId,
    source: "qa-brain",
    sourceId,
    sourceVersion,
    sourceUrl: `qa-brain://${relativePath}#${sourceEntryId}`,
    observedAt,
    contentType: "qa-brain.knowledge",
    payload,
    classification: "internal",
    idempotencyKey: `qa-brain:${productId}:${sha256(`${sourceId}:${sourceVersion}`)}`,
  }));
}

function extractReferences(value) {
  const text = String(value).toUpperCase();
  return {
    jiraKeys: [...new Set(text.match(JIRA_KEY_PATTERN) ?? [])],
    testRailCaseIds: [...new Set(
      [...text.matchAll(TESTRAIL_CASE_PATTERN)].map((match) => match[1]),
    )],
  };
}

function classifyMarkdown(path) {
  if (path.startsWith("skills/features/")) return "feature-guide";
  if (path.startsWith("skills/domain/")) return "domain-oracle";
  if (path.endsWith("/SKILL.md")) return "workflow";
  return "knowledge-index";
}

function claim(entityId, attribute, value, provenance) {
  return {
    id: `claim:${entityId}:${attribute}`,
    entityId,
    attribute,
    value,
    origin: "explicit",
    confidence: 1,
    status: "pending",
    provenance,
  };
}

function normalizeRelativePath(value) {
  return value.split(sep).join("/");
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
