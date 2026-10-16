import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryCredentialVault } from "../../../packages/credential-vault/src/index.js";
import { ApiError } from "../src/errors.js";
import { createSourceConnectionService } from "../src/source-connection-service.js";
import { SourceConnectionValidationError } from "../src/source-connection-validation.js";
import { SourceSyncError } from "../src/source-sync.js";

function createHarness({
  validateConnection,
  discoverTestRailSuites,
  discoverTestRailSections,
  discoverConfluencePages,
  syncSource,
  ticketContextCoordinator
} = {}) {
  const vaults = new Map();
  const service = createSourceConnectionService({
    tenantId: "solera",
    vaultFactory({ tenantId, productId }) {
      let vault = vaults.get(productId);
      if (!vault) {
        vault = new InMemoryCredentialVault({ tenantId, productId });
        vaults.set(productId, vault);
      }
      return vault;
    },
    validateConnection: validateConnection ?? (async () => ({
      validatedAt: "2026-09-12T10:00:00.000Z"
    })),
    discoverTestRailSuites: discoverTestRailSuites ?? (async () => []),
    discoverTestRailSections: discoverTestRailSections ?? (async () => []),
    discoverConfluencePages: discoverConfluencePages ?? (async () => ({
      baseUrl: "https://confluence.example/wiki",
      roots: []
    })),
    syncSource: syncSource ?? (async () => ({
      recordsCollected: 1,
      recordsCommitted: 1
    })),
    now: () => "2026-09-12T10:05:00.000Z"
  });
  if (ticketContextCoordinator) {
    service.registerTicketContextCoordinator(ticketContextCoordinator);
  }
  return { service, vaults };
}

const githubRequest = {
  productId: "fl-titling",
  source: "github",
  ownerSubject: "qa-lead",
  credential: "synthetic-token",
  config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] }
};

test("connects a source while returning metadata only", async () => {
  const { service, vaults } = createHarness();
  const connection = await service.connect(githubRequest);

  assert.equal(connection.status, "connected");
  assert.equal(connection.configured, true);
  assert.equal(connection.ownerSubject, "qa-lead");
  assert.equal("credential" in connection, false);
  const stored = await vaults.get("fl-titling")
    .resolveCredential("solera", "fl-titling", "github");
  assert.equal(stored, "synthetic-token");
});

test("persists a sanitized error state when validation rejects a credential", async () => {
  const { service } = createHarness({
    validateConnection: async () => {
      throw new SourceConnectionValidationError(
        "source_authorization_failed",
        "authorization",
        "The source rejected the supplied credential.",
        "authorization-expired"
      );
    }
  });

  await assert.rejects(
    () => service.connect(githubRequest),
    (error) =>
      error instanceof ApiError
      && error.status === 422
      && !error.message.includes("synthetic-token")
  );
  const connection = (await service.list({ productId: "fl-titling" }))
    .find((item) => item.source === "github");
  assert.equal(connection.status, "authorization-expired");
  assert.deepEqual(connection.error, {
    code: "source_authorization_failed",
    category: "authorization",
    message: "The source rejected the supplied credential."
  });
});

test("removes credential values from provider validation errors", async () => {
  const { service } = createHarness({
    validateConnection: async ({ credential }) => {
      throw new SourceConnectionValidationError(
        "source_authorization_failed",
        "authorization",
        `Provider rejected ${credential}.`,
        "authorization-expired"
      );
    }
  });

  await assert.rejects(
    () => service.connect(githubRequest),
    (error) =>
      error instanceof ApiError
      && !error.message.includes("synthetic-token")
  );
  const connection = (await service.list({ productId: "fl-titling" }))
    .find((item) => item.source === "github");
  assert.ok(!JSON.stringify(connection.error).includes("synthetic-token"));
  assert.ok(!JSON.stringify(connection.repositories).includes("synthetic-token"));
});

test("a failed credential rotation preserves the previously working credential", async () => {
  let rejectNext = false;
  const { service, vaults } = createHarness({
    validateConnection: async () => {
      if (rejectNext) {
        throw new SourceConnectionValidationError(
          "source_authorization_failed",
          "authorization",
          "The source rejected the supplied credential.",
          "authorization-expired"
        );
      }
      return { validatedAt: "2026-09-12T10:00:00.000Z" };
    }
  });
  await service.connect(githubRequest);
  rejectNext = true;

  await assert.rejects(() => service.connect({
    ...githubRequest,
    credential: "bad-token"
  }));

  const stored = await vaults.get("fl-titling")
    .resolveCredential("solera", "fl-titling", "github");
  assert.equal(stored, "synthetic-token");
});

test("sync resolves the stored credential internally and updates freshness", async () => {
  let resolvedCredential;
  const { service } = createHarness({
    syncSource: async ({ resolveCredential }) => {
      resolvedCredential = await resolveCredential();
    }
  });
  await service.connect(githubRequest);

  const connection = await service.sync({
    productId: "fl-titling",
    source: "github"
  });

  assert.equal(resolvedCredential, "synthetic-token");
  assert.equal(connection.status, "connected");
  assert.equal(connection.lastSuccessfulSyncAt, "2026-09-12T10:05:00.000Z");
});

test("keeps an active synchronization visible as syncing", async () => {
  let finishSync;
  const { service } = createHarness({
    syncSource: () => new Promise((resolve) => {
      finishSync = resolve;
    })
  });
  await service.connect(githubRequest);

  const syncPromise = service.sync({
    productId: "fl-titling",
    source: "github"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const active = (await service.list({ productId: "fl-titling" }))
    .find((item) => item.source === "github");
  assert.equal(active.status, "syncing");
  await assert.rejects(
    () => service.sync({ productId: "fl-titling", source: "github" }),
    (error) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "product_sync_in_progress"
  );

  finishSync({ recordsCollected: 1, recordsCommitted: 1 });
  await syncPromise;
});

test("keeps ticket context enrichment paused until full sync settles", async () => {
  let finishSync;
  const events = [];
  const { service } = createHarness({
    syncSource: () => new Promise((resolve) => {
      finishSync = resolve;
    }),
    ticketContextCoordinator: {
      async beginFullSync(productId) {
        events.push(`begin:${productId}`);
      },
      async endFullSync(productId) {
        events.push(`end:${productId}`);
      }
    }
  });
  await service.connect({
    productId: "fl-titling",
    source: "jira",
    ownerSubject: "qa-lead",
    credential: "jira-token",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    }
  });

  const syncPromise = service.sync({
    productId: "fl-titling",
    source: "jira"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["begin:fl-titling"]);
  finishSync({ recordsCollected: 1, recordsCommitted: 1 });
  await syncPromise;
  assert.deepEqual(events, ["begin:fl-titling", "end:fl-titling"]);
});

test("rejects a second source sync for the same product and names the active source safely", async () => {
  let started;
  let finish;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const finishPromise = new Promise((resolve) => {
    finish = resolve;
  });
  const { service } = createHarness({
    syncSource: async ({ source }) => {
      if (source === "github") {
        started();
        await finishPromise;
      }
    }
  });
  await service.connect(githubRequest);
  await service.connect({
    productId: "fl-titling",
    source: "jira",
    ownerSubject: "qa-lead",
    credential: "jira-token",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["QA"],
      allowedJql: "project = QA"
    }
  });

  const active = service.sync({ productId: "fl-titling", source: "github" });
  await startedPromise;
  await assert.rejects(
    () => service.sync({ productId: "fl-titling", source: "jira" }),
    (error) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "product_sync_in_progress"
      && error.message.includes("GitHub")
      && !error.message.includes("synthetic-token")
  );

  finish();
  await active;
});

test("allows different products to synchronize concurrently", async () => {
  let activeCount = 0;
  let maxActiveCount = 0;
  let startedCount = 0;
  let release;
  let bothStarted;
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });

  const bothStartedPromise = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const { service } = createHarness({
    syncSource: async () => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      startedCount += 1;
      if (startedCount === 2) bothStarted();
      await releasePromise;
      activeCount -= 1;
    }
  });
  await service.connect(githubRequest);
  await service.connect({ ...githubRequest, productId: "other-product" });

  const first = service.sync({ productId: "fl-titling", source: "github" });
  const second = service.sync({ productId: "other-product", source: "github" });
  await bothStartedPromise;
  assert.equal(maxActiveCount, 2);

  release();
  await Promise.all([first, second]);
});

test("coalesces targeted retrieval for the same Jira issue", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const syncSource = async () => {};
  syncSource.retrieveJiraIssue = async ({ issueKey, resolveCredential }) => {
    calls += 1;
    assert.equal(issueKey, "STT-1234");
    assert.equal(await resolveCredential(), "jira-token");
    await gate;
    return {
      issueKey,
      status: "complete",
      recordsCollected: 1
    };
  };
  const { service } = createHarness({ syncSource });
  await service.connect({
    productId: "fl-titling",
    source: "jira",
    ownerSubject: "qa-lead",
    credential: "jira-token",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    }
  });

  const first = service.hydrateJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234"
  });
  const second = service.hydrateJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
});

test("fans out bounded related-source enrichment and preserves Jira on partial failure", async () => {
  const calls = [];
  const syncSource = async () => {};
  syncSource.retrieveJiraIssue = async () => ({
    issueKey: "STT-1234",
    status: "complete",
    recordsCollected: 1
  });
  syncSource.retrieveTestRailCases = async ({ issueKey, resolveCredential }) => {
    calls.push(["testrail", issueKey, await resolveCredential()]);
    return { status: "complete", recordsCollected: 2 };
  };
  syncSource.retrieveGitHubPullRequests = async ({ issueKey, resolveCredential }) => {
    calls.push(["github", issueKey, await resolveCredential()]);
    throw new Error("provider details must not escape");
  };
  const { service } = createHarness({ syncSource });
  for (const request of [
    {
      productId: "fl-titling",
      source: "jira",
      ownerSubject: "qa-lead",
      credential: "jira-token",
      config: {
        baseUrl: "https://jira.example",
        allowedProjects: ["STT"],
        allowedJql: "project = STT"
      }
    },
    {
      productId: "fl-titling",
      source: "testrail",
      ownerSubject: "qa-lead",
      credential: "testrail-token",
      config: {
        baseUrl: "https://testrail.example",
        projectId: "128",
        suiteScope: "selected",
        suiteIds: ["12"]
      }
    },
    githubRequest
  ]) {
    await service.connect(request);
  }

  const jiraResult = await service.hydrateJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234"
  });
  const enrichment = await service.enrichJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234"
  });

  assert.deepEqual(calls.sort(), [
    ["github", "STT-1234", "synthetic-token"],
    ["testrail", "STT-1234", "testrail-token"]
  ]);
  assert.equal(jiraResult.status, "complete");
  assert.deepEqual(enrichment.testrail, {
    status: "complete",
    recordsCollected: 2
  });
  assert.equal(enrichment.github.status, "unavailable");
  assert.equal(enrichment.github.recordsCollected, 0);
  assert.deepEqual(enrichment.github.error, {
    code: "source_operation_failed",
    category: "internal",
    message: "The source connection operation failed."
  });
});

test("does not overlap a targeted retrieval with a full product sync", async () => {
  let retrievalStarted;
  let release;
  const started = new Promise((resolve) => {
    retrievalStarted = resolve;
  });

  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const syncSource = async () => {};
  syncSource.retrieveJiraIssue = async () => {
    retrievalStarted();
    await gate;
    return { status: "complete", recordsCollected: 1 };
  };
  const { service } = createHarness({ syncSource });
  await service.connect({
    productId: "fl-titling",
    source: "jira",
    ownerSubject: "qa-lead",
    credential: "jira-token",
    config: {
      baseUrl: "https://jira.example",
      allowedProjects: ["STT"],
      allowedJql: "project = STT"
    }
  });

  const hydration = service.hydrateJiraIssue({
    productId: "fl-titling",
    issueKey: "STT-1234"
  });
  await started;
  await assert.rejects(
    () => service.sync({ productId: "fl-titling", source: "jira" }),
    (error) =>
      error instanceof ApiError
      && error.code === "product_sync_in_progress"
  );
  release();
  await hydration;
});

test("hydrates one exact TestRail case with single-flight", async () => {
  const calls = [];
  const syncSource = async () => ({ recordsCollected: 0, recordsCommitted: 0 });
  syncSource.retrieveTestRailCase = async ({ caseId, resolveCredential }) => {
    calls.push([caseId, await resolveCredential()]);
    return { status: "complete", caseId, recordsCollected: 1 };
  };
  const { service } = createHarness({ syncSource });
  await service.connect({
    productId: "fl-titling",
    source: "testrail",
    ownerSubject: "qa-lead",
    credential: "testrail-token",
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.test",
      projectId: "128",
      suiteScope: "selected",
      suiteIds: ["12"]
    }
  });

  const [first, second] = await Promise.all([
    service.hydrateTestRailCase({ productId: "fl-titling", caseId: "C001201" }),
    service.hydrateTestRailCase({ productId: "fl-titling", caseId: "1201" })
  ]);

  assert.equal(first.caseId, "1201");
  assert.deepEqual(second, first);
  assert.deepEqual(calls, [["1201", "testrail-token"]]);
});

test("hydrates a bounded TestRail case neighborhood with single-flight", async () => {
  const calls = [];
  const syncSource = async () => ({ recordsCollected: 0, recordsCommitted: 0 });
  syncSource.retrieveTestRailCaseNeighborhood = async ({
    caseId,
    maxRecords,
    resolveCredential,
  }) => {
    calls.push([caseId, maxRecords, await resolveCredential()]);
    return { status: "complete", caseId, recordsCollected: 3 };
  };
  const { service } = createHarness({ syncSource });
  await service.connect({
    productId: "fl-titling",
    source: "testrail",
    ownerSubject: "qa-lead",
    credential: "testrail-token",
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.test",
      projectId: "128",
      suiteScope: "selected",
      suiteIds: ["12"],
    },
  });

  const [first, second] = await Promise.all([
    service.hydrateTestRailCaseNeighborhood({
      productId: "fl-titling",
      caseId: "C001201",
      maxRecords: 50,
    }),
    service.hydrateTestRailCaseNeighborhood({
      productId: "fl-titling",
      caseId: "1201",
      maxRecords: 50,
    }),
  ]);

  assert.equal(first.recordsCollected, 3);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, [["1201", 50, "testrail-token"]]);
});

test("cancels the active product sync out of band and preserves cancelled status", async () => {
  let observedSignal;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const { service } = createHarness({
    syncSource: ({ signal }) => {
      observedSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new SourceSyncError("sync_cancelled", "The synchronization was cancelled."));
        }, { once: true });
      });
    }
  });
  await service.connect(githubRequest);

  const syncPromise = service.sync({ productId: "fl-titling", source: "github" });
  await startedPromise;
  const cancellation = service.cancelSync({ productId: "fl-titling", source: "github" });

  await assert.rejects(
    syncPromise,
    (error) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "sync_cancelled"
  );
  const connection = await cancellation;
  assert.equal(observedSignal.aborted, true);
  assert.equal(connection.status, "error");
  assert.deepEqual(connection.error, {
    code: "sync_cancelled",
    category: "internal",
    message: "The synchronization was cancelled."
  });
});

test("a late cancellation cannot be overwritten by a connector that resolves successfully", async () => {
  let connectedUpdateStarted;
  let releaseConnectedUpdate;
  const connectedUpdateStartedPromise = new Promise((resolve) => {
    connectedUpdateStarted = resolve;
  });
  const connectedUpdateGate = new Promise((resolve) => {
    releaseConnectedUpdate = resolve;
  });
  const { service, vaults } = createHarness({ syncSource: async () => undefined });
  await service.connect(githubRequest);
  const vault = vaults.get("fl-titling");
  const updateStatus = vault.updateStatus.bind(vault);
  vault.updateStatus = async (request) => {
    if (
      request.status === "connected"
      && vault.get("solera", "fl-titling", "github")?.status === "syncing"
    ) {
      connectedUpdateStarted();
      await connectedUpdateGate;
    }
    return updateStatus(request);
  };

  const syncPromise = service.sync({ productId: "fl-titling", source: "github" });
  await connectedUpdateStartedPromise;
  const cancellation = service.cancelSync({ productId: "fl-titling", source: "github" });
  releaseConnectedUpdate();

  await assert.rejects(
    syncPromise,
    (error) => error instanceof ApiError && error.code === "sync_cancelled"
  );
  const connection = await cancellation;
  assert.equal(connection.status, "error");
  assert.equal(connection.error.code, "sync_cancelled");
  assert.equal(connection.lastSuccessfulSyncAt, null);
});

test("rejects cancellation when no sync is active or another source is active", async () => {
  let started;
  let finish;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const finishPromise = new Promise((resolve) => {
    finish = resolve;
  });
  const { service } = createHarness({
    syncSource: async () => {
      started();
      await finishPromise;
    }
  });
  await service.connect(githubRequest);

  await assert.rejects(
    () => service.cancelSync({ productId: "fl-titling", source: "github" }),
    (error) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "sync_not_in_progress"
  );

  const active = service.sync({ productId: "fl-titling", source: "github" });
  await startedPromise;
  await assert.rejects(
    () => service.cancelSync({ productId: "fl-titling", source: "jira" }),
    (error) =>
      error instanceof ApiError
      && error.status === 409
      && error.code === "sync_source_mismatch"
      && error.message.includes("GitHub")
  );
  finish();
  await active;
});

test("recovers an orphaned syncing state as an interrupted synchronization", async () => {
  const vault = new InMemoryCredentialVault({
    tenantId: "solera",
    productId: "fl-titling"
  });
  const createService = () => createSourceConnectionService({
    tenantId: "solera",
    vaultFactory: () => vault,
    validateConnection: async () => ({
      validatedAt: "2026-09-12T10:00:00.000Z"
    }),
    syncSource: async () => ({
      recordsCollected: 1,
      recordsCommitted: 1
    }),
    now: () => "2026-09-12T10:05:00.000Z"
  });
  const firstProcess = createService();
  await firstProcess.connect(githubRequest);
  await vault.updateStatus({
    tenantId: "solera",
    productId: "fl-titling",
    source: "github",
    status: "syncing",
    lastSyncAt: "2026-09-12T10:04:00.000Z"
  });

  const restartedProcess = createService();
  const recovered = (await restartedProcess.list({ productId: "fl-titling" }))
    .find((item) => item.source === "github");

  assert.equal(recovered.status, "error");
  assert.deepEqual(recovered.error, {
    code: "sync_interrupted",
    category: "internal",
    message: "The previous synchronization was interrupted. Retry the synchronization."
  });
});

test("disconnect destroys credential material and returns not-connected metadata", async () => {
  const { service, vaults } = createHarness();
  await service.connect(githubRequest);

  const connection = await service.disconnect({
    productId: "fl-titling",
    source: "github"
  });

  assert.equal(connection.status, "not-connected");
  assert.equal(connection.configured, false);
  assert.equal(
    await vaults.get("fl-titling").resolveCredential("solera", "fl-titling", "github"),
    undefined
  );
});

test("supports synchronization for Confluence and ReportPortal", async () => {
  const synchronizedSources = [];
  const { service } = createHarness({
    syncSource: async ({ source }) => {
      synchronizedSources.push(source);
      return { recordsCollected: 1, recordsCommitted: 1 };
    }
  });
  await service.connect({
    productId: "fl-titling",
    source: "confluence",
    ownerSubject: "qa-lead",
    credential: "synthetic-token",
    config: {
      baseUrl: "https://confluence.example/wiki",
      username: "qa@example.com",
      spaceKeys: ["QA"]
    }
  });
  await service.connect({
    productId: "fl-titling",
    source: "reportportal",
    ownerSubject: "qa-lead",
    credential: "synthetic-token",
    config: {
      baseUrl: "https://reportportal.example",
      project: "fl_titling"
    }
  });

  await service.sync({ productId: "fl-titling", source: "confluence" });
  await service.sync({ productId: "fl-titling", source: "reportportal" });
  assert.deepEqual(synchronizedSources, ["confluence", "reportportal"]);
});

test("discovers TestRail suites without persisting the supplied credential", async () => {
  let received;
  const { service, vaults } = createHarness({
    discoverTestRailSuites: async (request) => {
      received = request;
      return [{ id: "4", name: "Regression", isCompleted: false }];
    }
  });

  const suites = await service.discoverTestRailSuites({
    productId: "fl-titling",
    credential: "temporary-api-key",
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.com",
      projectId: "128",
      suiteScope: "all"
    }
  });

  assert.equal(received.credential, "temporary-api-key");
  assert.deepEqual(suites, [{ id: "4", name: "Regression", isCompleted: false }]);
  assert.equal(vaults.has("fl-titling"), false);
});

test("discovers TestRail sections with the stored connection credential", async () => {
  let received;
  const { service } = createHarness({
    discoverTestRailSections: async (request) => {
      received = request;
      return [{ id: "44", suiteId: "128951", parentId: null, depth: 0, name: "Regression" }];
    }
  });
  await service.connect({
    productId: "fl-titling",
    source: "testrail",
    ownerSubject: "qa-lead",
    credential: "stored-api-key",
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.com",
      projectId: "128",
      suiteScope: "selected",
      suiteIds: ["128951"]
    }
  });

  const sections = await service.discoverTestRailSections({
    productId: "fl-titling",
    suiteId: "128951"
  });

  assert.equal(received.credential, "stored-api-key");
  assert.equal(received.suiteId, "128951");
  assert.deepEqual(sections, [{
    id: "44",
    suiteId: "128951",
    parentId: null,
    depth: 0,
    name: "Regression"
  }]);
});

test("discovers Confluence root pages without persisting the supplied credential", async () => {
  let received;
  const { service, vaults } = createHarness({
    discoverConfluencePages: async (request) => {
      received = request;
      return {
        baseUrl: "https://confluence.example/wiki",
        roots: [{ id: "42", title: "Product", spaceKey: "QA", url: "https://confluence.example/wiki/display/QA/Product" }]
      };
    }
  });

  const discovery = await service.discoverConfluencePages({
    productId: "fl-titling",
    credential: "temporary-api-key",
    config: {
      username: "qa@example.com",
      rootPageUrls: ["https://confluence.example/wiki/display/QA/Product"]
    }
  });

  assert.equal(received.credential, "temporary-api-key");
  assert.equal(discovery.roots[0].id, "42");
  assert.equal(vaults.has("fl-titling"), false);
});

test("migrates legacy GitHub repository strings to stable typed targets", async () => {
    const { service, vaults } = createHarness();
    const vault = new InMemoryCredentialVault({
      tenantId: "solera",
      productId: "legacy-product"
    });
    vaults.set("legacy-product", vault);
    await vault.upsertConnection({
      tenantId: "solera",
      productId: "legacy-product",
      source: "github",
      ownerSubject: "qa-lead",
      credential: "synthetic-token",
      config: { repositories: "owner/legacy-repository" },
      status: "connected"
    });

    const first = (await service.list({ productId: "legacy-product" }))
      .find((connection) => connection.source === "github");
    const second = (await service.list({ productId: "legacy-product" }))
      .find((connection) => connection.source === "github");

    assert.equal(first.repositories.length, 1);
    assert.equal(first.repositories[0].repository, "owner/legacy-repository");
    assert.equal(first.repositories[0].url, "https://github.com/owner/legacy-repository");
    assert.equal(first.repositories[0].id, second.repositories[0].id);
    assert.equal("credential" in first.repositories[0], false);
    assert.deepEqual(
      vault.get("solera", "legacy-product", "github").config.repositories,
      ["owner/legacy-repository"]
    );
    assert.equal(
      await vault.resolveCredential("solera", "legacy-product", "github"),
      "synthetic-token"
    );
});

test("keeps inaccessible GitHub repositories as per-target validation failures", async () => {
    const { service, vaults } = createHarness({
      validateConnection: async ({ config }) => {
        if (config.repositories[0] === "owner/inaccessible") {
          throw new SourceConnectionValidationError(
            "github_repository_not_accessible",
            "authorization",
            "GitHub could not access this repository."
          );
        }
        return { validatedAt: "2026-09-12T10:00:00.000Z" };
      }
    });

    const connection = await service.connect({
      ...githubRequest,
      config: { repositories: ["owner/accessible", "owner/inaccessible"] }
    });

    assert.equal(connection.status, "connected");
    assert.equal(connection.repositories[0].validationStatus, "valid");
    assert.equal(connection.repositories[1].validationStatus, "failed");
    assert.equal(
      connection.repositories[1].error.code,
      "github_repository_not_accessible"
    );
    assert.equal(
      await vaults.get("fl-titling").resolveCredential("solera", "fl-titling", "github"),
      "synthetic-token"
    );
});

test("syncs GitHub targets independently with one shared credential and partial outcomes", async () => {
    const calls = [];
    const { service } = createHarness({
      syncSource: async ({ config, resolveCredential, repositoryId }) => {
        calls.push({
          repository: config.repositories[0],
          repositoryId,
          credential: await resolveCredential()
        });
        if (config.repositories[0] === "owner/failing") {
          throw new SourceSyncError("source_sync_failed", "provider detail synthetic-token");
        }
        return { recordsCollected: 7, recordsCommitted: 7 };
      }
    });
    await service.connect({
      ...githubRequest,
      config: { repositories: ["owner/success", "owner/failing"] }
    });

    const connection = await service.sync({
      productId: "fl-titling",
      source: "github"
    });

    assert.equal(connection.status, "connected");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.credential === "synthetic-token"));
    assert.ok(calls.every((call) => call.repositoryId.startsWith("repo-")));
    assert.equal(connection.repositories[0].syncStatus, "succeeded");
    assert.equal(connection.repositories[0].recordsCollected, 7);
    assert.equal(connection.repositories[1].syncStatus, "failed");
    assert.equal(connection.repositories[1].error.code, "source_sync_failed");
    assert.ok(!JSON.stringify(connection.repositories[1].error).includes("synthetic-token"));
});

test("cancels one repository sync without changing another target", async () => {
    let observedSignal;
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const { service } = createHarness({
      syncSource: async ({ signal }) => {
        observedSignal = signal;
        started();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new SourceSyncError("sync_cancelled", "The synchronization was cancelled.");
      }
    });
    const connection = await service.connect({
      ...githubRequest,
      config: { repositories: ["owner/one", "owner/two"] }
    });
    const first = connection.repositories[0];
    const second = connection.repositories[1];

    const sync = service.syncGitHubRepository({
      productId: "fl-titling",
      repositoryId: first.id
    });
    await startedPromise;
    const cancelled = await service.cancelGitHubRepositorySync({
      productId: "fl-titling",
      repositoryId: first.id
    });

    await assert.rejects(sync, (error) => error.code === "sync_cancelled");
    assert.equal(observedSignal.aborted, true);
    assert.equal(cancelled.syncStatus, "cancelled");
    const untouched = await service.getGitHubRepository({
      productId: "fl-titling",
      repositoryId: second.id
    });
    assert.equal(untouched.syncStatus, "idle");
    assert.equal(untouched.lastSyncAt, null);
});

test("creates, updates, deduplicates, and deletes repository targets", async () => {
    const clearedCheckpoints = [];
    const syncSource = async () => ({ recordsCollected: 0, recordsCommitted: 0 });
    syncSource.clearGitHubRepositoryCheckpoint = async (request) => {
      clearedCheckpoints.push(request);
    };
    const { service } = createHarness({ syncSource });
    await service.connect(githubRequest);

    const created = await service.createGitHubRepository({
      productId: "fl-titling",
      repository: {
        id: "automation",
        repository: "owner/automation",
        purpose: "test-automation",
        lifecycle: "active",
        enabled: true
      }
    });

    test("keeps repository metadata unchanged when checkpoint clearing fails", async () => {
        const syncSource = async () => ({ recordsCollected: 0, recordsCommitted: 0 });
        syncSource.clearGitHubRepositoryCheckpoint = async () => {
          throw new Error("synthetic checkpoint failure");
        };
        const { service } = createHarness({ syncSource });
        await service.connect(githubRequest);
        const created = await service.createGitHubRepository({
          productId: "fl-titling",
          repository: {
            id: "stable-target",
            repository: "owner/original"
          }
        });

        await assert.rejects(
          () => service.updateGitHubRepository({
            productId: "fl-titling",
            repositoryId: created.id,
            changes: { repository: "owner/replacement" }
          }),
          /synthetic checkpoint failure/
        );
        assert.equal(
          (await service.getGitHubRepository({
            productId: "fl-titling",
            repositoryId: created.id
          })).repository,
          "owner/original"
        );

        await assert.rejects(
          () => service.deleteGitHubRepository({
            productId: "fl-titling",
            repositoryId: created.id
          }),
          /synthetic checkpoint failure/
        );
        assert.equal(
          (await service.getGitHubRepository({
            productId: "fl-titling",
            repositoryId: created.id
          })).repository,
          "owner/original"
        );
    });
    assert.equal(created.url, "https://github.com/owner/automation");

    await assert.rejects(
      () => service.createGitHubRepository({
        productId: "fl-titling",
        repository: { repository: "OWNER/AUTOMATION.git" }
      }),
      (error) => error instanceof ApiError && error.code === "repository_already_exists"
    );

    const disabled = await service.updateGitHubRepository({
      productId: "fl-titling",
      repositoryId: "automation",
      changes: { enabled: false, lifecycle: "maintenance" }
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.lifecycle, "maintenance");

    const renamed = await service.updateGitHubRepository({
      productId: "fl-titling",
      repositoryId: "automation",
      changes: { repository: "owner/automation-next" }
    });
    assert.equal(renamed.repository, "owner/automation-next");
    assert.deepEqual(clearedCheckpoints, [{
      productId: "fl-titling",
      repositoryId: "automation"
    }]);

    const deleted = await service.deleteGitHubRepository({
      productId: "fl-titling",
      repositoryId: "automation"
    });
    assert.equal(deleted.id, "automation");
    assert.equal(clearedCheckpoints.length, 2);
    await assert.rejects(
      () => service.getGitHubRepository({
        productId: "fl-titling",
        repositoryId: "automation"
      }),
      (error) => error instanceof ApiError && error.code === "repository_not_found"
    );
});
