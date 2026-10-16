#!/usr/bin/env node
/**
 * OPS-101 operator CLI: runs, plans, or reports on one scheduled sync for a
 * single tenant/product scope, then exits. This is the unit of work an
 * external cron/job runner invokes -- it starts no timer, holds no lease
 * beyond the process, and leaves nothing running.
 *
 * Credentials are never accepted as arguments or printed. Both the source
 * credential and the raw-evidence encryption key are *references*
 * (`secret://...`/`env://...`) resolved at runtime through
 * `@tkl/ops`'s environment-backed secret resolver, which fails closed when
 * the mapped environment variable is missing.
 *
 * Output is the same sanitized JSON summary the library returns: counts,
 * identifiers, timestamps, and enum values only, printed to stdout as a
 * single JSON document. Audit events go to stderr so stdout stays
 * parseable. Failures print an error name (and, for this package's own
 * fail-closed validation errors, the validation message) but never a raw
 * connector/filesystem error, which could embed a path, a URL, or a
 * response body.
 *
 * Node <22.18.0 must run this with `--experimental-strip-types`
 * (`npm run sync:run -- ...` does), because `@tkl/raw-evidence-store`
 * publishes TypeScript sources.
 */
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAuditLogger, createHealthRegistry } from "../../observability/src/index.js";
import { createAuditSink, createEnvCredentialResolver } from "../../ops/src/index.js";
import { createPersistentRawEvidenceStore } from "@tkl/raw-evidence-store";
import { createSyncCoordinator } from "../src/index.js";
import {
  ReplayConfirmationRequiredError,
  RetentionPolicyError,
  SyncConfigurationError,
  SyncRunConflictError,
} from "../src/errors.js";
import { SanitizationError } from "../src/sanitize.js";
import { describeSchedule, resolveSyncSettings } from "../src/schedule.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const USAGE = `Usage: node [--experimental-strip-types] packages/sync-coordinator/bin/run-sync.js [options]

  --product <id>            Product configuration to load from config/products (default: fl-titling)
  --config <path>           Explicit product configuration file (overrides --product)
  --sync-config <path>      Operations sync settings file (default: config/operations/sync.json)
  --connector <id>          Restrict the run to this enabled connector (repeatable)
  --mode <mode>             incremental | replay-from-checkpoint | replay-full (default: incremental)
  --confirm-replay          Required opt-in for any replay mode
  --dry-run                 Plan only: contacts no source, commits nothing, takes no lock
  --retention-report        Print the non-destructive retention report and exit
  --print-schedule          Print the configured scheduling semantics and exit
  --data-directory <path>   Raw evidence data directory (or TKL_RAW_EVIDENCE_DIR)
  --key-ref <reference>     Raw evidence encryption key reference (or TKL_RAW_EVIDENCE_KEY_REF)
  --batch-size <n>          Records per atomic commit
  --max-records <n>         Stop each connector after this many records (safety cap;
                            reports a truncated, non-success run -- see the runbook)
  --max-duration-ms <n>     Stop each connector after this elapsed duration in milliseconds
                            (reports a truncated, non-success run)
  --overlap-policy <p>      skip | fail (default: from sync settings)
  --help                    Print this help

The run summary is printed to stdout as a single JSON document; audit events go to
stderr. Exit codes: 0 = completed, planned, or skipped because a run was already in
progress; 1 = at least one connector failed or stopped before finishing its source
(--max-records / --max-duration-ms), or the invocation was rejected.

Replay modes require --confirm-replay, exactly one --connector, and --max-records.
`;

const KNOWN_SAFE_ERRORS = new Set([
  SyncConfigurationError,
  SyncRunConflictError,
  ReplayConfirmationRequiredError,
  RetentionPolicyError,
  SanitizationError,
]);

function isSafeToPrint(error) {
  for (const type of KNOWN_SAFE_ERRORS) {
    if (error instanceof type) return true;
  }
  return false;
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJsonFile(path) {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function positiveIntegerOption(raw, name) {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new SyncConfigurationError(`--${name} must be a positive integer`);
  }
  return Number(raw);
}

/**
 * Audit events go to **stderr**, never stdout: stdout is reserved for the
 * single machine-readable JSON document this CLI prints (a run summary,
 * plan, retention report, or schedule descriptor), so a job runner can pipe
 * it straight into a parser. Job runners capture stderr as well, so the
 * events still reach the log pipeline. `TKL_AUDIT_DESTINATION=none`
 * (test-only, per `@tkl/ops`) disables them; the stdout/console
 * destinations used by long-running services are deliberately not honored
 * here because they would corrupt this contract.
 */
function createCliAuditSink(destination) {
  if (destination === "none") return createAuditSink({ destination: "none" });
  return {
    info(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      product: { type: "string" },
      config: { type: "string" },
      "sync-config": { type: "string" },
      connector: { type: "string", multiple: true },
      mode: { type: "string" },
      "confirm-replay": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "retention-report": { type: "boolean", default: false },
      "print-schedule": { type: "boolean", default: false },
      "data-directory": { type: "string" },
      "key-ref": { type: "string" },
      "batch-size": { type: "string" },
      "max-records": { type: "string" },
      "max-duration-ms": { type: "string" },
      "overlap-policy": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const productId = values.product ?? "fl-titling";
  const configurationPath = values.config
    ? resolvePath(process.cwd(), values.config)
    : resolvePath(repositoryRoot, "config", "products", `${productId}.json`);
  const syncConfigurationPath = values["sync-config"]
    ? resolvePath(process.cwd(), values["sync-config"])
    : resolvePath(repositoryRoot, "config", "operations", "sync.json");

  const syncSettingsFile = (await readOptionalJsonFile(syncConfigurationPath)) ?? {};
  const syncSettings = syncSettingsFile[productId] ?? syncSettingsFile.default ?? syncSettingsFile;

  if (values["print-schedule"]) {
    const settings = resolveSyncSettings(syncSettings);
    process.stdout.write(`${JSON.stringify(describeSchedule(settings.schedule), null, 2)}\n`);
    return 0;
  }

  const configuration = await readJsonFile(configurationPath);
  const mode = values.mode ?? "incremental";
  const maxRecordsPerConnector = positiveIntegerOption(values["max-records"], "max-records");
  const maxDurationMs = positiveIntegerOption(values["max-duration-ms"], "max-duration-ms");
  const replayMode = mode === "replay-from-checkpoint" || mode === "replay-full";
  if (replayMode && values["dry-run"] !== true && values["confirm-replay"] !== true) {
    throw new ReplayConfirmationRequiredError(mode);
  }
  if (replayMode && values["dry-run"] !== true) {
    if (values.connector?.length !== 1) {
      throw new SyncConfigurationError("Replay modes require exactly one --connector");
    }
    if (maxRecordsPerConnector === undefined) {
      throw new SyncConfigurationError("Replay modes require a finite --max-records safety cap");
    }
  }

  const dataDirectory = values["data-directory"] ?? env.TKL_RAW_EVIDENCE_DIR;
  const keyRef = values["key-ref"] ?? env.TKL_RAW_EVIDENCE_KEY_REF;
  if (!dataDirectory || !keyRef) {
    throw new SyncConfigurationError(
      "A raw evidence data directory (--data-directory / TKL_RAW_EVIDENCE_DIR) and encryption key " +
        "reference (--key-ref / TKL_RAW_EVIDENCE_KEY_REF) are required; the coordinator never " +
        "falls back to non-durable or unencrypted storage",
    );
  }

  const secrets = createEnvCredentialResolver({ env });
  const resolveCredential = (reference) => secrets.resolve(reference);
  const store = await createPersistentRawEvidenceStore({
    tenantId: configuration.tenantId,
    productId: configuration.productId,
    dataDirectory: resolvePath(process.cwd(), dataDirectory),
    keyRef,
    resolveKey: (reference) => secrets.resolve(reference),
  });

  const dependencies = Object.fromEntries(
    (configuration.enabledPlugins ?? [])
      .filter((pluginId) => pluginId.startsWith("connector."))
      .map((pluginId) => [pluginId, { resolveCredential }]),
  );

  const coordinator = createSyncCoordinator({
    configuration,
    store,
    sync: syncSettings,
    syncOverrides: {
      ...(positiveIntegerOption(values["batch-size"], "batch-size") === undefined
        ? {}
        : { batchSize: positiveIntegerOption(values["batch-size"], "batch-size") }),
      ...(values["overlap-policy"] === undefined ? {} : { overlapPolicy: values["overlap-policy"] }),
    },
    dependencies,
    auditLogger: createAuditLogger({ sink: createCliAuditSink(env.TKL_AUDIT_DESTINATION) }),
    healthRegistry: createHealthRegistry(),
  });

  if (values["retention-report"]) {
    process.stdout.write(`${JSON.stringify(coordinator.planRetention(), null, 2)}\n`);
    return 0;
  }

  const summary = await coordinator.runOnce({
    mode,
    confirmReplay: values["confirm-replay"] === true,
    dryRun: values["dry-run"] === true,
    ...(values.connector === undefined ? {} : { connectorIds: values.connector }),
    ...(maxRecordsPerConnector === undefined
      ? {}
      : { maxRecordsPerConnector }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.status === "failed" || summary.status === "partial" ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        isSafeToPrint(error)
          ? `sync: ${error.message}\n`
          : `sync: run could not be completed (${error?.name ?? "Error"})\n`,
      );
      process.exitCode = 1;
    },
  );
}
