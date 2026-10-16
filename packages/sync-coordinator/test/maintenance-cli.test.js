import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { createPersistentRawEvidenceStore } from "@tkl/raw-evidence-store";
import { createRawEvidenceRecord, sha256 } from "@tkl/contracts";

/**
 * CLI coverage for the P4 maintenance entry point. Exercises the raw-only
 * commands end-to-end against a real durable store: help, status, a bounded
 * compaction, and a non-mutating reconciliation. Knowledge-tier paths are
 * covered by the reconcile/rebuild unit suites.
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../bin/run-maintenance.js", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../../config/products/fl-titling.json", import.meta.url));
const KEY_REF = "env://TKL_TEST_RAW_EVIDENCE_KEY";
const TEST_KEY = Buffer.alloc(32, 11);
const TEST_KEY_B64 = TEST_KEY.toString("base64");

const scratchRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
mkdirSync(scratchRoot, { recursive: true });

function newDataDirectory() {
  return mkdtempSync(join(scratchRoot, "p4-maintenance-cli-"));
}

async function seedEvidence(dataDirectory, count) {
  const store = await createPersistentRawEvidenceStore({
    dataDirectory,
    tenantId: "solera",
    productId: "fl-titling",
    keyRef: KEY_REF,
    resolveKey: () => TEST_KEY,
  });
  for (let index = 0; index < count; index += 1) {
    await store.commit({
      connectorId: "connector.github",
      records: [
        createRawEvidenceRecord({
          tenantId: "solera",
          productId: "fl-titling",
          source: "github",
          sourceId: `item-${index}`,
          sourceVersion: "v1",
          observedAt: "2026-05-10T00:00:00.000Z",
          contentType: "fixture.item",
          payload: { index },
          classification: "internal",
          idempotencyKey: sha256(`fixture:item-${index}`),
        }),
      ],
      checkpoint: { page: index },
    });
  }
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", CLI_PATH, ...args],
      { env: { ...process.env, ...env } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function baseArgs(command, dataDirectory) {
  return [command, "--config", CONFIG_PATH, "--data-directory", dataDirectory, "--key-ref", KEY_REF];
}

test("prints usage listing every maintenance command", async () => {
  const { code, stdout } = await runCli(["help"]);
  assert.equal(code, 0);
  for (const command of ["status", "compact", "reconcile", "repair", "rebuild-gold"]) {
    assert.ok(stdout.includes(command), `usage should mention ${command}`);
  }
});

test("status reports the compaction posture as sanitized JSON", async () => {
  const dataDirectory = newDataDirectory();
  try {
    await seedEvidence(dataDirectory, 3);
    const { code, stdout } = await runCli(baseArgs("status", dataDirectory), {
      TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY_B64,
    });
    assert.equal(code, 0);
    const status = JSON.parse(stdout);
    assert.equal(status.reportType, "evidence.maintenance.status");
    assert.equal(status.chunkFileCount, 3);
    assert.equal(status.recordCount, 3);
    assert.equal(status.generation, 0);
    assert.equal(stdout.includes("/"), false);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("compact folds chunks and a follow-up dry-run is a no-op skip", async () => {
  const dataDirectory = newDataDirectory();
  try {
    await seedEvidence(dataDirectory, 4);
    const compacted = await runCli(baseArgs("compact", dataDirectory), {
      TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY_B64,
    });
    assert.equal(compacted.code, 0);
    const result = JSON.parse(compacted.stdout);
    assert.equal(result.status, "compacted");
    assert.equal(result.chunkFilesFolded, 4);
    assert.equal(result.chunkFilesRemaining, 0);

    const rerun = await runCli(baseArgs("compact", dataDirectory), {
      TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY_B64,
    });
    const rerunResult = JSON.parse(rerun.stdout);
    assert.equal(rerunResult.status, "skipped");
    assert.equal(rerunResult.reason, "below-threshold");

    // Audit events land on stderr, keeping stdout a single JSON document.
    assert.ok(compacted.stderr.includes("maintenance.compacted"));
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("reconcile reports raw findings without mutating and exits 0 when clean", async () => {
  const dataDirectory = newDataDirectory();
  try {
    await seedEvidence(dataDirectory, 2);
    const { code, stdout } = await runCli(baseArgs("reconcile", dataDirectory), {
      TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY_B64,
    });
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.reportType, "evidence.reconciliation");
    assert.equal(report.bronze.recordCount, 2);
    assert.equal(report.bronze.pendingProjection, 2);
    assert.match(report.bronze.evidenceChecksum, /^[0-9a-f]{64}$/);
    assert.ok(report.findings.some((f) => f.code === "raw.pending-projection-backlog"));
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("fails closed without leaking a path when storage is not configured", async () => {
  const { code, stderr } = await runCli(["status", "--config", CONFIG_PATH], {
    TKL_RAW_EVIDENCE_DIR: "",
    TKL_RAW_EVIDENCE_KEY_REF: "",
  });
  assert.equal(code, 1);
  assert.match(stderr, /data directory/);
  assert.equal(stderr.includes("secret://"), false);
});
