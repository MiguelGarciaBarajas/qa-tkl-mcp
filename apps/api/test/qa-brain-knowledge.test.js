import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadQaBrainEvidence,
  QaBrainNormalizer,
} from "../src/qa-brain-knowledge.js";

test("loads only curated QA brain Markdown and JSON with bounded provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "tkl-qa-brain-"));
  try {
    mkdirSync(join(root, "skills", "features"), { recursive: true });
    mkdirSync(join(root, "skills", "domain"), { recursive: true });
    mkdirSync(join(root, "wiki", "docs"), { recursive: true });
    mkdirSync(join(root, ".auth"), { recursive: true });
    writeFileSync(join(root, "skills", "features", "create-deal.md"), [
      "---",
      "name: create-deal",
      "feature: Create Deal",
      "---",
      "# Create Deal",
      "## Motorcycle",
      "STT-4656 requires Brake Horsepower or Cubic Centimeter.",
    ].join("\n"));
    writeFileSync(join(root, "skills", "domain", "test-data.md"), "secret test account");
    writeFileSync(join(root, ".auth", "state.json"), "{\"token\":\"secret\"}");
    writeFileSync(join(root, "wiki", "docs", "section-flow-map.json"), JSON.stringify({
      entries: [{
        id: "create-deal",
        title: "Create Deal",
        requiredChecks: ["Vehicle fields are valid"],
      }],
    }));

    const loaded = loadQaBrainEvidence({
      rootPath: root,
      tenantId: "solera",
      productId: "fl-titling",
      now: () => "2026-09-17T00:00:00.000Z",
    });

    assert.equal(loaded.records.length, 3);
    assert.ok(loaded.records.every((record) => record.source === "qa-brain"));
    assert.ok(loaded.records.every((record) => record.sourceUrl.startsWith("qa-brain://")));
    assert.ok(!JSON.stringify(loaded.records).includes("secret test account"));
    assert.ok(!JSON.stringify(loaded.records).includes("\"token\""));

    const motorcycle = loaded.records.find((record) =>
      record.payload.heading === "Motorcycle");
    const normalized = await new QaBrainNormalizer().normalize(motorcycle);
    assert.equal(normalized.entities[0].type, "documentation");
    assert.deepEqual(
      normalized.claims.find((claim) => claim.attribute === "jiraKeys")?.value,
      ["STT-4656"],
    );
    assert.equal(
      normalized.traceLinks.find((link) => link.toEntityId === "requirement:STT-4656")
        ?.origin,
      "explicit",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
