import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_BATCH_SIZE,
  SCHEDULE_CADENCES,
  SyncConfigurationError,
  assertCronExpression,
  assertScheduleApproved,
  describeSchedule,
  resolveSyncSettings,
} from "../src/index.js";

const SHIPPED_SYNC_SETTINGS_PATH = fileURLToPath(
  new URL("../../../config/operations/sync.json", import.meta.url),
);

test("defaults to an externally triggered cadence with no embedded scheduler", () => {
  const settings = resolveSyncSettings();
  assert.equal(settings.schedule.cadence, "external-cron");
  assert.equal(settings.schedule.configurationStatus, "pending-external-input");
  assert.equal(settings.schedule.embeddedScheduler, false);
  assert.equal(settings.schedule.cron, null);
  assert.equal(settings.batchSize, DEFAULT_BATCH_SIZE);
  assert.equal(settings.overlapPolicy, "skip");
  assert.deepEqual(SCHEDULE_CADENCES, ["external-cron", "external-interval", "manual"]);
});

test("describes the schedule for an operator without inventing a cadence", () => {
  const pending = describeSchedule(resolveSyncSettings().schedule);
  assert.equal(pending.trigger, "no cron expression approved yet");
  assert.equal(pending.embeddedScheduler, false);
  assert.equal(pending.invocation, "one runOnce() call per external trigger");

  const approved = describeSchedule(
    resolveSyncSettings({
      schedule: { cadence: "external-cron", configurationStatus: "ready", cron: "0 */4 * * *" },
    }).schedule,
  );
  assert.match(approved.trigger, /^cron "0 \*\/4 \* \* \*" \(UTC\)$/);
});

test("fails closed on a schedule that claims to be approved but defines no trigger", () => {
  assert.throws(
    () => resolveSyncSettings({ schedule: { configurationStatus: "ready" } }),
    SyncConfigurationError,
  );
  assert.throws(
    () =>
      resolveSyncSettings({
        schedule: { cadence: "external-interval", configurationStatus: "ready" },
      }),
    SyncConfigurationError,
  );
  assert.throws(
    () => resolveSyncSettings({ schedule: { cadence: "manual", cron: "* * * * *" } }),
    SyncConfigurationError,
  );
  assert.throws(
    () => resolveSyncSettings({ schedule: { cadence: "external-cron", intervalMinutes: 30 } }),
    SyncConfigurationError,
  );
});

test("validates cron expressions instead of recording a cadence the runner would reject", () => {
  assert.equal(assertCronExpression(" 15 2 * * 1-5 "), "15 2 * * 1-5");
  assert.equal(assertCronExpression("*/10 * * * *"), "*/10 * * * *");
  for (const invalid of [
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "5-1 * * * *",
    "*/0 * * * *",
    "* * * * * *",
    "@daily",
    "",
  ]) {
    assert.throws(() => assertCronExpression(invalid), SyncConfigurationError, `expected "${invalid}" to fail`);
  }
});

test("rejects unsupported settings keys rather than silently ignoring them", () => {
  assert.throws(() => resolveSyncSettings({ batchsize: 10 }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ schedule: { every: "5m" } }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ retention: { keepDays: 30 } }), SyncConfigurationError);
});

test("rejects destructive retention modes and unbounded batch sizes", () => {
  assert.throws(() => resolveSyncSettings({ retention: { mode: "prune" } }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ retention: { mode: "delete" } }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ batchSize: 0 }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ batchSize: 10_001 }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ maxRecordsPerConnector: -1 }), SyncConfigurationError);
  assert.throws(() => resolveSyncSettings({ maxDurationMs: 0 }), SyncConfigurationError);
  assert.equal(resolveSyncSettings({ maxDurationMs: 5_000 }).maxDurationMs, 5_000);
});

test("refuses to assert an approved schedule while the cadence is a pending external decision", () => {
  const settings = resolveSyncSettings();
  assert.throws(() => assertScheduleApproved(settings.schedule), SyncConfigurationError);
  const approved = resolveSyncSettings({
    schedule: { configurationStatus: "ready", cron: "0 3 * * *" },
  });
  assert.equal(assertScheduleApproved(approved.schedule), approved.schedule);
});

test("the shipped operations configuration validates and stays non-destructive", () => {
  const file = JSON.parse(readFileSync(SHIPPED_SYNC_SETTINGS_PATH, "utf8"));
  const settings = resolveSyncSettings(file["fl-titling"]);
  assert.equal(settings.schedule.configurationStatus, "pending-external-input");
  assert.equal(settings.schedule.cron, null);
  assert.equal(settings.retention.mode, "report-only");
  assert.equal(settings.retention.rawEvidenceMaxAgeDays, null);
  assert.equal(settings.retention.historyMaxEntries, null);
});
