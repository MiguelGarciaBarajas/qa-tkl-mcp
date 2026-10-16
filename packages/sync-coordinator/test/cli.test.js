import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

/**
 * CLI coverage for the OPS-101 operator entry point. Only invocations that
 * are safe without live access are exercised: help, the schedule
 * descriptor, fail-closed validation, and a dry-run plan (which contacts no
 * source and commits nothing). A real incremental run against a live source
 * is deliberately not tested here -- that requires approved credentials and
 * is covered by the runbook, not by the suite.
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../bin/run-sync.js", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../../config/products/fl-titling.json", import.meta.url));
// Deterministic, test-only AES-256 key material for the durable store.
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

const scratchRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
mkdirSync(scratchRoot, { recursive: true });
const dataDirectory = mkdtempSync(join(scratchRoot, "ops-101-cli-"));

test.after(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

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

test("prints usage that documents the external-trigger model", async () => {
  const { code, stdout } = await runCli(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /--confirm-replay/);
  assert.match(stdout, /--max-duration-ms/);
  assert.match(stdout, /exactly one --connector/);
  assert.match(stdout, /Exit codes/);
});

test("prints the configured scheduling semantics without needing storage or credentials", async () => {
  const { code, stdout } = await runCli(["--print-schedule"]);
  assert.equal(code, 0);
  const schedule = JSON.parse(stdout);
  assert.equal(schedule.embeddedScheduler, false);
  assert.equal(schedule.configurationStatus, "pending-external-input");
  assert.equal(schedule.invocation, "one runOnce() call per external trigger");
});

test("fails closed, and without leaking a path, when durable storage is not configured", async () => {
  const { code, stderr } = await runCli(["--dry-run"], {
    TKL_RAW_EVIDENCE_DIR: "",
    TKL_RAW_EVIDENCE_KEY_REF: "",
  });
  assert.equal(code, 1);
  assert.match(stderr, /data directory/);
  assert.equal(stderr.includes("secret://"), false);
});

test("rejects an unconfirmed replay before touching a source", async () => {
  const { code, stderr } = await runCli(
    ["--config", CONFIG_PATH, "--mode", "replay-full", "--data-directory", dataDirectory, "--key-ref", "env://TKL_TEST_RAW_EVIDENCE_KEY"],
    { TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY },
  );
  assert.equal(code, 1);
  assert.match(stderr, /requires an explicit confirmReplay/);
});

test("rejects replay without exactly one connector and a finite record cap", async () => {
  const missingConnector = await runCli(
    ["--config", CONFIG_PATH, "--mode", "replay-full", "--confirm-replay"],
  );
  assert.equal(missingConnector.code, 1);
  assert.match(missingConnector.stderr, /exactly one --connector/);

  const missingCap = await runCli(
    [
      "--config",
      CONFIG_PATH,
      "--mode",
      "replay-full",
      "--confirm-replay",
      "--connector",
      "connector.github",
    ],
  );
  assert.equal(missingCap.code, 1);
  assert.match(missingCap.stderr, /finite --max-records/);
});

test("plans a dry run against the durable store without contacting a source", async () => {
  const { code, stdout, stderr } = await runCli(
    [
      "--config",
      CONFIG_PATH,
      "--dry-run",
      "--data-directory",
      dataDirectory,
      "--key-ref",
      "env://TKL_TEST_RAW_EVIDENCE_KEY",
    ],
    { TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY },
  );

  assert.equal(code, 0);
  // stdout must stay a single parseable JSON document even with auditing on:
  // audit events belong on stderr.
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "planned");
  assert.equal(summary.dryRun, true);
  assert.equal(summary.connectors[0].connectorId, "connector.github");
  assert.equal(summary.connectors[0].storedCheckpointPresent, false);
  assert.equal(stdout.includes("secret://"), false);

  const auditLines = stderr
    .split("\n")
    // Node's own `--experimental-strip-types` warning also lands on stderr.
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.ok(auditLines.some((event) => event.eventType === "sync.run.planned"));
  assert.equal(stderr.includes("secret://"), false);
});

test("suppresses audit events when the audit destination is explicitly disabled", async () => {
  const { code, stdout, stderr } = await runCli(
    [
      "--config",
      CONFIG_PATH,
      "--dry-run",
      "--data-directory",
      dataDirectory,
      "--key-ref",
      "env://TKL_TEST_RAW_EVIDENCE_KEY",
    ],
    { TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY, TKL_AUDIT_DESTINATION: "none" },
  );

  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).status, "planned");
  assert.equal(stderr.split("\n").filter((line) => line.startsWith("{")).length, 0);
});

test("prints a non-destructive retention report", async () => {
  const { code, stdout } = await runCli(
    [
      "--config",
      CONFIG_PATH,
      "--retention-report",
      "--data-directory",
      dataDirectory,
      "--key-ref",
      "env://TKL_TEST_RAW_EVIDENCE_KEY",
    ],
    { TKL_TEST_RAW_EVIDENCE_KEY: TEST_KEY },
  );

  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.reportType, "sync.retention.plan");
  assert.equal(report.pruneSupported, false);
  assert.equal(report.deletedCount, 0);
});
