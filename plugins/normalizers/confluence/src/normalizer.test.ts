import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { ConfluenceNormalizer, extractStorageText, normalizeConfluenceRecord } from "./normalizer.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/confluence/page-111.raw.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as RawEvidenceRecord;

test("supports() accepts confluence.page records with a valid payload shape", () => {
  const normalizer = new ConfluenceNormalizer();
  assert.equal(normalizer.supports(fixture), true);
  assert.equal(normalizer.supports({ ...fixture, source: "jira" }), false);
  assert.equal(normalizer.supports({ ...fixture, payload: {} }), false);
  assert.equal(normalizer.supports({ ...fixture, contentType: "confluence.space" }), false);
});

test("normalize() produces a requirement entity with full provenance for a page carrying the requirement label", async () => {
  const normalizer = new ConfluenceNormalizer();
  const result = await normalizer.normalize(fixture);

  assert.equal(result.entities.length, 1);
  const [entity] = result.entities;
  assert.equal(entity.id, "requirement:confluence:111");
  assert.equal(entity.type, "requirement");
  assert.equal(entity.title, "Billing fee lines requirement");
  assert.equal(entity.provenance.sourceId, fixture.sourceId);
  assert.equal(entity.provenance.contentHash, fixture.contentHash);
  assert.equal(entity.provenance.normalizerId, "confluence-normalizer");
});

test("normalize() matches the requirement label case-insensitively", async () => {
  const result = await normalizeConfluenceRecord(fixture);
  assert.equal(result?.entities.length, 1);
});

test("normalize() emits a description claim with safely extracted plain text and one claim per label", async () => {
  const result = await normalizeConfluenceRecord(fixture);
  assert.ok(result);
  const description = result!.claims.find((claim) => claim.attribute === "description");
  assert.equal(description?.value, "Fee lines must reconcile with invoiced deals.");
  assert.equal(description?.origin, "explicit");
  assert.equal(description?.status, "pending");

  const labelClaims = result!.claims.filter((claim) => claim.attribute === "label");
  assert.deepEqual(labelClaims.map((claim) => claim.value), ["Requirement", "billing"]);
  for (const claim of labelClaims) {
    assert.equal(claim.entityId, "requirement:confluence:111");
    assert.equal(claim.origin, "explicit");
  }
});

test("normalize() never produces an inferred trace link", async () => {
  const result = await normalizeConfluenceRecord(fixture);
  assert.deepEqual(result?.traceLinks, []);
});

test("normalize() returns an empty, valid result (not an error) for a page without the requirement label", async () => {
  const otherPage = {
    ...fixture,
    sourceId: "222",
    payload: {
      ...fixture.payload as Record<string, unknown>,
      id: "222",
      title: "Team notes",
      metadata: { labels: { results: [{ name: "notes" }] } },
    },
  };
  const normalizer = new ConfluenceNormalizer();
  assert.equal(normalizer.supports(otherPage), true);
  const result = await normalizer.normalize(otherPage);
  assert.deepEqual(result, { entities: [], claims: [], traceLinks: [] });
});

test("normalize() returns an empty, valid result for a page with no labels at all", async () => {
  const noLabelsPage = {
    ...fixture,
    sourceId: "333",
    payload: {
      ...fixture.payload as Record<string, unknown>,
      id: "333",
      metadata: undefined,
    },
  };
  const result = await normalizeConfluenceRecord(noLabelsPage);
  assert.deepEqual(result, { entities: [], claims: [], traceLinks: [] });
});

test("normalize() rejects unsupported payloads", async () => {
  const normalizer = new ConfluenceNormalizer();
  await assert.rejects(() => normalizer.normalize({ ...fixture, payload: {} }));
});

test("normalize() is deterministic across repeated calls on the same record", async () => {
  const first = await normalizeConfluenceRecord(fixture);
  const second = await normalizeConfluenceRecord(fixture);
  assert.deepEqual(first, second);
});

test("extractStorageText strips tags and decodes entities without executing markup", () => {
  assert.equal(
    extractStorageText("<p>Fee lines &amp; totals <em>must</em> reconcile.</p>"),
    "Fee lines & totals must reconcile.",
  );
  // Tags are stripped as inert markup; any embedded script text is left as
  // plain, un-executed text rather than evaluated.
  assert.equal(extractStorageText("<p>Safe</p><script>evil()</script>"), "Safe evil()");
  assert.equal(extractStorageText("<ac:structured-macro><![CDATA[hidden]]></ac:structured-macro>visible"), "visible");
  assert.equal(extractStorageText(undefined), "");
  assert.equal(extractStorageText(""), "");
});
