#!/usr/bin/env node
/**
 * P4 operator maintenance CLI: runs one bounded, production-safe maintenance
 * action for a single tenant/product scope, then exits. It composes no
 * connectors, contacts no source, and triggers no TestRail/ReportPortal sync
 * -- it only reads and (when explicitly confirmed) repairs durable state.
 *
 * Subcommands:
 *   status        Print the raw-evidence compaction/maintenance posture.
 *   compact       Bounded, crash-safe raw-evidence compaction (default safe).
 *   reconcile     Non-mutating cross-tier reconciliation findings.
 *   repair        Explicitly confirmed, bounded reconciliation repair.
 *   rebuild-gold  Rebuild Gold serving projections from canonical knowledge.
 *
 * Credentials and encryption keys are always *references* resolved at runtime
 * through `@tkl/ops`'s environment-backed secret resolver. Output is a single
 * sanitized JSON document on stdout; audit events go to stderr. Exit codes:
 * 0 = completed/planned/skipped, 1 = the invocation was rejected or a
 * reconciliation surfaced an error-severity finding.
 *
 * Node <22.18.0 must run this with `--experimental-strip-types`
 * (`npm run maintenance -- ...` does) because the raw-evidence and
 * knowledge stores publish TypeScript sources.
 */
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAuditSink, createEnvCredentialResolver } from "../../ops/src/index.js";
import { createPersistentRawEvidenceStore } from "@tkl/raw-evidence-store";
import {
  applyReconciliationRepairs,
  reconcileEvidence,
  rebuildGoldProjections,
  sanitizeOperationsData,
} from "../src/index.js";
import {
  MaintenanceConfirmationRequiredError,
  RetentionPolicyError,
  SyncConfigurationError,
} from "../src/errors.js";
import { SanitizationError } from "../src/sanitize.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const USAGE = `Usage: node [--experimental-strip-types] packages/sync-coordinator/bin/run-maintenance.js <command> [options]

Commands:
  status         Print the raw-evidence compaction/maintenance posture and exit.
  compact        Fold transaction chunks into a compacted encrypted base (non-destructive).
  reconcile      Print non-mutating cross-tier reconciliation findings and exit.
  repair         Apply a confirmed, bounded reconciliation repair (dead-letter requeue).
  rebuild-gold   Rebuild Gold serving projections from canonical knowledge.

Common options:
  --product <id>            Product configuration to load (default: fl-titling)
  --config <path>           Explicit product configuration file (overrides --product)
  --data-directory <path>   Raw evidence data directory (or TKL_RAW_EVIDENCE_DIR)
  --key-ref <reference>     Raw evidence encryption key reference (or TKL_RAW_EVIDENCE_KEY_REF)
  --knowledge-directory <p> Knowledge store data directory (enables Silver/Gold reconcile & rebuild-gold)

compact options:
  --dry-run                 Plan only: write nothing and delete nothing
  --min-chunk-files <n>     Skip unless at least this many chunk files exist (default 2)
  --max-chunk-files <n>     Refuse to compact more than this many chunk files (default 1000)

reconcile options:
  --connector <id>          Restrict to this connector
  --source <id>             Restrict to this source
  --source-version <v>      Restrict to this source version
  --observed-from <iso>     Restrict to records observed at/after this timestamp
  --observed-to <iso>       Restrict to records observed at/before this timestamp

repair options:
  --requeue-dead-letter     Requeue dead-letter projection records
  --confirm                 Required opt-in for any mutating repair
  --limit <n>               Max records to repair this run (default 100)

rebuild-gold options:
  --dry-run                 Plan only
  --batch-size <n>          Records per rebuild batch (default 100)
  --cursor <n>              Resume cursor (default 0)
  --max-batches <n>         Upper bound on batches this run (default 100)

The single JSON result is printed to stdout; audit events go to stderr.
`;

const KNOWN_SAFE_ERRORS = new Set([
  SyncConfigurationError,
  RetentionPolicyError,
  MaintenanceConfirmationRequiredError,
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

function positiveIntegerOption(raw, name) {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new SyncConfigurationError(`--${name} must be a positive integer`);
  }
  return Number(raw);
}

function nonNegativeIntegerOption(raw, name) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new SyncConfigurationError(`--${name} must be a non-negative integer`);
  }
  return Number(raw);
}

function createCliAuditSink(destination) {
  if (destination === "none") return createAuditSink({ destination: "none" });
  return {
    info(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  };
}

async function buildRawStore(configuration, values, env) {
  const dataDirectory = values["data-directory"] ?? env.TKL_RAW_EVIDENCE_DIR;
  const keyRef = values["key-ref"] ?? env.TKL_RAW_EVIDENCE_KEY_REF;
  if (!dataDirectory || !keyRef) {
    throw new SyncConfigurationError(
      "A raw evidence data directory (--data-directory / TKL_RAW_EVIDENCE_DIR) and encryption key " +
        "reference (--key-ref / TKL_RAW_EVIDENCE_KEY_REF) are required",
    );
  }
  const secrets = createEnvCredentialResolver({ env });
  return createPersistentRawEvidenceStore({
    tenantId: configuration.tenantId,
    productId: configuration.productId,
    dataDirectory: resolvePath(process.cwd(), dataDirectory),
    keyRef,
    resolveKey: (reference) => secrets.resolve(reference),
  });
}

/**
 * Gathers read-only Silver/Gold count context from the knowledge store when a
 * `--knowledge-directory` is supplied. Imported lazily so the common
 * raw-only commands never load the knowledge store package.
 */
async function gatherKnowledgeCounts(configuration, knowledgeDirectory) {
  const { SqliteKnowledgeStore } = await import("@tkl/knowledge-store");
  const store = new SqliteKnowledgeStore({
    dataDirectory: resolvePath(process.cwd(), knowledgeDirectory),
    tenantId: configuration.tenantId,
    productId: configuration.productId,
  });
  try {
    return {
      store,
      counts: {
        canonicalEntityCount: store.listEntities(configuration.productId).length,
        canonicalClaimCount: store.listClaims().length,
        servingProjectionBacklog: store.pendingServingProjectionCount(),
      },
    };
  } catch (error) {
    store.close?.();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      product: { type: "string" },
      config: { type: "string" },
      "data-directory": { type: "string" },
      "key-ref": { type: "string" },
      "knowledge-directory": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "min-chunk-files": { type: "string" },
      "max-chunk-files": { type: "string" },
      connector: { type: "string" },
      source: { type: "string" },
      "source-version": { type: "string" },
      "observed-from": { type: "string" },
      "observed-to": { type: "string" },
      "requeue-dead-letter": { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      limit: { type: "string" },
      "batch-size": { type: "string" },
      cursor: { type: "string" },
      "max-batches": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  const command = positionals[0];
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const productId = values.product ?? "fl-titling";
  const configurationPath = values.config
    ? resolvePath(process.cwd(), values.config)
    : resolvePath(repositoryRoot, "config", "products", `${productId}.json`);
  const configuration = await readJsonFile(configurationPath);
  const auditSink = createCliAuditSink(env.TKL_AUDIT_DESTINATION);

  const emit = (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  };

  if (command === "status") {
    const store = await buildRawStore(configuration, values, env);
    const status = sanitizeOperationsData(
      { reportType: "evidence.maintenance.status", ...store.maintenanceStatus() },
      "maintenanceStatus",
    );
    auditSink.info({ eventType: "maintenance.status", ...status });
    emit(status);
    return 0;
  }

  if (command === "compact") {
    const store = await buildRawStore(configuration, values, env);
    const result = sanitizeOperationsData(
      {
        reportType: "evidence.compaction",
        ...(await store.compact({
          dryRun: values["dry-run"] === true,
          ...(positiveIntegerOption(values["min-chunk-files"], "min-chunk-files") === undefined
            ? {}
            : { minChunkFiles: positiveIntegerOption(values["min-chunk-files"], "min-chunk-files") }),
          ...(positiveIntegerOption(values["max-chunk-files"], "max-chunk-files") === undefined
            ? {}
            : { maxChunkFiles: positiveIntegerOption(values["max-chunk-files"], "max-chunk-files") }),
        })),
      },
      "compactionResult",
    );
    auditSink.info({ eventType: "maintenance.compacted", ...result });
    emit(result);
    return result.status === "aborted" ? 1 : 0;
  }

  if (command === "reconcile") {
    const store = await buildRawStore(configuration, values, env);
    let knowledge;
    let knowledgeStore;
    if (values["knowledge-directory"]) {
      const gathered = await gatherKnowledgeCounts(configuration, values["knowledge-directory"]);
      knowledge = gathered.counts;
      knowledgeStore = gathered.store;
    }
    try {
      const report = sanitizeOperationsData(
        reconcileEvidence({
          rawStore: store,
          knowledge,
          filters: reconcileFilters(values),
        }),
        "reconciliationReport",
      );
      auditSink.info({ eventType: "maintenance.reconciled", ...report });
      emit(report);
      return report.highestSeverity === "error" ? 1 : 0;
    } finally {
      knowledgeStore?.close?.();
    }
  }

  if (command === "repair") {
    const store = await buildRawStore(configuration, values, env);
    const result = sanitizeOperationsData(
      await applyReconciliationRepairs({
        rawStore: store,
        actions: { requeueDeadLetter: values["requeue-dead-letter"] === true },
        confirm: values.confirm === true,
        ...(positiveIntegerOption(values.limit, "limit") === undefined
          ? {}
          : { limit: positiveIntegerOption(values.limit, "limit") }),
      }),
      "reconciliationRepair",
    );
    auditSink.info({ eventType: "maintenance.repaired", ...result });
    emit(result);
    return 0;
  }

  if (command === "rebuild-gold") {
    if (!values["knowledge-directory"]) {
      throw new SyncConfigurationError("rebuild-gold requires --knowledge-directory");
    }
    const gathered = await gatherKnowledgeCounts(configuration, values["knowledge-directory"]);
    try {
      const result = sanitizeOperationsData(
        await rebuildGoldProjections({
          knowledgeStore: gathered.store,
          dryRun: values["dry-run"] === true,
          ...(positiveIntegerOption(values["batch-size"], "batch-size") === undefined
            ? {}
            : { batchSize: positiveIntegerOption(values["batch-size"], "batch-size") }),
          ...(nonNegativeIntegerOption(values.cursor, "cursor") === undefined
            ? {}
            : { cursor: nonNegativeIntegerOption(values.cursor, "cursor") }),
          ...(positiveIntegerOption(values["max-batches"], "max-batches") === undefined
            ? {}
            : { maxBatches: positiveIntegerOption(values["max-batches"], "max-batches") }),
        }),
        "goldRebuild",
      );
      auditSink.info({ eventType: "maintenance.gold-rebuilt", ...result });
      emit(result);
      return 0;
    } finally {
      gathered.store.close?.();
    }
  }

  throw new SyncConfigurationError(`Unknown maintenance command "${command}"`);
}

function reconcileFilters(values) {
  const filters = {};
  if (values.connector) filters.connectorId = values.connector;
  if (values.source) filters.source = values.source;
  if (values["source-version"]) filters.sourceVersion = values["source-version"];
  if (values["observed-from"]) filters.observedFrom = values["observed-from"];
  if (values["observed-to"]) filters.observedTo = values["observed-to"];
  return filters;
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
          ? `maintenance: ${error.message}\n`
          : `maintenance: command could not be completed (${error?.name ?? "Error"})\n`,
      );
      process.exitCode = 1;
    },
  );
}
