import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { EvaluationMetrics } from "../contracts/types";
import { mockEvaluationMetrics } from "../mocks/fixtures";
import { EvaluationPage } from "./EvaluationPage";

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
    reviewKnowledgeConflict: () => Promise.reject(new Error("not used in these tests")),
    getEvaluationMetrics: () => Promise.resolve(mockEvaluationMetrics),
    runCoverageContextAgent: () => Promise.reject(new Error("not used in these tests")),
    runTestDesignerAgent: () => Promise.reject(new Error("not used in these tests")),
    runTestRailImprovementAgent: () => Promise.reject(new Error("not used in these tests")),
    runAutomationDesignerAgent: () => Promise.reject(new Error("not used in these tests")),
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

describe("EvaluationPage", () => {
  afterEach(() => {
    setTklApiClientForTests(null);
  });

  it("shows a loading state before data resolves", () => {
    setTklApiClientForTests(
      fakeClient({ getEvaluationMetrics: () => new Promise<EvaluationMetrics>(() => {}) }),
    );

    render(<EvaluationPage />);

    expect(screen.getByText(/loading evaluation metrics…/i)).toBeInTheDocument();
  });

  it("renders evaluation metrics properly from resolved client data", async () => {
    setTklApiClientForTests(
      fakeClient({ getEvaluationMetrics: () => Promise.resolve(mockEvaluationMetrics) }),
    );

    render(<EvaluationPage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Evaluation" })).toBeInTheDocument(),
    );

    expect(screen.getByText("golden-fl-titling-v0")).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByText("71%")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByText("3.5h")).toBeInTheDocument();
    expect(screen.getByText("210.0ms")).toBeInTheDocument();
    expect(screen.getByText("640.0ms")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
  });

  it("renders an error alert when evaluation metrics fail to load", async () => {
    setTklApiClientForTests(
      fakeClient({
        getEvaluationMetrics: () =>
          Promise.reject(new Error("Evaluation service unavailable")),
      }),
    );

    render(<EvaluationPage />);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent(/failed to load evaluation metrics: evaluation service unavailable/i);
    });
  });
});
