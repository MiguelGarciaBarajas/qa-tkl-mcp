import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { GitHubNormalizer } from "./normalizer.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/github/pr-4321.raw.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as RawEvidenceRecord;

test("supports() accepts github records with pull-request payloads only", () => {
  const normalizer = new GitHubNormalizer();
  assert.equal(normalizer.supports(fixture), true);
  assert.equal(normalizer.supports({ ...fixture, source: "jira" }), false);
  assert.equal(normalizer.supports({ ...fixture, payload: {} }), false);
});

test("normalize() produces a test entity and a verifies trace link to the referenced Jira story", async () => {
  const normalizer = new GitHubNormalizer();
  const result = await normalizer.normalize(fixture);

  assert.equal(result.entities.length, 1);
  const [entity] = result.entities;
  assert.equal(entity.id, "test:github:4321");
  assert.equal(entity.type, "test");

  assert.equal(result.traceLinks.length, 1);
  const [link] = result.traceLinks;
  assert.equal(link.fromEntityId, "test:github:4321");
  assert.equal(link.toEntityId, "requirement:STT-1234");
  assert.equal(link.type, "verifies");
  assert.equal(link.origin, "explicit");
});

test("normalize() rejects unsupported payloads", async () => {
  const normalizer = new GitHubNormalizer();
  await assert.rejects(() => normalizer.normalize({ ...fixture, payload: {} }));
});

test("normalizes the ticketKey payload emitted by the approved GitHub connector", async () => {
  const normalizer = new GitHubNormalizer();
  const connectorRecord: RawEvidenceRecord = {
    ...fixture,
    sourceId: "example/repo#7",
    contentType: "github.pull_request",
    payload: {
      number: 7,
      title: "Synthetic test relation",
      updatedAt: "2026-09-10",
      ticketKey: "STT-3731",
    },
  };

  assert.equal(normalizer.supports(connectorRecord), true);
  const result = await normalizer.normalize(connectorRecord);

  assert.equal(result.entities[0].id, "test:github:7");
  assert.equal(result.traceLinks[0].toEntityId, "requirement:STT-3731");
});
