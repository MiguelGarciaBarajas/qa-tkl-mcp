import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { ReportPortalNormalizer, normalizeReportPortalRecord } from "./normalizer.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/reportportal/launch-501.raw.json", import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, RawEvidenceRecord>;
const { launch, itemWithDefect, itemWithoutDefect } = fixtures;

test("supports() accepts reportportal.launch and reportportal.test_item records with valid payload shapes", () => {
  const normalizer = new ReportPortalNormalizer();
  assert.equal(normalizer.supports(launch), true);
  assert.equal(normalizer.supports(itemWithDefect), true);
  assert.equal(normalizer.supports(itemWithoutDefect), true);
  assert.equal(normalizer.supports({ ...launch, source: "testrail" }), false);
  assert.equal(normalizer.supports({ ...launch, payload: {} }), false);
  assert.equal(normalizer.supports({ ...launch, contentType: "reportportal.suite" }), false);
});

test("supports() rejects a payload id that does not match the record's sourceId", () => {
  const normalizer = new ReportPortalNormalizer();
  assert.equal(
    normalizer.supports({ ...launch, sourceId: "999" }),
    false,
  );
});

test("normalize() maps a launch to a test-execution entity with stable id and explicit claims", async () => {
  const normalizer = new ReportPortalNormalizer();
  const result = await normalizer.normalize(launch);

  assert.equal(result.entities.length, 1);
  const [entity] = result.entities;
  assert.equal(entity.id, "test-execution:reportportal:launch:501");
  assert.equal(entity.type, "test-execution");
  assert.equal(entity.title, "Nightly regression");
  assert.equal(entity.provenance.normalizerId, "reportportal-normalizer");

  const byAttribute = Object.fromEntries(result.claims.map((claim) => [claim.attribute, claim.value]));
  assert.equal(byAttribute.name, "Nightly regression");
  assert.equal(byAttribute.status, "FAILED");
  assert.equal(byAttribute.startedAt, new Date(1757520000000).toISOString());
  assert.equal(byAttribute.endedAt, new Date(1757520900000).toISOString());
  assert.equal(byAttribute.duration, 900000);
  assert.deepEqual(result.traceLinks, []);
});

test("normalize() maps a test item to a test-execution entity and a contains link from its launch", async () => {
  const result = await normalizeReportPortalRecord(itemWithoutDefect);
  assert.ok(result);
  const entity = result!.entities.find((candidate) => candidate.type === "test-execution");
  assert.equal(entity?.id, "test-execution:reportportal:item:9002");
  assert.equal(entity?.title, "should reject negative fee amounts");

  const containsLink = result!.traceLinks.find((link) => link.type === "contains");
  assert.equal(containsLink?.fromEntityId, "test-execution:reportportal:launch:501");
  assert.equal(containsLink?.toEntityId, "test-execution:reportportal:item:9002");
});

test("normalize() retains explicit status/timestamp/duration/launchId/codeRef/retry claims for a test item", async () => {
  const result = await normalizeReportPortalRecord({
    ...itemWithDefect,
    payload: {
      ...(itemWithDefect.payload as Record<string, unknown>),
      attributes: [
        { key: "browser", value: "chromium" },
        { key: "TestRailCaseId", value: "C7988576" },
        { key: "", value: "nightly" },
        { key: "ignored", value: "" },
      ],
      logs: [{ level: "ERROR", message: "Login failed", logTime: 123 }],
    },
  });
  assert.ok(result);
  const byAttribute = Object.fromEntries(result!.claims.map((claim) => [claim.attribute, claim.value]));
  assert.equal(byAttribute.status, "FAILED");
  assert.equal(byAttribute.launchId, "501");
  assert.equal(byAttribute.codeRef, "billing/fee-lines.spec.ts#should reconcile fee lines with invoice");
  assert.equal(byAttribute.retry, false);
  assert.equal(byAttribute.duration, 30000);
  assert.equal(byAttribute.issueType, "PB001");
  assert.deepEqual(byAttribute.externalIssues, ["FLT-4821"]);
  assert.deepEqual(byAttribute.attributes, [
    { key: "browser", value: "chromium" },
    { key: "TestRailCaseId", value: "C7988576" },
    { value: "nightly" },
  ]);
  assert.deepEqual(byAttribute.testrailCaseIds, ["7988576"]);
  assert.deepEqual(byAttribute.logs, [
    { level: "ERROR", message: "Login failed", logTime: 123 },
  ]);
  assert.ok(result!.traceLinks.some((link) =>
    link.fromEntityId === `test-execution:reportportal:item:${itemWithDefect.sourceId}`
    && link.toEntityId === "manual-test:testrail:7988576"
    && link.type === "relates_to"));
});

test("normalize() creates a defect entity and relates_to link only when an explicit external issue identity is present", async () => {
  const result = await normalizeReportPortalRecord(itemWithDefect);
  assert.ok(result);
  const defect = result!.entities.find((entity) => entity.type === "defect");
  assert.ok(defect, "expected a defect entity to be created");
  assert.equal(defect?.id, "defect:reportportal:FLT:FLT-4821");
  assert.equal(defect?.title, "FLT-4821");

  const defectLink = result!.traceLinks.find((link) => link.type === "relates_to");
  assert.equal(defectLink?.fromEntityId, "test-execution:reportportal:item:9001");
  assert.equal(defectLink?.toEntityId, "defect:reportportal:FLT:FLT-4821");
});

test("normalize() never creates a defect entity from a FAILED status or issueType alone", async () => {
  const result = await normalizeReportPortalRecord(itemWithoutDefect);
  assert.ok(result);
  assert.equal(result!.entities.some((entity) => entity.type === "defect"), false);
  assert.equal(result!.traceLinks.some((link) => link.type === "relates_to"), false);
  // issueType is still preserved as an explicit claim even without a defect entity.
  const issueTypeClaim = result!.claims.find((claim) => claim.attribute === "issueType");
  assert.equal(issueTypeClaim?.value, "PB001");
});

test("normalize() never creates a defect entity from a passing item that lacks an issue block entirely", async () => {
  const passingItem = {
    ...itemWithoutDefect,
    sourceId: "9003",
    payload: {
      ...(itemWithoutDefect.payload as Record<string, unknown>),
      id: 9003,
      status: "PASSED",
      issue: undefined,
    },
  };
  const result = await normalizeReportPortalRecord(passingItem);
  assert.ok(result);
  assert.equal(result!.entities.length, 1);
  assert.equal(result!.entities[0].type, "test-execution");
});

test("normalize() rejects unsupported payloads", async () => {
  const normalizer = new ReportPortalNormalizer();
  await assert.rejects(() => normalizer.normalize({ ...launch, payload: {} }));
});

test("normalize() is deterministic across repeated calls on the same record", async () => {
  const first = await normalizeReportPortalRecord(itemWithDefect);
  const second = await normalizeReportPortalRecord(itemWithDefect);
  assert.deepEqual(first, second);
});

test("normalize() returns null for records from a different source", async () => {
  const result = await normalizeReportPortalRecord({ ...launch, source: "jira" });
  assert.equal(result, null);
});
