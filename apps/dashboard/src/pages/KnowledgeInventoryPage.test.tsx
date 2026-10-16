import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { KnowledgeInventory } from "../contracts/types";
import { mockKnowledgeInventory } from "../mocks/fixtures";
import { KnowledgeInventoryPage } from "./KnowledgeInventoryPage";

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
    getKnowledgeInventory: () => Promise.resolve(mockKnowledgeInventory),
    getKnowledgeConflicts: () => Promise.resolve([]),
    reviewKnowledgeConflict: () => Promise.reject(new Error("not used in these tests")),
    getEvaluationMetrics: () => Promise.reject(new Error("not used in these tests")),
    runCoverageContextAgent: () => Promise.reject(new Error("not used in these tests")),
    runTestDesignerAgent: () => Promise.reject(new Error("not used in these tests")),
    runTestRailImprovementAgent: () => Promise.reject(new Error("not used in these tests")),
    runAutomationDesignerAgent: () => Promise.reject(new Error("not used in these tests")),
    runReliabilityDefectIntelligenceAgent: () =>
      Promise.reject(new Error("not used in these tests")),
    runKnowledgeCuratorAgent: () => Promise.reject(new Error("not used in these tests")),
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

describe("KnowledgeInventoryPage", () => {
  afterEach(() => {
    setTklApiClientForTests(null);
  });

  it("shows a loading state before data resolves", () => {
    setTklApiClientForTests(
      fakeClient({ getKnowledgeInventory: () => new Promise<KnowledgeInventory>(() => {}) }),
    );

    render(<KnowledgeInventoryPage />);

    expect(screen.getByText(/loading knowledge inventory/i)).toBeInTheDocument();
  });

  it("shows an alert with the error message when the client rejects", async () => {
    setTklApiClientForTests(
      fakeClient({
        getKnowledgeInventory: () => Promise.reject(new Error("inventory backend offline")),
      }),
    );

    render(<KnowledgeInventoryPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("inventory backend offline");
  });

  it("renders the key sections and headline metrics for a populated inventory", async () => {
    setTklApiClientForTests(fakeClient({}));

    render(<KnowledgeInventoryPage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Knowledge Inventory" })).toBeInTheDocument(),
    );

    expect(screen.getByText("Source Inventory (Bronze)")).toBeInTheDocument();
    expect(screen.getByText("Canonical Knowledge (Silver)")).toBeInTheDocument();
    expect(screen.getByText("Coverage & Mapping")).toBeInTheDocument();
    expect(screen.getByText("Actionable Gaps")).toBeInTheDocument();
    expect(screen.getByText("Pipeline Status")).toBeInTheDocument();
    expect(screen.getByText("Notes & limitations")).toBeInTheDocument();

    // Headline metric labels
    expect(screen.getByText("Retained evidence (Bronze)")).toBeInTheDocument();
    expect(screen.getByText("Mapped coverage")).toBeInTheDocument();

    // An actionable gap and its severity badge are rendered
    expect(screen.getByText("Requirements with no mapped tests")).toBeInTheDocument();
    expect(screen.getAllByText("high").length).toBeGreaterThan(0);
  });

  it("renders an empty state when no inventory is returned", async () => {
    setTklApiClientForTests(
      fakeClient({
        getKnowledgeInventory: () => Promise.resolve(null as unknown as KnowledgeInventory),
      }),
    );

    render(<KnowledgeInventoryPage />);

    await waitFor(() =>
      expect(screen.getByText(/no knowledge inventory is available yet/i)).toBeInTheDocument(),
    );
  });

  it("flags a partial inventory and marks unavailable tiers instead of showing fake zeros", async () => {
    const partial: KnowledgeInventory = {
      ...mockKnowledgeInventory,
      collectedEvidence: {
        available: false,
        totalRetainedRecords: null,
        bySource: [],
        pendingProjection: { total: null, attributable: false },
        deadLetter: { total: null, bySource: [] },
      },
      meta: {
        ...mockKnowledgeInventory.meta,
        partial: true,
        notes: ["Raw evidence store is not configured; Bronze inventory is unavailable."],
      },
    };
    setTklApiClientForTests(fakeClient({ getKnowledgeInventory: () => Promise.resolve(partial) }));

    render(<KnowledgeInventoryPage />);

    await waitFor(() =>
      expect(
        screen.getByText(/collected-evidence inventory is unavailable/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/some tiers are unavailable/i)).toBeInTheDocument();
  });
});
