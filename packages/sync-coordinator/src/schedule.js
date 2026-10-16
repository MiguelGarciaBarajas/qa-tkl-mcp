import { SyncConfigurationError } from "./errors.js";

/**
 * Scheduling semantics for OPS-101.
 *
 * This package deliberately contains **no timer, no daemon, and no sleep**.
 * A scheduled incremental sync is exactly one `coordinator.runOnce()` call
 * per external trigger (a cron entry, a Kubernetes CronJob, a CI schedule,
 * an Azure/AWS scheduled job, or an operator running the CLI). The reasons
 * are operational, not stylistic:
 *
 * - An embedded daemon would own retries, backoff, missed-tick catch-up,
 *   and process supervision -- all things the deployment platform already
 *   does better, and none of which this repository has an approved target
 *   for yet.
 * - A run that is one `runOnce()` call is bounded, observable, and
 *   restartable: it returns a summary, sets a process exit code, and leaves
 *   nothing running.
 * - Overlapping ticks are handled explicitly (see `./locks.js`) instead of
 *   implicitly by an internal scheduler queue.
 *
 * The schedule object below is therefore *descriptive metadata* used to
 * document and validate the externally configured cadence -- it never causes
 * this process to wait for a future time.
 *
 * The concrete cadence (and the retention horizon in `./retention.js`) is a
 * pending external decision: see the "External Decisions Register" row
 * "Deployment target, schedule, retention, and audit destination" in
 * `docs/team/TKL-Delivery-Backlog.md`. Until a platform/project owner
 * approves one, the schedule stays `pending-external-input` and no cron
 * expression is invented here.
 */

export const SCHEDULE_CADENCES = Object.freeze(["external-cron", "external-interval", "manual"]);
export const SCHEDULE_STATUSES = Object.freeze(["ready", "pending-external-input"]);
export const OVERLAP_POLICIES = Object.freeze(["skip", "fail"]);

export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 10_000;

const CRON_FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SyncConfigurationError(
        `${field} contains unsupported key "${key}"; supported keys: ${allowed.join(", ")}`,
      );
    }
  }
  return value;
}

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new SyncConfigurationError(`sync.${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function assertPositiveInteger(value, field, { max } = {}) {
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    throw new SyncConfigurationError(
      `sync.${field} must be a positive integer${max !== undefined ? ` no greater than ${max}` : ""}`,
    );
  }
  return value;
}

function assertNullableCount(value, field, { max } = {}) {
  if (value === undefined || value === null) return null;
  return assertPositiveInteger(value, field, { max });
}

/**
 * Validates a standard five-field cron expression (minute, hour,
 * day-of-month, month, day-of-week) supporting `*`, ranges, lists, and
 * steps. This never *executes* the expression; it only refuses to record a
 * cadence that the external job runner would reject or that an operator
 * mistyped, so a run summary can never advertise a schedule that does not
 * exist.
 */
export function assertCronExpression(expression) {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new SyncConfigurationError("sync.schedule.cron must be a non-empty string");
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new SyncConfigurationError(
      "sync.schedule.cron must have exactly five fields (minute hour day-of-month month day-of-week)",
    );
  }
  fields.forEach((field, index) => {
    const bounds = CRON_FIELD_BOUNDS[index];
    for (const part of field.split(",")) {
      if (part.length === 0) {
        throw new SyncConfigurationError(`sync.schedule.cron ${bounds.name} field is malformed`);
      }
      const [range, step, ...extra] = part.split("/");
      if (extra.length > 0) {
        throw new SyncConfigurationError(`sync.schedule.cron ${bounds.name} field is malformed`);
      }
      if (step !== undefined && !/^[1-9]\d*$/.test(step)) {
        throw new SyncConfigurationError(
          `sync.schedule.cron ${bounds.name} step must be a positive integer`,
        );
      }
      if (range === "*") continue;
      const values = range.split("-");
      if (values.length > 2) {
        throw new SyncConfigurationError(`sync.schedule.cron ${bounds.name} range is malformed`);
      }
      for (const value of values) {
        if (!/^\d+$/.test(value)) {
          throw new SyncConfigurationError(
            `sync.schedule.cron ${bounds.name} field must contain numbers, ranges, lists, or "*"`,
          );
        }
        const numeric = Number(value);
        if (numeric < bounds.min || numeric > bounds.max) {
          throw new SyncConfigurationError(
            `sync.schedule.cron ${bounds.name} value must be between ${bounds.min} and ${bounds.max}`,
          );
        }
      }
      if (values.length === 2 && Number(values[0]) > Number(values[1])) {
        throw new SyncConfigurationError(
          `sync.schedule.cron ${bounds.name} range must not be descending`,
        );
      }
    }
  });
  return expression.trim();
}

function resolveSchedule(raw) {
  const schedule = isPlainObject(raw) ? raw : {};
  assertKnownKeys(
    schedule,
    ["cadence", "configurationStatus", "timezone", "cron", "intervalMinutes"],
    "sync.schedule",
  );
  const cadence = assertOneOf(schedule.cadence ?? "external-cron", SCHEDULE_CADENCES, "schedule.cadence");
  const configurationStatus = assertOneOf(
    schedule.configurationStatus ?? "pending-external-input",
    SCHEDULE_STATUSES,
    "schedule.configurationStatus",
  );
  const timezone = schedule.timezone ?? "UTC";
  if (typeof timezone !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timezone)) {
    throw new SyncConfigurationError("sync.schedule.timezone must be a valid timezone identifier");
  }

  const cron = schedule.cron === undefined || schedule.cron === null ? null : assertCronExpression(schedule.cron);
  const intervalMinutes = assertNullableCount(
    schedule.intervalMinutes,
    "schedule.intervalMinutes",
    { max: 60 * 24 * 31 },
  );

  // Fail closed on a cadence that claims to be approved but carries no
  // actual trigger definition, and on a trigger definition that does not
  // match the declared cadence. Either one would make the documented
  // schedule a fiction.
  if (configurationStatus === "ready") {
    if (cadence === "external-cron" && cron === null) {
      throw new SyncConfigurationError(
        'sync.schedule.configurationStatus "ready" with cadence "external-cron" requires sync.schedule.cron',
      );
    }
    if (cadence === "external-interval" && intervalMinutes === null) {
      throw new SyncConfigurationError(
        'sync.schedule.configurationStatus "ready" with cadence "external-interval" requires ' +
          "sync.schedule.intervalMinutes",
      );
    }
  }
  if (cadence === "external-cron" && intervalMinutes !== null) {
    throw new SyncConfigurationError(
      'sync.schedule.intervalMinutes must not be set for cadence "external-cron"',
    );
  }
  if (cadence === "external-interval" && cron !== null) {
    throw new SyncConfigurationError(
      'sync.schedule.cron must not be set for cadence "external-interval"',
    );
  }
  if (cadence === "manual" && (cron !== null || intervalMinutes !== null)) {
    throw new SyncConfigurationError(
      'sync.schedule.cron/intervalMinutes must not be set for cadence "manual"',
    );
  }

  return Object.freeze({
    cadence,
    configurationStatus,
    timezone,
    cron,
    intervalMinutes,
    /** This package never runs a timer; the trigger is always external. */
    embeddedScheduler: false,
  });
}

function resolveRetention(raw) {
  const retention = isPlainObject(raw) ? raw : {};
  assertKnownKeys(retention, ["mode", "rawEvidenceMaxAgeDays", "historyMaxEntries"], "sync.retention");
  const mode = retention.mode ?? "report-only";
  if (mode !== "report-only") {
    throw new SyncConfigurationError(
      'sync.retention.mode must be "report-only": the durable raw-evidence store exposes no ' +
        "deletion API, and raw evidence is immutable provenance for canonical knowledge, so this " +
        "coordinator plans and reports retention instead of deleting",
    );
  }
  return Object.freeze({
    mode,
    rawEvidenceMaxAgeDays: assertNullableCount(
      retention.rawEvidenceMaxAgeDays,
      "retention.rawEvidenceMaxAgeDays",
      { max: 36_500 },
    ),
    historyMaxEntries: assertNullableCount(retention.historyMaxEntries, "retention.historyMaxEntries", {
      max: 10_000_000,
    }),
  });
}

/**
 * Validates and freezes the coordinator's operational settings. Input comes
 * from an operations configuration file (`config/operations/sync.json`) or
 * from explicit call-site options -- deliberately *not* from the ARCH-103
 * product configuration, whose schema (`assertProductConfiguration`) rejects
 * unknown top-level keys and is owned by the Architecture and Contracts
 * workstream.
 */
export function resolveSyncSettings(raw = {}, overrides = {}) {
  if (!isPlainObject(raw)) {
    throw new SyncConfigurationError("sync settings must be an object");
  }
  if (!isPlainObject(overrides)) {
    throw new SyncConfigurationError("sync setting overrides must be an object");
  }
  const merged = { ...raw, ...overrides };
  assertKnownKeys(
    merged,
    [
      "batchSize",
      "maxRecordsPerConnector",
      "maxDurationMs",
      "overlapPolicy",
      "schedule",
      "retention",
    ],
    "sync settings",
  );
  return Object.freeze({
    batchSize: assertPositiveInteger(merged.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize", {
      max: MAX_BATCH_SIZE,
    }),
    /**
     * Safety cap for one run, not a progress mechanism: when it stops a
     * connector early the run is reported as `truncated` (a non-success
     * status), because whether the *next* run gets further depends on that
     * connector resuming from a mid-stream cursor -- which the production
     * connectors deliberately do not do (they replay from page zero so a
     * reordered source can never permanently skip evidence).
     */
    maxRecordsPerConnector: assertNullableCount(
      merged.maxRecordsPerConnector,
      "maxRecordsPerConnector",
      { max: 10_000_000 },
    ),
    maxDurationMs: assertNullableCount(
      merged.maxDurationMs,
      "maxDurationMs",
      { max: 86_400_000 },
    ),
    overlapPolicy: assertOneOf(merged.overlapPolicy ?? "skip", OVERLAP_POLICIES, "overlapPolicy"),
    schedule: resolveSchedule(merged.schedule),
    retention: resolveRetention(merged.retention),
  });
}

/**
 * Human/operator-facing description of the configured cadence, suitable for
 * a runbook, a CLI `--print-schedule`, or an audit record. Contains no
 * credentials, no paths, and no source data.
 */
export function describeSchedule(schedule) {
  const trigger =
    schedule.cadence === "external-cron"
      ? schedule.cron === null
        ? "no cron expression approved yet"
        : `cron "${schedule.cron}" (${schedule.timezone})`
      : schedule.cadence === "external-interval"
        ? schedule.intervalMinutes === null
          ? "no interval approved yet"
          : `every ${schedule.intervalMinutes} minute(s)`
        : "operator-triggered only";
  return {
    cadence: schedule.cadence,
    configurationStatus: schedule.configurationStatus,
    trigger,
    embeddedScheduler: false,
    invocation: "one runOnce() call per external trigger",
    overlapHandling: "in-process lock per tenant/product/connector; one ingestion process per scope",
  };
}

/**
 * Fail-closed assertion for callers that must not proceed on an unapproved
 * cadence (for example a deployment readiness check). Running a sync
 * manually is always allowed and never passes through this; only a claim
 * that an *automated* schedule exists does.
 */
export function assertScheduleApproved(schedule) {
  if (schedule.configurationStatus !== "ready") {
    throw new SyncConfigurationError(
      "No automated sync schedule is approved yet: sync.schedule.configurationStatus is " +
        `"${schedule.configurationStatus}". See the "External Decisions Register" row ` +
        '"Deployment target, schedule, retention, and audit destination" in ' +
        "docs/team/TKL-Delivery-Backlog.md.",
    );
  }
  return schedule;
}
