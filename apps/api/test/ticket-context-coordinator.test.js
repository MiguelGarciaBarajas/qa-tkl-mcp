import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTicketContextJobStore } from "../src/ticket-context-job-store.js";
import { createTicketContextCoordinator } from "../src/ticket-context-coordinator.js";

function coordinatorHarness({
  enrich = async () => ({
    testrail: { status: "complete", recordsCollected: 2 },
    github: { status: "complete", recordsCollected: 3 }
  }),
  maxAttempts = 3,
  retryBaseMs = 1
} = {}) {
  let calls = 0;
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue(request) {
        calls += 1;
        return enrich(request, calls);
      }
    },
    maxAttempts,
    retryBaseMs,
    retryMaxMs: retryBaseMs,
    concurrency: 2
  });
  return { coordinator, store, calls: () => calls };
}

function seedJira(coordinator, issueKey) {
  return coordinator.recordJiraOutcome({
    productId: "fl-titling",
    issueKey,
    state: "local",
    recordsCollected: 1
  });
}

test("coalesces one active enrichment per product and issue", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { coordinator, calls } = coordinatorHarness({
    enrich: async () => {
      await gate;
      return {
        testrail: { status: "complete", recordsCollected: 1 },
        github: { status: "complete", recordsCollected: 1 }
      };
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-3731");
  await Promise.all([
    coordinator.enqueue({ productId: "fl-titling", issueKey: "stt-3731" }),
    coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-3731" }),
    coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-3731", force: true })
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(), 1);
  release();
  await coordinator.drain();
  assert.equal((await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-3731"
  })).state, "complete");
});

test("reports partial completeness and budget exhaustion honestly", async () => {
  const { coordinator } = coordinatorHarness({
    enrich: async () => ({
      testrail: { status: "partial", recordsCollected: 100, truncated: true },
      github: { status: "complete", recordsCollected: 4 }
    })
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-10");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-10" });
  await coordinator.drain();
  const job = await coordinator.get({ productId: "fl-titling", issueKey: "STT-10" });
  assert.equal(job.state, "partial");
  assert.equal(job.completeness.complete, false);
  assert.equal(job.sources.testrail.truncated, true);
  assert.ok(job.completeness.reasons.includes("testrail_budget_exhausted"));
});

test("retries transient failures but not not-connected outcomes", async () => {
  const transient = coordinatorHarness({
    maxAttempts: 2,
    enrich: async (_request, call) => call === 1
      ? {
          testrail: {
            status: "unavailable",
            recordsCollected: 0,
            error: { code: "source_retrieval_failed", message: "temporary" }
          },
          github: { status: "complete", recordsCollected: 1 }
        }
      : {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        }
  });
  await transient.coordinator.start();
  await seedJira(transient.coordinator, "STT-11");
  await transient.coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-11" });
  await transient.coordinator.drain();
  assert.equal(transient.calls(), 2);
  assert.equal((await transient.coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-11"
  })).state, "complete");

  const permanent = coordinatorHarness({
    enrich: async () => ({
      testrail: {
        status: "unavailable",
        recordsCollected: 0,
        error: { code: "source_not_connected", message: "not connected" }
      },
      github: { status: "not-connected", recordsCollected: 0 }
    })
  });
  await permanent.coordinator.start();
  await seedJira(permanent.coordinator, "STT-12");
  await permanent.coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-12" });
  await permanent.coordinator.drain();
  assert.equal(permanent.calls(), 1);
  assert.equal((await permanent.coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-12"
  })).state, "partial");
});

test("preserves retry backoff unless refresh is forced", async () => {
  const { coordinator, calls } = coordinatorHarness({
    retryBaseMs: 30_000,
    enrich: async () => ({
      testrail: {
        status: "unavailable",
        recordsCollected: 0,
        error: { code: "source_retrieval_failed", message: "temporary" }
      },
      github: { status: "complete", recordsCollected: 1 }
    })
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-16");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-16" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(), 1);

  const pending = await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-16"
  });
  assert.equal(pending.state, "pending");
  assert.ok(Date.parse(pending.nextRetryAt) > Date.now());

  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-16" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(), 1);

  await coordinator.enqueue({
    productId: "fl-titling",
    issueKey: "STT-16",
    force: true
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(), 2);
  await coordinator.shutdown();
});

test("releases worker reservations when the initial store mutation fails", async () => {
  let failNextTransaction = false;
  const baseStore = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const store = {
    read: (...args) => baseStore.read(...args),
    initialize: (...args) => baseStore.initialize(...args),
    transact(...args) {
      if (failNextTransaction) {
        failNextTransaction = false;
        return Promise.reject(Object.assign(new Error("disk write failed"), { code: "EIO" }));
      }
      return baseStore.transact(...args);
    }
  };
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async enrichJiraIssue() {
        throw new Error("enrichment must not run");
      }
    }
  });
  await coordinator.start();
  await coordinator.recordJiraOutcome({
    productId: "fl-titling",
    issueKey: "STT-17",
    state: "local"
  });
  failNextTransaction = true;
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-17" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.status(), {
    queued: 0,
    active: 0,
    pausedProducts: []
  });
  await coordinator.shutdown();
});

test("cancels active work with AbortController", async () => {
  const { coordinator } = coordinatorHarness({
    enrich: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("cancelled"), { code: "retrieval_cancelled" }));
      }, { once: true });
    })
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-13");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-13" });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await coordinator.cancel({
    productId: "fl-titling",
    issueKey: "STT-13"
  });
  assert.equal(cancelled.state, "cancelled");
  await coordinator.drain();
  assert.equal((await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-13"
  })).state, "cancelled");
});

test("recovers persisted running jobs and makes no call for an empty store", async () => {
  const { coordinator, store, calls } = coordinatorHarness();
  await coordinator.start();
  assert.equal(calls(), 0);
  await store.transact((snapshot) => {
    snapshot.jobs.push({
      productId: "fl-titling",
      issueKey: "STT-14",
      state: "running",
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:00:00.000Z",
      queuedAt: "2026-09-15T10:00:00.000Z",
      startedAt: "2026-09-15T10:00:01.000Z",
      completedAt: null,
      cancelledAt: null,
      attemptCount: 1,
      nextRetryAt: null,
      force: false,
      sources: {
        jira: {
          state: "local", startedAt: null, completedAt: null, attemptCount: 0,
          recordsCollected: 0, truncated: false, error: null
        },
        testrail: {
          state: "running", startedAt: "2026-09-15T10:00:01.000Z",
          completedAt: null, attemptCount: 1, recordsCollected: 0,
          truncated: false, error: null
        },
        github: {
          state: "running", startedAt: "2026-09-15T10:00:01.000Z",
          completedAt: null, attemptCount: 1, recordsCollected: 0,
          truncated: false, error: null
        }
      },
      completeness: { status: "pending", complete: false, reasons: [] }
    });
  });
  await coordinator.shutdown();

  let recoveredCalls = 0;
  const recovered = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async enrichJiraIssue() {
        recoveredCalls += 1;
        return {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        };
      }
    }
  });
  await recovered.start();
  await recovered.drain();
  assert.equal(recoveredCalls, 1);
});

test("full sync preempts enrichment and deferred work resumes afterward", async () => {
  let calls = 0;
  const { coordinator } = coordinatorHarness({
    enrich: ({ signal }) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve({
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        });
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(
          Object.assign(new Error("preempted"), { code: "retrieval_cancelled" })
        ), { once: true });
      });
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-15");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-15" });
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.beginFullSync("fl-titling");
  assert.equal((await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-15"
  })).state, "pending");
  await coordinator.endFullSync("fl-titling");
  await coordinator.drain();
  assert.equal(calls, 2);
});

test("keeps nested full-sync pauses isolated", async () => {
  const { coordinator } = coordinatorHarness();
  await coordinator.start();

  await coordinator.beginFullSync("fl-titling");
  await coordinator.beginFullSync("fl-titling");
  await coordinator.endFullSync("fl-titling");
  assert.deepEqual(coordinator.status().pausedProducts, ["fl-titling"]);

  await coordinator.endFullSync("fl-titling");
  assert.deepEqual(coordinator.status().pausedProducts, []);
});

test("recovers an active job as pending after graceful shutdown", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      enrichJiraIssue({ signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            Object.assign(new Error("shutdown"), { code: "retrieval_cancelled" })
          ), { once: true });
        });
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-18");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-18" });
  await new Promise((resolve) => setImmediate(resolve));

  await coordinator.shutdown();

  const snapshot = await store.read();
  const persisted = snapshot.jobs.find((job) => job.issueKey === "STT-18");
  assert.equal(persisted.state, "pending");
  assert.equal(persisted.cancelledAt, null);
  assert.equal(persisted.sources.testrail.state, "pending");
  assert.equal(persisted.sources.github.state, "pending");
});

test("hydrates Jira before secondary enrichment when a refresh creates the job", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const calls = [];
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async hydrateJiraIssue({ issueKey }) {
        calls.push(`jira:${issueKey}`);
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue({ issueKey }) {
        calls.push(`secondary:${issueKey}`);
        return {
          testrail: { status: "complete", recordsCollected: 2 },
          github: { status: "complete", recordsCollected: 3 }
        };
      }
    }
  });
  await coordinator.start();

  await coordinator.enqueue({
    productId: "fl-titling",
    issueKey: "QA_CORE-19",
    force: true
  });
  await coordinator.drain();

  const job = await coordinator.get({
    productId: "fl-titling",
    issueKey: "QA_CORE-19"
  });
  assert.deepEqual(calls, ["jira:QA_CORE-19", "secondary:QA_CORE-19"]);
  assert.equal(job.state, "complete");
  assert.equal(job.sources.jira.state, "refreshed");
  assert.equal(job.completeness.complete, true);
});

test("forced refresh retries Jira after a negative receipt", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  let jiraCalls = 0;
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        jiraCalls += 1;
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        return {
          testrail: { status: "complete", recordsCollected: 2 },
          github: { status: "complete", recordsCollected: 3 }
        };
      }
    }
  });
  await coordinator.start();
  await coordinator.recordJiraOutcome({
    productId: "fl-titling",
    issueKey: "STT-20",
    state: "unavailable",
    error: { code: "source_retrieval_failed", message: "temporary" }
  });

  await coordinator.enqueue({
    productId: "fl-titling",
    issueKey: "STT-20",
    force: true
  });
  await coordinator.drain();

  const job = await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-20"
  });
  assert.equal(jiraCalls, 1);
  assert.equal(job.sources.jira.state, "refreshed");
  assert.equal(job.state, "complete");
});

test("automatically retries a transient Jira hydration failure", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  let jiraCalls = 0;
  const coordinator = createTicketContextCoordinator({
    store,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 1,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        jiraCalls += 1;
        if (jiraCalls === 1) {
          throw Object.assign(new Error("temporary"), {
            code: "source_retrieval_failed"
          });
        }
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        return {
          testrail: { status: "complete", recordsCollected: 2 },
          github: { status: "complete", recordsCollected: 3 }
        };
      }
    }
  });
  await coordinator.start();

  await coordinator.enqueue({
    productId: "fl-titling",
    issueKey: "STT-21",
    force: true
  });
  await coordinator.drain();

  const job = await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-21"
  });
  assert.equal(jiraCalls, 2);
  assert.equal(job.sources.jira.state, "refreshed");
  assert.equal(job.state, "complete");
});

test("forced refresh during an active run schedules one Jira follow-up", async () => {
  let releaseFirst;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let enrichCalls = 0;
  let jiraCalls = 0;
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        jiraCalls += 1;
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        enrichCalls += 1;
        if (enrichCalls === 1) await firstRun;
        return {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        };
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-22");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-22" });
  while (enrichCalls === 0) await new Promise((resolve) => setImmediate(resolve));

  await coordinator.enqueue({
    productId: "fl-titling",
    issueKey: "STT-22",
    force: true
  });
  releaseFirst();
  await coordinator.drain();

  assert.equal(enrichCalls, 2);
  assert.equal(jiraCalls, 1);
  assert.equal((await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-22"
  })).state, "complete");
});

test("does not treat local evidence time as a Jira synchronization watermark", async () => {
  let current = Date.parse("2026-09-15T12:00:00.000Z");
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    now: () => current,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        return {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        };
      }
    }
  });
  await coordinator.start();
  await coordinator.recordJiraOutcome({
    productId: "fl-titling",
    issueKey: "STT-23",
    state: "local"
  });

  const invalidation = await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-23",
    source: "jira",
    eventId: "delivery-local-watermark-1",
    observedAt: "2026-09-15T09:00:00.000Z"
  });
  assert.equal(invalidation.disposition, "accepted");
  current += 1;
  await coordinator.drain();
});

test("resumes an invalidation queued while full sync is paused", async () => {
  let calls = 0;
  const { coordinator } = coordinatorHarness({
    enrich: async () => {
      calls += 1;
      return {
        testrail: { status: "complete", recordsCollected: 1 },
        github: { status: "complete", recordsCollected: 1 }
      };
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-24");
  await coordinator.beginFullSync("fl-titling");

  const result = await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-24",
    source: "jira",
    eventId: "delivery-paused-1",
    observedAt: new Date(Date.now() + 1_000).toISOString()
  });
  assert.equal(result.disposition, "accepted");
  assert.equal(coordinator.status().queued, 1);
  assert.equal(calls, 0);

  await coordinator.endFullSync("fl-titling");
  await coordinator.drain();
  assert.equal(calls, 1);
});

test("accepts invalidation only for a retained hot ticket", async () => {
  const { coordinator, store, calls } = coordinatorHarness();
  await coordinator.start();

  const cold = await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-901",
    source: "jira",
    eventId: "delivery-cold-1",
    observedAt: new Date().toISOString()
  });
  assert.equal(cold.disposition, "ignored:not-hot");
  assert.equal(calls(), 0);
  assert.equal((await store.read()).jobs.length, 0);

  await seedJira(coordinator, "STT-902");
  const accepted = await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-902",
    source: "jira",
    eventId: "delivery-hot-1",
    observedAt: new Date(Date.now() + 1_000).toISOString()
  });
  assert.equal(accepted.disposition, "accepted");
  await coordinator.drain();
  assert.equal(calls(), 1);
  assert.doesNotMatch(JSON.stringify(await store.read()), /delivery-(?:cold|hot)-1/);
});

test("deduplicates invalidation delivery IDs after restart", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const service = {
    async enrichJiraIssue() {
      throw new Error("must not call a source for a cold ticket");
    }
  };
  const first = createTicketContextCoordinator({ store, sourceConnectionService: service });
  await first.start();
  assert.equal((await first.invalidate({
    productId: "fl-titling",
    issueKey: "STT-903",
    source: "jira",
    eventId: "delivery-restart-1",
    observedAt: "2026-09-15T18:00:00.000Z"
  })).disposition, "ignored:not-hot");
  await first.shutdown();

  const second = createTicketContextCoordinator({ store, sourceConnectionService: service });
  await second.start();
  assert.equal((await second.invalidate({
    productId: "fl-titling",
    issueKey: "STT-903",
    source: "jira",
    eventId: "delivery-restart-1",
    observedAt: "2026-09-15T18:05:00.000Z"
  })).disposition, "ignored:duplicate");
  assert.equal((await store.read()).receipts.length, 1);
  await second.shutdown();
});

test("ignores an event at or before the latest successful source completion", async () => {
  let current = Date.parse("2026-09-15T18:00:00.000Z");
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  let calls = 0;
  const coordinator = createTicketContextCoordinator({
    store,
    now: () => current,
    sourceConnectionService: {
      async enrichJiraIssue() {
        calls += 1;
        return {};
      }
    }
  });
  await coordinator.start();
  await coordinator.recordJiraOutcome({
    productId: "fl-titling",
    issueKey: "STT-904",
    state: "refreshed",
    recordsCollected: 1
  });

  current += 1_000;
  const result = await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-904",
    source: "jira",
    eventId: "delivery-obsolete-1",
    observedAt: "2026-09-15T18:00:00.000Z"
  });
  assert.equal(result.disposition, "ignored:obsolete");
  assert.equal(calls, 0);
});

test("coalesces multiple invalidations during a run into one follow-up", async () => {
  let releaseFirst;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let enrichCalls = 0;
  let jiraCalls = 0;
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        jiraCalls += 1;
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        enrichCalls += 1;
        if (enrichCalls === 1) await firstRun;
        return {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        };
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-905");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-905" });
  while (enrichCalls === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-905",
    source: "jira",
    eventId: "delivery-running-1",
    observedAt: new Date(Date.now() + 1_000).toISOString()
  })).disposition, "accepted");
  assert.equal((await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-905",
    source: "jira",
    eventId: "delivery-running-2",
    observedAt: new Date(Date.now() + 2_000).toISOString()
  })).disposition, "accepted");

  releaseFirst();
  await coordinator.drain();
  assert.equal(enrichCalls, 2);
  assert.equal(jiraCalls, 1);
});

test("refreshes Jira after an invalidation arrives before a failed active run completes", async () => {
  let releaseFirst;
  const firstRun = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let enrichCalls = 0;
  let jiraCalls = 0;
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    retryBaseMs: 1,
    retryMaxMs: 1,
    sourceConnectionService: {
      async hydrateJiraIssue() {
        jiraCalls += 1;
        return { status: "complete", recordsCollected: 1 };
      },
      async enrichJiraIssue() {
        enrichCalls += 1;
        if (enrichCalls === 1) {
          await firstRun;
          throw Object.assign(new Error("temporary secondary failure"), {
            code: "source_retrieval_failed"
          });
        }
        return {
          testrail: { status: "complete", recordsCollected: 1 },
          github: { status: "complete", recordsCollected: 1 }
        };
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-909");
  await coordinator.enqueue({ productId: "fl-titling", issueKey: "STT-909" });
  while (enrichCalls === 0) await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-909",
    source: "jira",
    eventId: "delivery-failed-run-1",
    observedAt: new Date(Date.now() + 1_000).toISOString()
  })).disposition, "accepted");

  releaseFirst();
  await coordinator.drain();

  const job = await coordinator.get({
    productId: "fl-titling",
    issueKey: "STT-909"
  });
  assert.equal(enrichCalls, 2);
  assert.equal(jiraCalls, 1);
  assert.equal(job.state, "complete");
  const persisted = (await store.read()).jobs.find((entry) => entry.issueKey === "STT-909");
  assert.equal(persisted.invalidation.sources.jira.stale, false);
});

test("reports product-scoped operations and aggregate capacity health", async () => {
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    maxJobs: 1,
    sourceConnectionService: {
      async enrichJiraIssue() {
        return {};
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-906");
  await coordinator.recordInvalidationRejection({
    productId: "fl-titling",
    source: "jira"
  });

  const operations = await coordinator.operations({ productId: "fl-titling" });
  assert.equal(operations.health.status, "degraded");
  assert.ok(operations.health.reasons.includes("capacity_high"));
  assert.equal(operations.durable.jobStates.pending, 1);
  assert.deepEqual(operations.capacity, { used: 1, max: 1, percent: 100 });
  assert.equal(operations.invalidations.dispositions.rejected, 1);
  assert.equal(operations.invalidations.dispositions["not-hot"], 0);
  assert.equal(operations.invalidations.last.disposition, "rejected");

  const health = await coordinator.health();
  assert.equal(health.status, "degraded");
  assert.ok(health.reasons.includes("capacity_high"));
});

test("periodically sweeps bounded terminal metadata and clears the timer on shutdown", async () => {
  let current = Date.parse("2026-09-15T18:00:00.000Z");
  let intervalCallback;
  let cleared = false;
  const intervalHandle = { unref() {} };
  const store = new InMemoryTicketContextJobStore({ tenantId: "solera" });
  const coordinator = createTicketContextCoordinator({
    store,
    now: () => current,
    retentionMs: 1_000,
    receiptRetentionMs: 1_000,
    retentionSweepIntervalMs: 500,
    setIntervalTimer(callback) {
      intervalCallback = callback;
      return intervalHandle;
    },
    clearIntervalTimer(handle) {
      assert.equal(handle, intervalHandle);
      cleared = true;
    },
    sourceConnectionService: {
      async enrichJiraIssue() {
        return {};
      }
    }
  });
  await coordinator.start();
  await seedJira(coordinator, "STT-907");
  await seedJira(coordinator, "STT-908");
  await store.transact((snapshot) => {
    const terminal = snapshot.jobs.find((job) => job.issueKey === "STT-907");
    terminal.state = "complete";
    terminal.completedAt = new Date(current).toISOString();
  });
  await coordinator.invalidate({
    productId: "fl-titling",
    issueKey: "STT-999",
    source: "jira",
    eventId: "delivery-expiring-1",
    observedAt: new Date(current).toISOString()
  });

  current += 2_000;
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = await store.read();
  assert.equal(snapshot.jobs.some((job) => job.issueKey === "STT-907"), false);
  assert.equal(snapshot.jobs.some((job) => job.issueKey === "STT-908"), true);
  assert.equal(snapshot.receipts.length, 0);
  assert.equal(snapshot.lastRetentionSweep.jobsDeleted, 1);
  assert.equal(snapshot.lastRetentionSweep.receiptsDeleted, 1);

  await coordinator.shutdown();
  assert.equal(cleared, true);
});
