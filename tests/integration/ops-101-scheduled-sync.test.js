import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPersistentRawEvidenceStore } from "../../packages/raw-evidence-store/src/index.js";
import { createSyncCoordinator } from "../../packages/sync-coordinator/src/index.js";
import { createAuditLogger, createHealthRegistry } from "../../packages/observability/src/index.js";

/**
 * OPS-101 integration path: the scheduled-sync coordinator driving the
 * **real** GitHub connector, composed by the **real** config-driven
 * ingestion composition root (ING-104) from the **real** product
 * configuration, committing into the **real** durable, encrypted
 * raw-evidence store (ING-105), and recovering across a simulated process
 * restart.
 *
 * Only the outermost edge is a double: the connector's HTTP client is
 * injected as a fixture, so no network, no credentials, and no timers are
 * involved. Everything between the coordinator and the durable file is
 * production code.
 */

const REPOSITORY = "Solera-Engineering/qa-tkl-mcp-f5";
const CONNECTOR_ID = "connector.github";
const KEY_REF = "env://TKL_TEST_RAW_EVIDENCE_KEY";
// Deterministic, test-only AES-256 key material; never protects real evidence.
const TEST_KEY = Buffer.alloc(32, 13).toString("base64");

const configuration = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../config/products/fl-titling.json", import.meta.url)), "utf8"),
);

const scratchRoot = fileURLToPath(new URL("../.tmp/", import.meta.url));
mkdirSync(scratchRoot, { recursive: true });
const dataDirectory = mkdtempSync(join(scratchRoot, "ops-101-integration-"));

test.after(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

const PULL_REQUEST_PAGES = [
  { items: [{ number: 4321, updated_at: "2026-03-01T10:00:00.000Z", title: "first" }], nextPage: 1 },
  { items: [{ number: 4322, updated_at: "2026-03-02T10:00:00.000Z", title: "second" }] },
];

/** A fixture GitHub client. `failOnPage` fails with a non-transient status, so no retry timer runs. */
function createFixtureGitHubClient({ failOnPage = null } = {}) {
  const requestedPages = [];
  return {
    requestedPages,
    async fetchPullRequests(repository, page) {
      assert.equal(repository, REPOSITORY, "the connector only ever reads the allowlisted repository");
      requestedPages.push(page);
      if (page === failOnPage) {
        const error = new Error(`GitHub request failed for https://api.github.com/repos/${repository}/pulls`);
        error.name = "GitHubHttpError";
        error.status = 404;
        throw error;
      }
      return PULL_REQUEST_PAGES[page];
    },
    async fetchChangedFiles() {
      return [];
    },
  };
}

function createCoordinator({ store, client, auditEvents = [] }) {
  return {
    auditEvents,
    coordinator: createSyncCoordinator({
      configuration,
      store,
      // Config-driven composition: the coordinator asks @tkl/ingestion to
      // build whatever `enabledPlugins` lists. Only the HTTP client is
      // injected; the connector itself is the production one.
      dependencies: { [CONNECTOR_ID]: { client } },
      sync: { batchSize: 5 },
      auditLogger: createAuditLogger({
        sink: {
          info(event) {
            auditEvents.push(event);
          },
        },
      }),
      healthRegistry: createHealthRegistry({ correlationId: "ops-101-integration" }),
    }),
  };
}

async function openStore() {
  return createPersistentRawEvidenceStore({
    tenantId: configuration.tenantId,
    productId: configuration.productId,
    dataDirectory,
    keyRef: KEY_REF,
    resolveKey: () => TEST_KEY,
  });
}

test("OPS-101: a failed scheduled sync is recovered by the next run after a restart, idempotently", async () => {
  const failingClient = createFixtureGitHubClient({ failOnPage: 1 });
  const firstStore = await openStore();
  const first = createCoordinator({ store: firstStore, client: failingClient });

  const firstSummary = await first.coordinator.runOnce();

  assert.equal(firstSummary.status, "failed");
  assert.equal(firstSummary.connectors[0].connectorId, CONNECTOR_ID);
  assert.equal(firstSummary.connectors[0].error.name, "GitHubHttpError");
  assert.equal(firstSummary.connectors[0].error.status, 404);
  assert.equal(firstSummary.totals.committedCount, 1, "evidence already fetched is still durable");
  assert.equal(
    firstSummary.connectors[0].checkpointAdvanced,
    false,
    "a failed run never advances the cursor past the failure",
  );
  assert.equal(firstStore.getCheckpoint(CONNECTOR_ID), undefined);

  // Simulated restart: every in-process object is discarded and rebuilt
  // from the encrypted snapshot on disk.
  const recoveredStore = await openStore();
  assert.equal(recoveredStore.listRecords().length, 1, "durable evidence survived the restart");

  const healthyClient = createFixtureGitHubClient();
  const second = createCoordinator({ store: recoveredStore, client: healthyClient });
  const secondSummary = await second.coordinator.runOnce();

  assert.equal(secondSummary.status, "succeeded");
  assert.deepEqual(healthyClient.requestedPages, [0, 1], "GitHub's safe page-zero replay is preserved");
  assert.equal(secondSummary.totals.recordCount, 2);
  assert.equal(secondSummary.totals.duplicateCount, 1, "the replayed pull request is deduplicated");
  assert.equal(secondSummary.totals.committedCount, 1);
  assert.equal(recoveredStore.listRecords().length, 2);
  // The committed cursor is the real connector's own checkpoint shape
  // (ING-102), recorded verbatim by the coordinator rather than invented here.
  const recoveredCheckpoint = recoveredStore.getCheckpoint(CONNECTOR_ID);
  assert.equal(recoveredCheckpoint.phase, "changed_files");
  assert.equal(recoveredCheckpoint.page, 1);
  assert.equal(recoveredCheckpoint.pullRequest, "4322");
  assert.ok(recoveredCheckpoint.observedAt);

  // A third run with nothing new commits nothing and stays healthy.
  const thirdStore = await openStore();
  const third = createCoordinator({ store: thirdStore, client: createFixtureGitHubClient() });
  const thirdSummary = await third.coordinator.runOnce();
  assert.equal(thirdSummary.status, "succeeded");
  assert.equal(thirdSummary.totals.committedCount, 0);
  assert.equal(thirdSummary.totals.duplicateCount, 2);
  assert.equal(thirdStore.listRecords().length, 2);

  const serialized = JSON.stringify({
    firstSummary,
    secondSummary,
    thirdSummary,
    audit: [...first.auditEvents, ...second.auditEvents],
  });
  assert.equal(serialized.includes("secret://"), false, "credential references never reach a summary");
  assert.equal(serialized.includes("api.github.com"), false, "raw connector errors never reach a summary");
  assert.equal(serialized.includes(dataDirectory), false, "filesystem paths never reach a summary");
});

test("OPS-101: a confirmed replay re-reads the source without duplicating durable evidence or rewinding", async () => {
  const store = await openStore();
  const client = createFixtureGitHubClient();
  const { coordinator } = createCoordinator({ store, client });
  const checkpointBefore = store.getCheckpoint(CONNECTOR_ID);

  const plan = coordinator.plan({ mode: "replay-full" });
  assert.equal(plan.status, "planned");
  assert.deepEqual(client.requestedPages, [], "planning contacts no source");

  const summary = await coordinator.runOnce({
    mode: "replay-full",
    confirmReplay: true,
    maxRecordsPerConnector: 100,
  });

  assert.equal(summary.status, "succeeded");
  assert.equal(summary.totals.duplicateCount, 2);
  assert.equal(summary.totals.committedCount, 0);
  assert.equal(store.listRecords().length, 2);
  assert.deepEqual(store.getCheckpoint(CONNECTOR_ID), checkpointBefore, "a replay never rewinds the cursor");
});
