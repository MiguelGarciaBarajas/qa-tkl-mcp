import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { ConflictReviewRequest, KnowledgeConflict } from "../contracts/types";
import { ConflictsPage } from "./ConflictsPage";

function fakeClient(overrides: Partial<TklApiClient>): TklApiClient {
  return {
    resolveArtifacts: () => Promise.reject(new Error("not used in these tests")),
    getTicketContextJob: () => Promise.resolve(null),
    refreshTicketContext: () => Promise.reject(new Error("not used in these tests")),
    cancelTicketContext: () => Promise.reject(new Error("not used in these tests")),
    askTkl: () => Promise.reject(new Error("not used in these tests")),
    getConnectorHealth: () => Promise.resolve([]),
    getTicketContextOperations: () => Promise.reject(new Error("not used in these tests")),
    getStoryTraceability: () => Promise.resolve([]),
    getCoverageGaps: () => Promise.resolve([]),
    getKnowledgeInventory: () => Promise.reject(new Error("not used in these tests")),
    getKnowledgeConflicts: () => Promise.resolve([]),
    reviewKnowledgeConflict: () =>
      Promise.reject(new Error("not used in these tests")),
    getEvaluationMetrics: () =>
      Promise.reject(new Error("not used in these tests")),
    runCoverageContextAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runTestDesignerAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runTestRailImprovementAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runAutomationDesignerAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runReliabilityDefectIntelligenceAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runKnowledgeCuratorAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    getSourceConnections: () => Promise.resolve([]),
    getGitHubRepositories: () => Promise.resolve([]),
    getGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    createGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    updateGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    deleteGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    testGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    syncGitHubRepository: () => Promise.reject(new Error("not used in these tests")),
    cancelGitHubRepositorySync: () => Promise.reject(new Error("not used in these tests")),
    discoverTestRailSuites: () => Promise.resolve([]),
    discoverConfluencePages: () => Promise.resolve({ baseUrl: "", authMode: "bearer", roots: [] }),
    saveSourceConnection: () => Promise.reject(new Error("not used in these tests")),
    testSourceConnection: () => Promise.reject(new Error("not used in these tests")),
    syncSourceConnection: () => Promise.reject(new Error("not used in these tests")),
    cancelSourceConnectionSync: () => Promise.reject(new Error("not used in these tests")),
    disconnectSourceConnection: () => Promise.reject(new Error("not used in these tests")),
    ...overrides,
  };
}

const openConflict: KnowledgeConflict = {
  id: "CONF-1",
  entityId: "REQ-2",
  entityTitle: "Minimum VIN length for submission",
  description: "Conflicting claims detected.",
  detectedAt: "2026-09-05T00:00:00Z",
  status: "open",
  claimIds: ["claim:jira:REQ-2@v1", "claim:github:REQ-2-test@v1"],
};

describe("ConflictsPage", () => {
  afterEach(() => {
    setTklApiClientForTests(null);
  });

  it("shows a loading state before data resolves", () => {
    setTklApiClientForTests(
      fakeClient({ getKnowledgeConflicts: () => new Promise<KnowledgeConflict[]>(() => {}) }),
    );

    render(<ConflictsPage />);

    expect(screen.getByText(/loading knowledge conflicts/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no conflicts", async () => {
    setTklApiClientForTests(fakeClient({ getKnowledgeConflicts: () => Promise.resolve([]) }));

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByText(/no open conflicts/i)).toBeInTheDocument());
  });

  it("shows an alert with the error message when the client rejects", async () => {
    setTklApiClientForTests(
      fakeClient({ getKnowledgeConflicts: () => Promise.reject(new Error("network unavailable")) }),
    );

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("network unavailable");
  });

  it("lists an open conflict's claims for review and hides checkboxes for a reviewed conflict", async () => {
    setTklApiClientForTests(
      fakeClient({
        getKnowledgeConflicts: () =>
          Promise.resolve([
            openConflict,
            { ...openConflict, id: "CONF-2", status: "reviewed" },
          ]),
      }),
    );

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByText("claim:jira:REQ-2@v1")).toBeInTheDocument());
    expect(screen.getAllByText("Open")).toHaveLength(1);
    expect(screen.getAllByText("Reviewed")).toHaveLength(1);
    // Only the open conflict renders a checkbox/review UI (2 claim checkboxes).
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("requires at least one approved claim before submitting", async () => {
    setTklApiClientForTests(fakeClient({ getKnowledgeConflicts: () => Promise.resolve([openConflict]) }));

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByText("Submit review")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Submit review"));

    expect(
      await screen.findByText(/select at least one claim to approve/i),
    ).toBeInTheDocument();
  });

  it("submits a review with the selected claim(s) and note, then reflects the reviewed status", async () => {
    let received: ConflictReviewRequest | undefined;
    setTklApiClientForTests(
      fakeClient({
        getKnowledgeConflicts: () => Promise.resolve([openConflict]),
        reviewKnowledgeConflict: (request) => {
          received = request;
          return Promise.resolve({ ...openConflict, status: "reviewed" });
        },
      }),
    );

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByText("claim:jira:REQ-2@v1")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("claim:jira:REQ-2@v1"));
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "Confirmed with product owner." },
    });
    fireEvent.click(screen.getByText("Submit review"));

    await waitFor(() => expect(screen.getByText("Reviewed")).toBeInTheDocument());
    expect(received).toEqual({
      conflictId: "CONF-1",
      approvedClaimIds: ["claim:jira:REQ-2@v1"],
      note: "Confirmed with product owner.",
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows an error and keeps the conflict open when the review request fails", async () => {
    setTklApiClientForTests(
      fakeClient({
        getKnowledgeConflicts: () => Promise.resolve([openConflict]),
        reviewKnowledgeConflict: () =>
          Promise.reject(new Error("Conflict CONF-1 has already been reviewed.")),
      }),
    );

    render(<ConflictsPage />);

    await waitFor(() => expect(screen.getByText("claim:jira:REQ-2@v1")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("claim:jira:REQ-2@v1"));
    fireEvent.click(screen.getByText("Submit review"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Conflict CONF-1 has already been reviewed.",
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});
