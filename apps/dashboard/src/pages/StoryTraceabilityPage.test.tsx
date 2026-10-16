import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { StoryTraceability } from "../contracts/types";
import { mockStoryTraceability } from "../mocks/fixtures";
import { StoryTraceabilityPage } from "./StoryTraceabilityPage";

function fakeClient(overrides: Partial<TklApiClient>): TklApiClient {
  return {
    resolveArtifacts: () => Promise.reject(new Error("not used in these tests")),
    askTkl: () => Promise.reject(new Error("not used in these tests")),
    getConnectorHealth: () => Promise.resolve([]),
    getTicketContextOperations: () => Promise.reject(new Error("not used in these tests")),
    getStoryTraceability: () => Promise.resolve([]),
    getTicketContextJob: () => Promise.resolve(null),
    refreshTicketContext: () => Promise.reject(new Error("not used in these tests")),
    cancelTicketContext: () => Promise.reject(new Error("not used in these tests")),
    getCoverageGaps: () => Promise.resolve([]),
    getKnowledgeInventory: () => Promise.reject(new Error("not used in these tests")),
    getKnowledgeConflicts: () => Promise.resolve([]),
    reviewKnowledgeConflict: () => Promise.reject(new Error("not used in these tests")),
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

describe("StoryTraceabilityPage", () => {
  afterEach(() => {
    setTklApiClientForTests(null);
  });

  it("shows a loading state before data resolves", () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => new Promise<StoryTraceability[]>(() => {}) }),
    );

    render(<StoryTraceabilityPage />);

    expect(screen.getByText(/loading story traceability/i)).toBeInTheDocument();
  });

  it("labels manual and automated tests distinctly", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getByText("STT-1001 — Support partial VIN entry during title intake")).toBeInTheDocument());
    expect(screen.getAllByText("Automated").length).toBeGreaterThan(0);
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });

  it("shows a factual execution freshness label for an executed test", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getAllByText(/executed \d+d ago/i).length).toBeGreaterThan(0));
  });

  it("shows 'Not yet executed' for a test with no execution timestamp", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getByText("Not yet executed")).toBeInTheDocument());
  });

  it("shows unknown when execution and review evidence are unavailable", async () => {
    const story = structuredClone(mockStoryTraceability[0]);
    story.tests[0].lastExecutedAt = undefined;
    story.links[0].reviewed = null;
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve([story]) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getAllByText("Unknown")).toHaveLength(2));
  });

  it("shows provenance source and version for linked tests", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getAllByText("GitHub (vpr-42-sha-a1b2c3)").length).toBeGreaterThan(0));
    expect(screen.getByText("TestRail (vrun-204)")).toBeInTheDocument();
  });

  it("falls back to the requirement's own provenance when there is no linked test", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() =>
      expect(screen.getByText("STT-1042 — Reject duplicate title applications for the same VIN")).toBeInTheDocument(),
    );
    expect(screen.getByText("No linked test")).toBeInTheDocument();
    expect(screen.getByText("Jira (vSTT-1042-v1)")).toBeInTheDocument();
  });

  it("shows confidence and reviewed columns for each link", async () => {
    setTklApiClientForTests(
      fakeClient({ getStoryTraceability: () => Promise.resolve(mockStoryTraceability) }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getAllByText("Explicit").length).toBeGreaterThan(0));
    expect(screen.getByText("Inferred (high)")).toBeInTheDocument();
    expect(screen.getAllByText("Yes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No").length).toBeGreaterThan(0);
  });

  it("shows an alert with the error message when the client rejects", async () => {
    setTklApiClientForTests(
      fakeClient({
        getStoryTraceability: () => Promise.reject(new Error("traceability unavailable")),
      }),
    );

    render(<StoryTraceabilityPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("traceability unavailable");
  });

  it("shows a non-fatal refresh option when an exact Jira search has no context job", async () => {
    const getTicketContextJob = vi.fn(async () => null);
    setTklApiClientForTests(fakeClient({ getTicketContextJob }));
    render(<StoryTraceabilityPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /search/i })).toBeEnabled());

    fireEvent.change(screen.getByRole("searchbox", { name: /find a jira ticket/i }), {
      target: { value: "STT-404" },
    });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    await waitFor(() => expect(getTicketContextJob).toHaveBeenCalledWith("STT-404"));
    expect(screen.getByText(/no enrichment job exists yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load traceability/i)).not.toBeInTheDocument();
  });
});
