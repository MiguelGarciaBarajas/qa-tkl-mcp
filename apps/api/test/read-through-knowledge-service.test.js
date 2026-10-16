import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors.js";
import { createReadThroughKnowledgeService } from "../src/read-through-knowledge-service.js";

function createHarness({
  exists = false,
  lastObservedAt = null,
  hydrate = async () => ({ status: "complete", recordsCollected: 1 }),
  now = () => Date.parse("2026-09-15T12:00:00.000Z")
} = {}) {
  let reads = 0;
  let hydrations = 0;
  const knowledgeService = {
    tenantId: "solera",
    requirementContextStatus() {
      return { exists, lastObservedAt };
    },
    async explainTraceability(request) {
      reads += 1;
      return { request, reads };
    }
  };
  const service = createReadThroughKnowledgeService({
    knowledgeService,
    sourceConnectionService: {
      async hydrateJiraIssue(request) {
        hydrations += 1;
        return hydrate(request);
      }
    },
    freshnessMs: 15 * 60 * 1_000,
    now
  });
  return {
    service,
    hydrationCount: () => hydrations
  };
}

test("uses fresh local Jira context without remote retrieval", async () => {
  const { service, hydrationCount } = createHarness({
    exists: true,
    lastObservedAt: "2026-09-15T11:50:00.000Z"
  });

  await service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });

  assert.equal(hydrationCount(), 0);
});

test("keeps a fresh local read successful when Jira receipt persistence fails", async () => {
  const auditEvents = [];
  const service = createReadThroughKnowledgeService({
    knowledgeService: {
      requirementContextStatus() {
        return { exists: true, lastObservedAt: "2026-09-15T11:50:00.000Z" };
      },
      async explainTraceability() {
        return { status: "available" };
      }
    },
    sourceConnectionService: {
      async hydrateJiraIssue() {
        throw new Error("fresh Jira must not be retrieved");
      }
    },
    ticketContextCoordinator: {
      async getJiraReceipt() {
        return null;
      },
      async recordJiraOutcome() {
        throw Object.assign(new Error("disk write failed"), { code: "EIO" });
      },
      async enqueue() {}
    },
    auditLogger: {
      record(event) {
        auditEvents.push(event);
      }
    },
    now: () => Date.parse("2026-09-15T12:00:00.000Z")
  });

  const result = await service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { status: "available" });
  assert.ok(auditEvents.some(
    (event) => event.eventType === "knowledge.jira_receipt.persist_failed"
  ));
});

test("starts related-source enrichment without delaying a fresh local read", async () => {
  let enrichmentCalls = 0;
  const service = createReadThroughKnowledgeService({
    knowledgeService: {
      requirementContextStatus() {
        return { exists: true, lastObservedAt: "2026-09-12T10:00:00.000Z" };
      },
      async getStoryTestContext({ storyId }) {
        return { storyId };
      }
    },
    sourceConnectionService: {
      async hydrateJiraIssue() {
        throw new Error("fresh Jira must not be retrieved");
      }
    },
    ticketContextCoordinator: {
      enqueue() {
        enrichmentCalls += 1;
        return new Promise(() => {});
      }
    },
    now: () => Date.parse("2026-09-12T10:05:00.000Z")
  });

  const context = await service.getStoryTestContext({
    productId: "fl-titling",
    storyId: "STT-1234"
  });

  assert.equal(context.storyId, "STT-1234");
  assert.equal(enrichmentCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
});

test("hydrates missing Jira context before rerunning the requested read", async () => {
  const { service, hydrationCount } = createHarness();

  const result = await service.explainTraceability({
    productId: "fl-titling",
    requirementId: "requirement:stt-1234"
  });

  assert.equal(hydrationCount(), 1);
  assert.equal(result.reads, 1);
});

test("caches a successful unchanged refresh for the freshness window", async () => {
  const { service, hydrationCount } = createHarness({
    exists: true,
    lastObservedAt: "2026-09-15T10:00:00.000Z"
  });

  await service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });
  await service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });

  assert.equal(hydrationCount(), 1);
});

test("coalesces concurrent read-through retrievals for one ticket", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { service, hydrationCount } = createHarness({
    hydrate: async () => {
      await gate;
      return { status: "complete", recordsCollected: 1 };
    }
  });

  const first = service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });
  const second = service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hydrationCount(), 1);
  release();
  await Promise.all([first, second]);
});

test("serves stale local context when refresh fails but fails closed when context is missing", async () => {
  const providerError = new ApiError(502, "source_unavailable", "Jira is unavailable.");
  const stale = createHarness({
    exists: true,
    lastObservedAt: "2026-09-15T10:00:00.000Z",
    hydrate: async () => {
      throw providerError;
    }
  });
  const staleResult = await stale.service.explainTraceability({
    productId: "fl-titling",
    requirementId: "STT-1234"
  });
  assert.equal(staleResult.reads, 1);

  const missing = createHarness({
    hydrate: async () => {
      throw providerError;
    }
  });
  await assert.rejects(
    () => missing.service.explainTraceability({
      productId: "fl-titling",
      requirementId: "STT-1234"
    }),
    (error) => error === providerError
  );
  await assert.rejects(
    () => missing.service.explainTraceability({
      productId: "fl-titling",
      requirementId: "STT-1234"
    }),
    (error) =>
      error instanceof ApiError
      && error.code === providerError.code
      && error.message === providerError.message
  );
  assert.equal(missing.hydrationCount(), 1);
});

test("hydrates Jira requirement resources but ignores unrelated resource kinds", async () => {
  let hydrations = 0;
  const knowledgeService = {
    tenantId: "solera",
    requirementContextStatus() {
      return { exists: false, lastObservedAt: null };
    },
    async readResource(request) {
      return request;
    }
  };
  const service = createReadThroughKnowledgeService({
    knowledgeService,
    sourceConnectionService: {
      async hydrateJiraIssue({ issueKey }) {
        hydrations += 1;
        assert.equal(issueKey, "STT-1234");
        return { status: "complete", recordsCollected: 1 };
      }
    }
  });

  await service.readResource({
    productId: "fl-titling",
    uri: "tkl://products/fl-titling/requirements/STT-1234"
  });
  await service.readResource({
    productId: "fl-titling",
    uri: "tkl://products/fl-titling/features/login"
  });

  assert.equal(hydrations, 1);
});

test("uses a durable negative Jira receipt without repeating the remote call", async () => {
  let hydrations = 0;
  const service = createReadThroughKnowledgeService({
    knowledgeService: {
      requirementContextStatus() {
        return { exists: false, lastObservedAt: null };
      },
      async explainTraceability() {
        throw new Error("the read must not run without Jira context");
      }
    },
    sourceConnectionService: {
      async hydrateJiraIssue() {
        hydrations += 1;
        throw new Error("remote call must be skipped");
      }
    },
    ticketContextCoordinator: {
      async getJiraReceipt() {
        return {
          state: "unavailable",
          completedAt: "2026-09-15T11:59:00.000Z",
          error: {
            code: "jira_issue_not_found",
            message: "Jira could not find the requested issue."
          }
        };
      }
    },
    now: () => Date.parse("2026-09-15T12:00:00.000Z")
  });

  await assert.rejects(
    () => service.explainTraceability({
      productId: "fl-titling",
      requirementId: "STT-404"
    }),
    (error) => error instanceof ApiError && error.code === "jira_issue_not_found"
  );
  assert.equal(hydrations, 0);
});
