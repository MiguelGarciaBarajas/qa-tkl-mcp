import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { JiraNormalizer } from "./normalizer.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/jira/STT-1234.raw.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as RawEvidenceRecord;

test("supports() accepts jira records with issue payloads only", () => {
  const normalizer = new JiraNormalizer();
  assert.equal(normalizer.supports(fixture), true);
  assert.equal(
    normalizer.supports({ ...fixture, source: "github" }),
    false,
  );
  assert.equal(normalizer.supports({ ...fixture, payload: {} }), false);
});

test("normalize() produces a requirement entity with full provenance", async () => {
  const normalizer = new JiraNormalizer();
  const result = await normalizer.normalize(fixture);

  assert.equal(result.entities.length, 1);
  const [entity] = result.entities;
  assert.equal(entity.id, "requirement:STT-1234");
  assert.equal(entity.type, "requirement");
  assert.equal(entity.provenance.sourceId, fixture.sourceId);
  assert.equal(entity.provenance.contentHash, fixture.contentHash);
});

test("normalize() preserves description, criteria, issue type, and status as traceable claims", async () => {
  const normalizer = new JiraNormalizer();
  const result = await normalizer.normalize(fixture);

  // description + issue type + status + 2 acceptance criteria from the fixture
  assert.equal(result.claims.length, 5);
  assert.deepEqual(
    result.claims.map((claim) => claim.attribute),
    ["description", "issueType", "status", "acceptanceCriteria", "acceptanceCriteria"],
  );
  for (const claim of result.claims) {
    assert.equal(claim.entityId, "requirement:STT-1234");
    assert.equal(claim.origin, "explicit");
    assert.equal(claim.status, "pending");
    assert.equal(claim.provenance.sourceId, fixture.sourceId);
  }
});

test("normalize() rejects unsupported payloads", async () => {
  const normalizer = new JiraNormalizer();
  await assert.rejects(() => normalizer.normalize({ ...fixture, payload: {} }));
});

test("normalizes the flattened jira.issue payload emitted by the approved connector", async () => {
  const normalizer = new JiraNormalizer();
  const connectorRecord: RawEvidenceRecord = {
    ...fixture,
    sourceId: "STT-3731",
    contentType: "jira.issue",
    payload: {
      key: "STT-3731",
      summary: "FL Modernization",
      issueType: "Epic",
      status: "In Progress",
      description: null,
    },
  };

  assert.equal(normalizer.supports(connectorRecord), true);
  const result = await normalizer.normalize(connectorRecord);

  assert.equal(result.entities[0].id, "requirement:STT-3731");
  assert.equal(result.entities[0].title, "FL Modernization");
  assert.deepEqual(result.entities[0].metadata, {
    issueType: "Epic",
    status: "In Progress",
  });
});

test("preserves Jira hierarchy and links a child issue to its epic", async () => {
  const normalizer = new JiraNormalizer();
  const childRecord: RawEvidenceRecord = {
    ...fixture,
    sourceId: "STT-5291",
    payload: {
      key: "STT-5291",
      fields: {
        summary: "Billing total is empty",
        issuetype: { name: "Bug" },
        status: { name: "Resolved" },
        parent: { key: "STT-3731" },
      },
    },
  };

  const result = await normalizer.normalize(childRecord);

  assert.deepEqual(result.entities[0].metadata, {
    issueType: "Bug",
    status: "Resolved",
    parentKey: "STT-3731",
  });
  assert.deepEqual(result.traceLinks, [{
    id: "link:jira:STT-3731:contains:STT-5291",
    fromEntityId: "requirement:STT-3731",
    toEntityId: "requirement:STT-5291",
    type: "contains",
    origin: "explicit",
    confidence: 1,
    provenance: result.entities[0].provenance,
  }]);
});
