import { describe, expect, it, vi } from "vitest";
import type {
  ApprovedActionApproval,
  ApprovedActionPreview,
  TicketContextJob,
  TicketContextOperations,
} from "../contracts/types";
import { HttpTklApiClient } from "./httpClient";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeClient(fetchImpl: typeof fetch) {
  return new HttpTklApiClient({
    baseUrl: "https://tkl-api.example.com",
    token: "test-token",
    productId: "fl-titling",
    fetchImpl,
  });
}

const contextJob: TicketContextJob = {
  productId: "fl-titling",
  issueKey: "STT-123",
  state: "pending",
  createdAt: "2026-09-15T18:00:00.000Z",
  updatedAt: "2026-09-15T18:00:00.000Z",
  queuedAt: "2026-09-15T18:00:00.000Z",
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  attemptCount: 0,
  nextRetryAt: null,
  sources: {
    jira: {
      state: "pending",
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
      recordsCollected: 0,
      truncated: false,
      error: null,
    },
    testrail: {
      state: "pending",
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
      recordsCollected: 0,
      truncated: false,
      error: null,
    },
    github: {
      state: "pending",
      startedAt: null,
      completedAt: null,
      attemptCount: 0,
      recordsCollected: 0,
      truncated: false,
      error: null,
    },
  },
  completeness: {
    status: "pending",
    complete: false,
    reasons: ["Secondary source enrichment is queued."],
  },
};

const contextOperations: TicketContextOperations = {
  health: {
    status: "healthy",
    reasons: [],
  },
  durable: {
    jobStates: {
      pending: 1,
      running: 1,
      complete: 8,
      partial: 1,
      unavailable: 0,
      cancelled: 1,
    },
    totalJobs: 12,
    deliveryReceipts: 9,
  },
  memory: {
    queued: 1,
    active: 1,
    delayedRetry: 1,
    paused: false,
    oldestQueuedAgeMs: 7_500,
  },
  attempts: 16,
  retries: 4,
  capacity: { used: 12, max: 100, percent: 12 },
  lastSuccessfulCompletion: "2026-09-15T18:00:00.000Z",
  lastWorkerFailure: { at: "2026-09-15T17:00:00.000Z", code: "worker_timeout" },
  lastPersistenceFailure: null,
  invalidations: {
    dispositions: {
      accepted: 9,
      duplicate: 2,
      obsolete: 1,
      "not-hot": 3,
      rejected: 0,
    },
    last: {
      source: "jira",
      observedAt: "2026-09-15T17:59:00.000Z",
      receivedAt: "2026-09-15T17:59:01.000Z",
      disposition: "accepted",
    },
  },
  lastRetentionSweep: {
    startedAt: "2026-09-15T16:00:00.000Z",
    completedAt: "2026-09-15T16:00:01.000Z",
    jobsDeleted: 2,
    receiptsDeleted: 1,
  },
};

describe("HttpTklApiClient", () => {
  it("loads and maps product-scoped JIT context operations", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ operations: contextOperations }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getTicketContextOperations()).resolves.toEqual(contextOperations);

    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/v1/context-operations");
    expect(url.searchParams.get("productId")).toBe("fl-titling");
    expect([...url.searchParams.keys()]).toEqual(["productId"]);
    expect(init.method).toBe("GET");
  });

  it("rejects malformed JIT context operation responses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      operations: {
        ...contextOperations,
        memory: { ...contextOperations.memory, queued: "1" },
      },
    }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getTicketContextOperations())
      .rejects.toThrow("Invalid context operations response at operations.memory.queued");
  });

  it("accepts nullable rejection timestamps from the operations API", async () => {
    const response = {
      operations: {
        ...contextOperations,
        health: { status: "degraded", reasons: ["persistence_failure"] },
        invalidations: {
          ...contextOperations.invalidations,
          last: {
            source: "jira",
            observedAt: null,
            receivedAt: "2026-09-15T18:01:00.000Z",
            disposition: "rejected",
          },
        },
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(response));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getTicketContextOperations()).resolves.toEqual(response.operations);
  });

  it("loads a ticket context job from the product-scoped path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ job: contextJob }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getTicketContextJob("stt-123")).resolves.toEqual(contextJob);

    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/v1/context-jobs/STT-123");
    expect(url.searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("GET");
  });

  it("maps a missing ticket context job to null", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "not_found", message: "No job exists." } }, 404));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getTicketContextJob("STT-404")).resolves.toBeNull();
  });

  it("refreshes ticket context with POST and accepts the 202 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ job: contextJob }, 202));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.refreshTicketContext("STT-123")).resolves.toEqual(contextJob);

    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/v1/context-jobs/STT-123/refresh");
    expect(url.searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("cancels ticket context with DELETE and surfaces non-404 failures", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        job: { ...contextJob, state: "cancelled", completeness: {
          status: "cancelled",
          complete: false,
          reasons: ["Background enrichment was cancelled."],
        } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "conflict", message: "The job cannot be cancelled." },
      }, 409));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.cancelTicketContext("STT-123")).resolves.toMatchObject({
      state: "cancelled",
    });
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/context-jobs/STT-123");
    expect(init.method).toBe("DELETE");
    await expect(client.cancelTicketContext("STT-123"))
      .rejects.toThrow("The job cannot be cancelled.");
  });

  it("keeps approved action preview separate and preserves blocked execution status", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input as string);
      expect(url.pathname).toBe("/v1/actions/previews");
      expect(init?.method).toBe("POST");
      return jsonResponse({
        preview: {
          id: "preview:00000000-0000-4000-8000-000000000001",
          productId: "fl-titling",
          subject: "qa-reviewer",
          actionType: "testrail.case.update",
          target: { caseId: "1201" },
          changes: { title: "Updated title" },
          sourceVersions: [{ source: "testrail", sourceId: "1201", sourceVersion: "1" }],
          requiredPermission: "actions:testrail-case-update",
          previewHash: "a".repeat(64),
          risk: "high",
          summary: "Review the exact change.",
          executable: false,
          executionStatus: "blocked",
          blockReason: {
            code: "external_writes_not_configured",
            message: "External writes are not configured.",
          },
          createdAt: "2026-09-14T08:00:00.000Z",
          expiresAt: "2026-09-14T08:15:00.000Z",
        },
      });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const preview = await client.previewApprovedAction({
      actionType: "testrail.case.update",
      target: { caseId: "1201" },
      changes: { title: "Updated title" },
      sourceVersions: [{ source: "testrail", sourceId: "1201", sourceVersion: "1" }],
      idempotencyKey: "preview-client-1201",
    });

    expect(preview.executable).toBe(false);
    expect(preview.blockReason?.code).toBe("external_writes_not_configured");
    const body = JSON.parse(String(
      (fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit])[1].body,
    ));
    expect(body).not.toHaveProperty("previewHash");
    expect(body).not.toHaveProperty("approvalId");
  });

  it("uses stable approval and execution idempotency keys", async () => {
    const preview: ApprovedActionPreview = {
      id: "preview:00000000-0000-4000-8000-000000000001",
      productId: "fl-titling",
      subject: "qa-reviewer",
      actionType: "testrail.case.update",
      target: { caseId: "1201" },
      changes: { title: "Updated title" },
      sourceVersions: [{ source: "testrail", sourceId: "1201", sourceVersion: "1" }],
      requiredPermission: "actions:testrail-case-update",
      previewHash: "a".repeat(64),
      risk: "high",
      summary: "Review the exact change.",
      executable: true,
      executionStatus: "ready",
      blockReason: null,
      createdAt: "2026-09-14T08:00:00.000Z",
      expiresAt: "2026-09-14T08:15:00.000Z",
    };
    const approval: ApprovedActionApproval = {
      id: "approval:00000000-0000-4000-8000-000000000002",
      previewId: preview.id,
      previewHash: preview.previewHash,
      productId: preview.productId,
      subject: preview.subject,
      actionType: preview.actionType,
      requiredPermission: preview.requiredPermission,
      status: "approved",
      approvedAt: "2026-09-14T08:01:00.000Z",
      expiresAt: "2026-09-14T08:06:00.000Z",
      consumedAt: null,
    };
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const url = new URL(input as string);
      if (url.pathname === "/v1/actions/approvals") {
        return jsonResponse({ approval });
      }
      if (url.pathname === "/v1/actions/executions") {
        return jsonResponse({
          execution: {
            id: "execution:00000000-0000-4000-8000-000000000003",
            approvalId: approval.id,
            previewId: preview.id,
            previewHash: preview.previewHash,
            productId: preview.productId,
            subject: preview.subject,
            actionType: preview.actionType,
            status: "blocked",
            externalCallMade: false,
            reason: { code: "external_writes_not_configured", message: "Writes are disabled." },
            attemptedAt: "2026-09-14T08:02:00.000Z",
            completedAt: "2026-09-14T08:02:00.000Z",
            recovery: { required: false, instructions: "No rollback is required." },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.approveAction(preview);
    await client.approveAction(preview);
    await client.executeApprovedAction(preview, approval);
    await client.executeApprovedAction(preview, approval);

    const requestBodies = fetchImpl.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)));
    expect(requestBodies.slice(0, 2).map((body) => body.idempotencyKey))
      .toEqual([`approve:${preview.id}`, `approve:${preview.id}`]);
    expect(requestBodies.slice(2).map((body) => body.idempotencyKey))
      .toEqual([`execute:${approval.id}`, `execute:${approval.id}`]);
  });

  it("sends a source credential only in the connection request body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        connection: {
          source: "github",
          displayName: "GitHub",
          status: "connected",
          ownerSubject: "qa-lead",
          configured: true,
          ingestionSupported: true,
          config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] },
          connectedAt: "2026-09-12T00:00:00.000Z",
          lastValidatedAt: "2026-09-12T00:00:00.000Z",
          lastSyncAt: null,
          lastSuccessfulSyncAt: null,
          error: null,
        },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const connection = await client.saveSourceConnection("github", {
      credential: "test-token",
      config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] },
    });

    expect(connection.status).toBe("connected");
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/v1/source-connections/github");
    expect(url.searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      credential: "test-token",
      config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] },
    });
    expect(url.toString()).not.toContain("test-token");
  });

  it("cancels a source synchronization with DELETE", async () => {
    const connection = {
      source: "github",
      displayName: "GitHub",
      status: "error",
      ownerSubject: "qa-lead",
      configured: true,
      ingestionSupported: true,
      config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] },
      connectedAt: "2026-09-12T00:00:00.000Z",
      lastValidatedAt: "2026-09-12T00:00:00.000Z",
      lastSyncAt: "2026-09-15T00:00:00.000Z",
      lastSuccessfulSyncAt: null,
      error: {
        code: "sync_cancelled",
        category: "internal",
        message: "The synchronization was cancelled.",
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ connection }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.cancelSourceConnectionSync("github")).resolves.toEqual(connection);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(input as string);
    expect(url.pathname).toBe("/v1/source-connections/github/sync");
    expect(url.searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("DELETE");
  });

  it("uses repository-specific GitHub CRUD and operation endpoints", async () => {
    const repository = {
      id: "repo-id",
      repository: "Solera-Engineering/repo",
      url: "https://github.com/Solera-Engineering/repo",
      purpose: "test-automation",
      lifecycle: "active",
      enabled: true,
      validationStatus: "valid",
      syncStatus: "succeeded",
      lastValidatedAt: "2026-09-15T12:00:00.000Z",
      lastSyncAt: "2026-09-15T12:05:00.000Z",
      lastSuccessfulSyncAt: "2026-09-15T12:05:00.000Z",
      recordsCollected: 10,
      error: null,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(input as string);
      return jsonResponse(
        url.pathname === "/v1/source-connections/github/repositories"
          ? { repositories: [repository], repository }
          : { repository },
      );
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.getGitHubRepositories();
    await client.getGitHubRepository("repo-id");
    await client.createGitHubRepository({
      repository: repository.repository,
      purpose: "test-automation",
    });
    await client.updateGitHubRepository("repo-id", {
      lifecycle: "maintenance",
      enabled: false,
    });
    await client.deleteGitHubRepository("repo-id");
    await client.testGitHubRepository("repo-id");
    await client.syncGitHubRepository("repo-id");
    await client.cancelGitHubRepositorySync("repo-id");

    const requests = fetchImpl.mock.calls.map(([input, init]) => {
      const url = new URL(input as string);
      return {
        path: url.pathname,
        productId: url.searchParams.get("productId"),
        method: (init as RequestInit | undefined)?.method ?? "GET",
        body: (init as RequestInit | undefined)?.body
          ? JSON.parse(String((init as RequestInit).body))
          : undefined,
      };
    });
    expect(requests).toEqual([
      {
        path: "/v1/source-connections/github/repositories",
        productId: "fl-titling",
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id",
        productId: "fl-titling",
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/source-connections/github/repositories",
        productId: "fl-titling",
        method: "POST",
        body: {
          repository: "Solera-Engineering/repo",
          purpose: "test-automation",
        },
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id",
        productId: "fl-titling",
        method: "PATCH",
        body: { lifecycle: "maintenance", enabled: false },
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id",
        productId: "fl-titling",
        method: "DELETE",
        body: undefined,
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id/test",
        productId: "fl-titling",
        method: "POST",
        body: undefined,
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id/sync",
        productId: "fl-titling",
        method: "POST",
        body: undefined,
      },
      {
        path: "/v1/source-connections/github/repositories/repo-id/sync",
        productId: "fl-titling",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("maps /health components into ConnectorHealth entries", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        jsonResponse({
          dependencies: {
            components: [
              {
                component: "connector:github",
                status: "healthy",
                lastSyncAt: "2024-01-01T00:00:00.000Z",
                lastSuccessfulSyncAt: "2024-01-01T00:00:00.000Z",
                records: 10,
                failures: 1,
                credentialRef: "cred-1",
              },
              {
                component: "connector:testrail",
                status: "down",
                records: 0,
                failures: 0,
              },
            ],
          },
        }),
    );

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getConnectorHealth();

    expect(result).toEqual([
      {
        connectorId: "github",
        source: "github",
        status: "healthy",
        lastSyncAt: "2024-01-01T00:00:00.000Z",
        lastSuccessfulSyncAt: "2024-01-01T00:00:00.000Z",
        recordsSyncedLast24h: 10,
        errorRateLast24h: 0.1,
        credentialStatus: "valid",
        message: undefined,
      },
      {
        connectorId: "testrail",
        source: "testrail",
        status: "failing",
        lastSyncAt: null,
        lastSuccessfulSyncAt: null,
        recordsSyncedLast24h: 0,
        errorRateLast24h: 0,
        credentialStatus: "missing",
        message: undefined,
      },
    ]);

    const [requestedInput, requestedInit] = fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const requestedUrl = new URL(requestedInput as string);
    expect(requestedUrl.pathname).toBe("/health");
    const headers = requestedInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("loads bounded story traceability with one aggregate request", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input as string);
      if (url.pathname === "/v1/intelligence/traceability") {
        return jsonResponse({
          items: [{
            story: { id: "STORY-1", type: "story", title: "Story One" },
            requirements: [{ id: "REQ-1", type: "requirement", title: "Requirement One" }],
            tests: [
              { id: "TEST-1", type: "test", title: "Automated Test", provenance: { source: "github" } },
              { id: "TEST-2", type: "manual-test", title: "Manual Test", provenance: { source: "testrail" } },
            ],
            relationships: [
              { fromEntityId: "TEST-1", toEntityId: "REQ-1", origin: "explicit", confidence: 1 },
            ],
          }],
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const [story] = await client.getStoryTraceability();

    expect(story.storyId).toBe("STORY-1");
    expect(story.requirements).toEqual([
      {
        id: "REQ-1",
        title: "Requirement One",
        source: "jira",
        provenance: {
          source: "jira",
          sourceVersion: "unknown",
          observedAt: new Date(0).toISOString(),
          classification: "internal",
        },
      },
    ]);
    expect(story.tests.map((t) => t.type)).toEqual(["automated", "manual"]);
    expect(story.tests[0].status).toBe("unknown");
    expect(story.tests[0].lastExecutedAt).toBeUndefined();
    expect(story.links).toEqual([
      { requirementId: "REQ-1", testId: "TEST-1", confidence: "explicit", reviewed: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requests one bounded aggregate coverage page", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input as string);
      if (url.pathname === "/v1/intelligence/coverage") {
        return jsonResponse({
          items: [
            {
              requirement: { id: "REQ-1", type: "requirement", title: "Requirement One" },
              finding: null,
            },
            {
              requirement: { id: "REQ-2", type: "requirement", title: "Requirement Two" },
              finding: null,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const client = new HttpTklApiClient({
      baseUrl: "https://tkl-api.example.com",
      productId: "fl-titling",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.getCoverageGaps();

    const requests = fetchImpl.mock.calls
      .map(([input]) => new URL(input as string))
      .filter((url) => url.pathname === "/v1/intelligence/coverage");
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("offset")).toBe("0");
    expect(requests[0].searchParams.get("limit")).toBe("8");
    expect(requests[0].searchParams.get("source")).toBe("jira");
  });

  it("buckets numeric linkConfidence into labeled coverage gaps", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input as string);
      if (url.pathname === "/v1/intelligence/coverage") {
        return jsonResponse({
          items: [{
            requirement: { id: "REQ-1", type: "requirement", title: "Requirement One" },
            finding: { requirementId: "REQ-1", numerator: 1, denominator: 2, linkConfidence: 0.95 },
          }],
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const gaps = await client.getCoverageGaps();

    expect(gaps).toEqual([
      {
        requirementId: "REQ-1",
        requirementTitle: "Requirement One",
        storyId: "REQ-1",
        numerator: 1,
        denominator: 2,
        linkConfidence: "explicit",
      },
    ]);
  });

  it("maps /v1/knowledge/conflicts records into KnowledgeConflict entries", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        conflicts: [
          {
            id: "CONFLICT-1",
            entityId: "REQ-1",
            claimIds: ["claim:jira:REQ-1@v1", "claim:github:REQ-1-test@v1"],
            reason: "Two sources disagree",
            detectedAt: "2024-01-02T00:00:00.000Z",
            status: "open",
          },
        ],
      }),
    );

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const conflicts = await client.getKnowledgeConflicts();

    expect(conflicts).toEqual([
      {
        id: "CONFLICT-1",
        entityId: "REQ-1",
        entityTitle: "REQ-1",
        description: "Two sources disagree",
        detectedAt: "2024-01-02T00:00:00.000Z",
        status: "open",
        claimIds: ["claim:jira:REQ-1@v1", "claim:github:REQ-1-test@v1"],
      },
    ]);
  });

  it("posts a conflict review to the approved review endpoint and maps the response", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input as string);
      expect(url.pathname).toBe("/v1/knowledge/conflicts/review");
      expect(url.searchParams.get("productId")).toBe("fl-titling");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        conflictId: "CONFLICT-1",
        approvedClaimIds: ["claim:jira:REQ-1@v1"],
        note: "Confirmed with product owner.",
      });
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer " + "test-token");
      expect(headers["content-type"]).toBe("application/json");

      return jsonResponse({
        productId: "fl-titling",
        conflict: {
          id: "CONFLICT-1",
          entityId: "REQ-1",
          claimIds: ["claim:jira:REQ-1@v1", "claim:github:REQ-1-test@v1"],
          reason: "Two sources disagree",
          detectedAt: "2024-01-02T00:00:00.000Z",
          status: "reviewed",
        },
        review: {
          id: "review-1",
          targetId: "CONFLICT-1",
          decision: "resolved",
          approvedClaimIds: ["claim:jira:REQ-1@v1"],
          reviewerId: "test-user",
          reviewedAt: "2024-01-03T00:00:00.000Z",
        },
      });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const reviewed = await client.reviewKnowledgeConflict({
      conflictId: "CONFLICT-1",
      approvedClaimIds: ["claim:jira:REQ-1@v1"],
      note: "Confirmed with product owner.",
    });

    expect(reviewed).toEqual({
      id: "CONFLICT-1",
      entityId: "REQ-1",
      entityTitle: "REQ-1",
      description: "Two sources disagree",
      detectedAt: "2024-01-02T00:00:00.000Z",
      status: "reviewed",
      claimIds: ["claim:jira:REQ-1@v1", "claim:github:REQ-1-test@v1"],
    });
  });

  it("surfaces the server error message when a conflict review is rejected", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: "conflict_already_reviewed", message: "Conflict CONFLICT-1 has already been reviewed." } },
        409,
      ),
    );

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.reviewKnowledgeConflict({ conflictId: "CONFLICT-1", approvedClaimIds: ["claim:jira:REQ-1@v1"] }),
    ).rejects.toThrow("Conflict CONFLICT-1 has already been reviewed.");
  });

  it("loads evaluation metrics from the application API", async () => {
    const metrics = {
      datasetVersion: "golden-fl-titling-v1",
      ticketCount: 25,
      precision: 0.9,
      recall: 0.8,
      provenanceCompleteness: 1,
      freshnessHours: 3,
      latencyMsP50: 10,
      latencyMsP95: 20,
      qaAcceptanceRate: 0.75,
    };
    const fetchImpl = vi.fn(async () => jsonResponse(metrics));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.getEvaluationMetrics()).resolves.toEqual(metrics);
    const [input] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL];
    expect(new URL(input as string).pathname).toBe("/v1/evaluation/metrics");
    expect(new URL(input as string).searchParams.get("productId")).toBe("fl-titling");
  });

  it("runs the Coverage and Context Agent with one POST request", async () => {
    const agentRun = {
      runId: "run-1",
      agent: { id: "agent.coverage-context", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-3731",
      generatedAt: "2026-09-14T00:00:00.000Z",
      status: "insufficient-context",
      confidence: { level: "low", rationale: "Jira only." },
      summary: "Jira context only.",
      findings: [],
      recommendations: [],
      evidence: { sources: ["jira"], requirements: [], tests: [], relationships: [], citations: [] },
      limitations: ["No TestRail evidence."],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.runCoverageContextAgent("STT-3731")).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/agents/coverage-context/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workItemId: "STT-3731" });
  });

  it("runs the Test Designer Agent with one POST request", async () => {
    const agentRun = {
      runId: "designer-run-1",
      agent: { id: "agent.test-designer", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T01:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Acceptance criteria available." },
      summary: "One draft proposed.",
      proposals: [],
      evidence: { sources: ["jira"], requirements: [], existingManualTests: [], citations: [] },
      limitations: [],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.runTestDesignerAgent("STT-100")).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/agents/test-designer/runs");
    expect(init.method).toBe("POST");
  });

  it("runs the TestRail Improvement Agent with one POST request", async () => {
    const agentRun = {
      runId: "improvement-run-1",
      agent: { id: "agent.testrail-improvement", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T02:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Grounded TestRail evidence." },
      summary: "One edit proposed.",
      proposals: [],
      evidence: {
        sources: ["jira", "testrail"],
        requirements: [],
        manualTests: [],
        relationships: [],
        citations: [],
      },
      limitations: ["Proposal only."],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.runTestRailImprovementAgent("STT-100")).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/agents/testrail-improvement/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workItemId: "STT-100" });
  });

  it("runs the Automation Designer with one POST request", async () => {
    const agentRun = {
      runId: "automation-run-1",
      agent: { id: "agent.automation-designer", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T03:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Repository paths are available." },
      summary: "One file-plan item proposed.",
      proposal: {
        delivery: "review-only",
        codeGeneration: { status: "abstained", rationale: "No file contents." },
        filePlan: [],
        codeOutline: [],
        reusableComponents: [],
        requiredTestData: [],
        validationCommands: [],
        conventions: {
          testDirectories: [],
          testFileSuffixes: [],
          fileExtensions: [],
          frameworkSignals: [],
        },
        discoveryTasks: [],
      },
      evidence: {
        sources: ["jira", "testrail", "github"],
        requirements: [],
        manualCases: [],
        automatedTests: [],
        repositoryFiles: [],
        citations: [],
      },
      limitations: ["Proposal only."],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.runAutomationDesignerAgent("STT-100")).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/agents/automation-designer/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workItemId: "STT-100" });
  });

  it("runs Reliability and Defect Intelligence with one POST request", async () => {
    const agentRun = {
      runId: "reliability-run-1",
      agent: { id: "agent.reliability-defect-intelligence", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T04:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Multi-run history is available." },
      summary: "One identity analyzed.",
      analyses: [],
      recommendations: [],
      evidence: {
        sources: ["jira", "reportportal"],
        requirements: [],
        reportPortalExecutions: [],
        jiraDefects: [],
        citations: [],
      },
      limitations: [],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.runReliabilityDefectIntelligenceAgent("STT-100"),
    ).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname)
      .toBe("/v1/agents/reliability-defect-intelligence/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workItemId: "STT-100" });
  });

  it("runs Knowledge Curator with one product-scoped POST request", async () => {
    const agentRun = {
      runId: "curator-run-1",
      agent: { id: "agent.knowledge-curator", version: "0.1.0" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T05:00:00.000Z",
      scope: {
        rootRequirementId: "requirement:STT-100",
        requirementIds: ["requirement:STT-100"],
        productId: "fl-titling",
      },
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Scoped evidence is available." },
      summary: "One proposal is ready for review.",
      findings: [],
      proposals: [],
      evidence: {
        sources: ["jira"],
        requirements: [],
        entities: [],
        claims: [],
        traceLinks: [],
        openConflicts: [],
        unresolvedTraceLinks: [],
        citations: [],
      },
      limitations: ["Proposal only."],
      approval: { required: true, role: "knowledge-reviewer" },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(agentRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.runKnowledgeCuratorAgent("STT-100")).resolves.toEqual(agentRun);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/agents/knowledge-curator/runs");
    expect(new URL(input as string).searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workItemId: "STT-100" });
  });

  it("asks TKL with one product-scoped POST request and resolves citation links", async () => {
    const askRun = {
      runId: "ask-run-1",
      agent: { id: "agent.ask-tkl", version: "0.1.0", mode: "read-only" },
      productId: "fl-titling",
      question: "What covers STT-100?",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T06:00:00.000Z",
      intent: { primary: "coverage-context", matched: ["coverage-context"] },
      scope: { productId: "fl-titling", workItemId: "STT-100", interpretation: "exact scope" },
      status: "answered",
      answer: "Grounded answer. [S1]",
      citations: [{
        id: "S1",
        source: "jira",
        sourceId: "STT-100",
        sourceVersion: "1",
        observedAt: "2026-09-14T00:00:00.000Z",
        resourceUri: "tkl://products/fl-titling/sources/jira/STT-100/provenance",
        href: "/v1/resources/read?productId=fl-titling",
      }],
      freshness: {
        status: "current",
        asOf: "2026-09-14T06:00:00.000Z",
        newestObservedAt: "2026-09-14T00:00:00.000Z",
        oldestObservedAt: "2026-09-14T00:00:00.000Z",
        staleCitationCount: 0,
        thresholdDays: 30,
      },
      confidence: { level: "high", rationale: "Current cited evidence." },
      conflicts: [],
      limitations: [],
      nextActions: [],
      toolCalls: [],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(askRun));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.askTkl({
      question: "What covers STT-100?",
      workItemId: "STT-100",
    });

    expect(result.citations[0].href)
      .toBe("https://tkl-api.example.com/v1/resources/read?productId=fl-titling");
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(input as string).pathname).toBe("/v1/ask");
    expect(new URL(input as string).searchParams.get("productId")).toBe("fl-titling");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      question: "What covers STT-100?",
      workItemId: "STT-100",
    });
  });

  it("throws the server-provided error message on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "productId is required" } }, 400),
    );

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getKnowledgeConflicts()).rejects.toThrow("productId is required");
  });

  it("backs off and retries rate-limited requests", async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: "rate_limit_exceeded",
          message: "Too many requests.",
          details: { retryAfterMs: 25 },
        },
      }, 429))
      .mockResolvedValueOnce(jsonResponse({ conflicts: [] }));
    const client = new HttpTklApiClient({
      baseUrl: "https://tkl-api.example.com",
      productId: "fl-titling",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.getKnowledgeConflicts()).resolves.toEqual([]);
    expect(sleepImpl).toHaveBeenCalledWith(25);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
