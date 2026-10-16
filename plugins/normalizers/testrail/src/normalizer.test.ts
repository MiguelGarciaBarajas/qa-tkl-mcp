import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { TestRailNormalizer, normalizeTestRailRecord } from "./normalizer.ts";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/testrail/suite-case-normalization.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  suite: RawEvidenceRecord;
  case: RawEvidenceRecord;
};
const connectorFixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/testrail-project-128.json", import.meta.url),
);
const connectorFixture = JSON.parse(readFileSync(connectorFixturePath, "utf-8")) as {
  runs: Array<{ id: number; name: string; updated_on: number }>;
  results: Array<{ id: number; status_id: number; created_on: number }>;
  cases: Array<{ id: number; title: string; updated_on: number }>;
};
const executionFixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/testrail/execution-normalization.json", import.meta.url),
);
const executionFixture = JSON.parse(readFileSync(executionFixturePath, "utf-8")) as {
  run: RawEvidenceRecord;
  result: RawEvidenceRecord;
};
const traceabilityFixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/testrail/case-traceability.json", import.meta.url),
);
const traceabilityFixture = JSON.parse(readFileSync(traceabilityFixturePath, "utf-8")) as {
  case: RawEvidenceRecord;
};

test("normalizes a suite as a provenance-backed canonical suite", async () => {
  const result = await new TestRailNormalizer().normalize(fixture.suite);

  assert.deepEqual(result.entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    title: entity.title,
  })), [{
    id: "test-suite:testrail:12",
    type: "test-suite",
    title: "Sanitized title workflow regression",
  }]);
  assert.equal(result.claims[0].attribute, "name");
  assert.equal(result.claims[0].origin, "explicit");
  assert.equal(result.claims[0].status, "pending");
  assert.deepEqual(result.entities[0].provenance, {
    source: "testrail",
    sourceId: "12",
    sourceVersion: "1789056000",
    contentHash: "sha256-fixture-testrail-suite-12",
    observedAt: "2026-09-15T12:00:00.000Z",
    normalizerId: "testrail-normalizer",
    normalizerVersion: "0.2.0",
  });
  assert.deepEqual(result.traceLinks, []);
});

test("retains TestRail preconditions and separated step expected results", async () => {
  const result = await new TestRailNormalizer().normalize({
    ...fixture.case,
    payload: {
      ...(fixture.case.payload as Record<string, unknown>),
      custom_preconds: "  A synchronized title application exists.  ",
      custom_steps_separated: [
        {
          content: "  Open the synchronized application.  ",
          expected: "  The application details are displayed.  ",
          additional_info: "Not part of the canonical improvement fields.",
        },
        {
          content: "Review the title status.",
          expected: null,
        },
      ],
      custom_expected: "  The title status is visible.  ",
    },
  });

  assert.deepEqual(
    result.claims
      .filter((claim) => claim.attribute.startsWith("custom_"))
      .map((claim) => [claim.attribute, claim.value]),
    [
      ["custom_preconds", "A synchronized title application exists."],
      ["custom_steps_separated", [
        {
          content: "Open the synchronized application.",
          expected: "The application details are displayed.",
        },
        {
          content: "Review the title status.",
          expected: "",
        },
      ]],
      ["custom_expected", "The title status is visible."],
    ],
  );
});

test("retains plain-text steps and configured Jira references without rewriting them", async () => {
  const result = await new TestRailNormalizer({
    jiraReferenceField: "custom_jira_references",
  }).normalize({
    ...fixture.case,
    payload: {
      ...(fixture.case.payload as Record<string, unknown>),
      custom_steps: "1. Open the application\n2. Submit the VIN",
      custom_jira_references: ["STT-1234", "STT-5678"],
    },
  });

  assert.deepEqual(
    result.claims
      .filter((claim) => ["custom_steps", "custom_jira_references"].includes(claim.attribute))
      .map((claim) => [claim.attribute, claim.value]),
    [
      ["custom_steps", "1. Open the application\n2. Submit the VIN"],
      ["custom_jira_references", ["STT-1234", "STT-5678"]],
    ],
  );
});

test("keeps case normalization backward compatible when optional custom fields are malformed", async () => {
  const result = await new TestRailNormalizer().normalize({
    ...fixture.case,
    payload: {
      ...(fixture.case.payload as Record<string, unknown>),
      custom_preconds: 123,
      custom_steps_separated: [{ content: 456 }],
      custom_expected: { text: "unsupported" },
    },
  });

  assert.deepEqual(
    result.claims.map((claim) => claim.attribute),
    ["title", "type_id", "priority_id"],
  );
});

test("normalizes a case as a distinct manual test with an explicit suite membership link", async () => {
  const result = await new TestRailNormalizer().normalize(fixture.case);

  assert.deepEqual(result.entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    title: entity.title,
  })), [{
    id: "manual-test:testrail:1201",
    type: "manual-test",
    title: "Verify a sanitized title workflow",
  }]);
  assert.deepEqual(
    result.claims.map((claim) => [claim.attribute, claim.value]),
    [["title", "Verify a sanitized title workflow"], ["type_id", "1"], ["priority_id", "2"]],
  );
  assert.deepEqual(result.traceLinks, [{
    id: "link:testrail:suite:12:case:1201",
    fromEntityId: "test-suite:testrail:12",
    toEntityId: "manual-test:testrail:1201",
    type: "contains",
    origin: "explicit",
    confidence: 1,
    provenance: result.entities[0].provenance,
  }]);
});

test("produces stable IDs for identical evidence", () => {
  const first = normalizeTestRailRecord(fixture.case);
  const second = normalizeTestRailRecord(fixture.case);

  assert.deepEqual(second, first);
});

test("creates deduplicated explicit Jira and reviewed GitHub automation links from configured fields", async () => {
  const normalizer = new TestRailNormalizer({
    jiraReferenceField: "custom_jira_references",
    githubAutomationReferenceField: "custom_github_automation",
  });
  const result = await normalizer.normalize(traceabilityFixture.case);

  assert.deepEqual(
    result.traceLinks.map((link) => ({
      id: link.id,
      from: link.fromEntityId,
      to: link.toEntityId,
      type: link.type,
      origin: link.origin,
      confidence: link.confidence,
      provenance: link.provenance,
    })),
    [
      {
        id: "link:testrail:suite:12:case:1202",
        from: "test-suite:testrail:12",
        to: "manual-test:testrail:1202",
        type: "contains",
        origin: "explicit",
        confidence: 1,
        provenance: result.entities[0].provenance,
      },
      {
        id: "link:testrail:case:1202:requirement:STT-1234",
        from: "manual-test:testrail:1202",
        to: "requirement:STT-1234",
        type: "verifies",
        origin: "explicit",
        confidence: 1,
        provenance: result.entities[0].provenance,
      },
      {
        id: "link:testrail:case:1202:automation:test:github:4321",
        from: "manual-test:testrail:1202",
        to: "test:github:4321",
        type: "relates_to",
        origin: "explicit",
        confidence: 1,
        provenance: result.entities[0].provenance,
      },
    ],
  );
});

test("does not invent requirement or automation links without configured fields", async () => {
  const result = await new TestRailNormalizer().normalize(traceabilityFixture.case);

  assert.deepEqual(
    result.traceLinks.map((link) => link.type),
    ["contains"],
  );
});

test("rejects invalid configured Jira and GitHub references", async () => {
  const normalizer = new TestRailNormalizer({
    jiraReferenceField: "custom_jira_references",
    githubAutomationReferenceField: "custom_github_automation",
  });

  await assert.rejects(
    normalizer.normalize({
      ...traceabilityFixture.case,
      payload: {
        ...(traceabilityFixture.case.payload as Record<string, unknown>),
        custom_jira_references: ["not-a-jira-key"],
      },
    }),
    /Jira reference field "custom_jira_references" contains an invalid reference/,
  );
  await assert.rejects(
    normalizer.normalize({
      ...traceabilityFixture.case,
      payload: {
        ...(traceabilityFixture.case.payload as Record<string, unknown>),
        custom_github_automation: ["https://github.com/example/repo/pull/4321"],
      },
    }),
    /GitHub automation reference field "custom_github_automation" contains an invalid reference/,
  );
});

test("rejects evidence whose raw source ID disagrees with the payload ID", async () => {
  const normalizer = new TestRailNormalizer();
  const mismatchedRecord = {
    ...fixture.case,
    sourceId: "999",
  };

  assert.equal(normalizer.supports(mismatchedRecord), false);
  assert.equal(normalizeTestRailRecord(mismatchedRecord), null);
  await assert.rejects(() => normalizer.normalize(mismatchedRecord));
});

test("normalizes a case without suite_id but does not invent a suite membership link", async () => {
  const normalizer = new TestRailNormalizer();
  const caseWithoutSuiteId = {
    ...fixture.case,
    payload: { id: 1201, title: "Missing explicit suite ID" },
  };

  assert.equal(normalizer.supports(caseWithoutSuiteId), true);
  const result = await normalizer.normalize(caseWithoutSuiteId);
  assert.equal(result.entities[0].type, "manual-test");
  assert.deepEqual(result.traceLinks, []);
});

test("supports the current connector fixture when parent suite context is unavailable", async () => {
  const normalizer = new TestRailNormalizer();
  const sourceCase = connectorFixture.cases[0];
  const record: RawEvidenceRecord = {
    tenantId: "solera",
    productId: "fl-titling",
    source: "testrail",
    sourceId: String(sourceCase.id),
    sourceVersion: String(sourceCase.updated_on),
    observedAt: "2026-09-15T12:00:00.000Z",
    contentType: "testrail.case",
    contentHash: "sha256-connector-fixture-case",
    payload: sourceCase,
    classification: "internal",
  };

  const result = await normalizer.normalize(record);

  assert.equal(result.entities[0].id, "manual-test:testrail:1201");
  assert.deepEqual(result.traceLinks, []);
});

test("normalizes a run as provenance-backed execution context", async () => {
  const result = await new TestRailNormalizer().normalize(executionFixture.run);

  assert.deepEqual(result.entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    title: entity.title,
  })), [{
    id: "test-execution:testrail:run:77",
    type: "test-execution",
    title: "Sanitized regression execution",
  }]);
  assert.deepEqual(result.traceLinks.map((link) => ({
    from: link.fromEntityId,
    to: link.toEntityId,
    type: link.type,
    origin: link.origin,
  })), [{
    from: "test-suite:testrail:12",
    to: "test-execution:testrail:run:77",
    type: "contains",
    origin: "explicit",
  }]);
});

test("normalizes a result with raw status and an unknown provisional status", async () => {
  const result = await new TestRailNormalizer().normalize(executionFixture.result);

  assert.deepEqual(result.entities.map((entity) => entity.id), ["test-execution:testrail:result:7701"]);
  assert.deepEqual(
    result.claims.map((claim) => [claim.attribute, claim.value]),
    [
      ["status_id", "1"],
      ["status", "unknown"],
      ["executedAt", "2026-09-10T16:03:00.000Z"],
    ],
  );
  assert.deepEqual(
    result.traceLinks.map((link) => [link.fromEntityId, link.toEntityId, link.type]),
    [
      ["test-execution:testrail:run:77", "test-execution:testrail:result:7701", "contains"],
      ["manual-test:testrail:1201", "test-execution:testrail:result:7701", "executed_by"],
    ],
  );
});

test("keeps every unapproved TestRail status ID unknown", async () => {
  const normalizer = new TestRailNormalizer();

  for (const statusId of [1, 2, 3, 4, 5, 99]) {
    const record: RawEvidenceRecord = {
      ...executionFixture.result,
      sourceId: String(8000 + statusId),
      payload: {
        id: 8000 + statusId,
        status_id: statusId,
      },
    };
    const result = await normalizer.normalize(record);
    assert.deepEqual(
      result.claims.map((claim) => [claim.attribute, claim.value]),
      [["status_id", String(statusId)], ["status", "unknown"]],
    );
    assert.deepEqual(result.traceLinks, []);
  }
});

test("supports the current connector run/result fixtures without inventing parent links", async () => {
  const normalizer = new TestRailNormalizer();
  const run = connectorFixture.runs[0];
  const sourceResult = connectorFixture.results[0];
  const runRecord: RawEvidenceRecord = {
    tenantId: "solera",
    productId: "fl-titling",
    source: "testrail",
    sourceId: String(run.id),
    sourceVersion: String(run.updated_on),
    observedAt: "2026-09-15T12:00:00.000Z",
    contentType: "testrail.run",
    contentHash: "sha256-connector-fixture-run",
    payload: run,
    classification: "internal",
  };
  const resultRecord: RawEvidenceRecord = {
    tenantId: "solera",
    productId: "fl-titling",
    source: "testrail",
    sourceId: String(sourceResult.id),
    sourceVersion: String(sourceResult.created_on),
    observedAt: "2026-09-15T12:00:00.000Z",
    contentType: "testrail.result",
    contentHash: "sha256-connector-fixture-result",
    payload: sourceResult,
    classification: "internal",
  };

  assert.deepEqual((await normalizer.normalize(runRecord)).traceLinks, []);
  assert.deepEqual((await normalizer.normalize(resultRecord)).traceLinks, []);
});

test("rejects malformed payloads and ignores unsupported resource types", async () => {
  const normalizer = new TestRailNormalizer();
  const malformedCase = {
    ...fixture.case,
    payload: { suite_id: 12, title: "Missing case ID" },
  };
  const unsupportedRecord = {
    ...fixture.case,
    sourceId: "7701",
    contentType: "testrail.attachment",
    payload: { id: 7701, name: "Unsupported artifact" },
  };

  assert.equal(normalizer.supports(malformedCase), false);
  assert.equal(normalizer.supports(unsupportedRecord), false);
  assert.equal(normalizeTestRailRecord(malformedCase), null);
  assert.equal(normalizeTestRailRecord(unsupportedRecord), null);
  await assert.rejects(() => normalizer.normalize(malformedCase));
  await assert.rejects(() => normalizer.normalize(unsupportedRecord));
});
