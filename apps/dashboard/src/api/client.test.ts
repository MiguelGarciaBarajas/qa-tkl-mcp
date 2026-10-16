import { describe, expect, it } from "vitest";
import {
  createDefaultTklApiClient,
  DashboardConfigurationError,
  MockTklApiClient,
} from "./client";
import { HttpTklApiClient } from "./httpClient";
import { mockKnowledgeConflicts, mockTicketContextOperations } from "../mocks/fixtures";

describe("createDefaultTklApiClient", () => {
  it("fails closed when production API configuration is absent", () => {
    expect(() => createDefaultTklApiClient({
      baseUrl: undefined,
      token: undefined,
      productId: "fl-titling",
      allowMockData: false,
    })).toThrow(DashboardConfigurationError);
  });

  it("allows fixture data only when development or demo mode explicitly enables it", () => {
    expect(createDefaultTklApiClient({
      baseUrl: undefined,
      token: undefined,
      productId: "fl-titling",
      allowMockData: true,
    })).toBeInstanceOf(MockTklApiClient);
  });

  it("uses the real HTTP client whenever an API base URL is configured", () => {
    expect(createDefaultTklApiClient({
      baseUrl: "https://tkl-api.example.com",
      token: undefined,
      productId: "fl-titling",
      allowMockData: false,
    })).toBeInstanceOf(HttpTklApiClient);
  });
});

describe("MockTklApiClient", () => {
  it("returns an isolated JIT context operations fixture without external calls", async () => {
    const client = new MockTklApiClient();

    const first = await client.getTicketContextOperations();
    first.memory.queued = 999;

    await expect(client.getTicketContextOperations()).resolves.toEqual(
      mockTicketContextOperations,
    );
  });

  it("creates, reads, and cancels ticket context jobs without external calls", async () => {
    const client = new MockTklApiClient();

    await expect(client.getTicketContextJob("STT-999")).resolves.toBeNull();
    await expect(client.refreshTicketContext("stt-999")).resolves.toMatchObject({
      issueKey: "STT-999",
      state: "pending",
    });
    await expect(client.getTicketContextJob("STT-999")).resolves.toMatchObject({
      state: "pending",
    });
    await expect(client.cancelTicketContext("STT-999")).resolves.toMatchObject({
      state: "cancelled",
      completeness: { status: "cancelled", complete: false },
    });
  });

  it("marks a conflict reviewed and persists the status across subsequent reads", async () => {
    const client = new MockTklApiClient();
    const [conflict] = mockKnowledgeConflicts;

    const reviewed = await client.reviewKnowledgeConflict({
      conflictId: conflict.id,
      approvedClaimIds: [conflict.claimIds[0]],
    });
    expect(reviewed.status).toBe("reviewed");

    const conflicts = await client.getKnowledgeConflicts();
    expect(conflicts.find((candidate) => candidate.id === conflict.id)?.status).toBe("reviewed");
  });

  it("rejects reviewing an already-reviewed conflict", async () => {
    const client = new MockTklApiClient();
    const [conflict] = mockKnowledgeConflicts;

    await client.reviewKnowledgeConflict({
      conflictId: conflict.id,
      approvedClaimIds: [conflict.claimIds[0]],
    });

    await expect(
      client.reviewKnowledgeConflict({ conflictId: conflict.id, approvedClaimIds: [conflict.claimIds[0]] }),
    ).rejects.toThrow(/already been reviewed/);
  });

  it("rejects reviewing an unknown conflict", async () => {
    const client = new MockTklApiClient();
    await expect(
      client.reviewKnowledgeConflict({ conflictId: "does-not-exist", approvedClaimIds: ["claim:x"] }),
    ).rejects.toThrow(/does not exist/);
  });

  it("persists repository CRUD, validation, enablement, sync, and cancellation", async () => {
    const client = new MockTklApiClient();
    const created = await client.createGitHubRepository({
      repository: "Solera-Engineering/new-dashboard-repo",
      purpose: "application",
    });
    expect(created.validationStatus).toBe("pending");

    await expect(client.testGitHubRepository(created.id)).resolves.toMatchObject({
      validationStatus: "valid",
    });
    await expect(client.updateGitHubRepository(created.id, { enabled: false })).resolves
      .toMatchObject({ enabled: false });
    await client.updateGitHubRepository(created.id, { enabled: true });

    const sync = client.syncGitHubRepository(created.id);
    const rejectedSync = expect(sync).rejects.toThrow(/cancelled/);
    await expect(client.cancelGitHubRepositorySync(created.id)).resolves.toMatchObject({
      syncStatus: "cancelled",
    });
    await rejectedSync;

    await expect(client.deleteGitHubRepository(created.id)).resolves.toMatchObject({
      id: created.id,
    });
    expect(await client.getGitHubRepositories()).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
  });
});
