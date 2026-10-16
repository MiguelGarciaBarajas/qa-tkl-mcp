import assert from "node:assert/strict";
import test from "node:test";
import { createRawEvidenceRecord } from "@tkl/contracts";
import { TklApplicationService } from "../src/index.js";

const evidence = createRawEvidenceRecord({
  tenantId: "tenant-test",
  productId: "fl-titling",
  source: "jira",
  sourceId: "STT-100",
  sourceVersion: "1",
  observedAt: "2026-09-10T16:00:00.000Z",
  contentType: "jira.issue",
  payload: { summary: "Fixture" },
  classification: "internal",
});

test("fails explicitly when ingestion has no configured normalizers", async () => {
  const service = new TklApplicationService();
  await assert.rejects(
    service.ingest([evidence]),
    /At least one normalizer must be configured/,
  );
});

test("fails explicitly when no configured normalizer supports a record", async () => {
  const service = new TklApplicationService({
    normalizers: [() => null],
  });
  await assert.rejects(
    service.ingest([evidence]),
    /No configured normalizer supports jira:jira\.issue/,
  );
});

test("skips unsupported evidence only when the caller explicitly opts in", async () => {
  const service = new TklApplicationService({
    normalizers: [() => null],
    unsupportedRecordPolicy: "skip",
  });

  const result = await service.ingest([evidence]);
  assert.deepEqual(service.store.listEntities("fl-titling"), []);
  assert.deepEqual(result, { entities: [], claims: [], traceLinks: [] });
});

test("returns the canonical records affected by ingestion", async () => {
  const normalized = {
    entities: [{
      id: "requirement:STT-100",
      tenantId: "tenant-test",
      productId: "fl-titling",
      type: "requirement",
      title: "Fixture",
      provenance: {
        source: "jira",
        sourceId: "STT-100",
        sourceVersion: "1",
        observedAt: "2026-09-10T16:00:00.000Z",
        contentHash: evidence.contentHash,
        normalizerId: "fixture",
        normalizerVersion: "0.1.0",
      },
    }],
    claims: [],
    traceLinks: [],
  };
  const service = new TklApplicationService({
    normalizers: [() => normalized],
  });

  assert.deepEqual(await service.ingest([evidence]), normalized);
});
