import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { ConnectorHealth } from "../contracts/types";
import {
  mockConnectorHealth,
  mockEmptyConnectorHealth,
  mockSourceConnections,
  mockTicketContextOperations,
} from "../mocks/fixtures";
import { ConnectorHealthPage } from "./ConnectorHealthPage";

function fakeClient(overrides: Partial<TklApiClient>): TklApiClient {
  return {
    resolveArtifacts: () => Promise.reject(new Error("not used in these tests")),
    getTicketContextJob: () => Promise.resolve(null),
    refreshTicketContext: () => Promise.reject(new Error("not used in these tests")),
    cancelTicketContext: () => Promise.reject(new Error("not used in these tests")),
    askTkl: () => Promise.reject(new Error("not used in these tests")),
    getConnectorHealth: () => Promise.resolve([]),
    getTicketContextOperations: () => Promise.resolve(mockTicketContextOperations),
    getStoryTraceability: () => Promise.resolve([]),
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

describe("ConnectorHealthPage", () => {
  afterEach(() => {
    setTklApiClientForTests(null);
  });

  it("shows a loading state before data resolves", () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => new Promise<ConnectorHealth[]>(() => {}),
        getTicketContextOperations: () => new Promise(() => {}),
      }),
    );

    render(<ConnectorHealthPage />);

    expect(screen.getByText(/loading connector health/i)).toBeInTheDocument();
  });

  it("shows an explicit empty state when no connectors are configured", async () => {
    setTklApiClientForTests(
      fakeClient({ getConnectorHealth: () => Promise.resolve(mockEmptyConnectorHealth) }),
    );

    render(<ConnectorHealthPage />);

    await waitFor(() =>
      expect(screen.getByText(/no source connectors are configured yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "JIT Context" })).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("keeps connector health visible when only JIT context status fails", async () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.resolve(mockConnectorHealth),
        getTicketContextOperations: () => Promise.reject(new Error("operations offline")),
      }),
    );

    render(<ConnectorHealthPage />);

    expect(await screen.findByText("jira-fl-titling")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("JIT context status is unavailable");
    expect(screen.getByRole("alert")).not.toHaveTextContent("operations offline");
    expect(screen.getByRole("columnheader", { name: "Connector" })).toBeInTheDocument();
  });

  it("keeps JIT context status visible when connector health fails", async () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.reject(new Error("connectors offline")),
      }),
    );

    render(<ConnectorHealthPage />);

    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JIT Context" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("connectors offline");
  });

  it("surfaces a pending-configuration connector with a distinct status and summary note", async () => {
    setTklApiClientForTests(
      fakeClient({ getConnectorHealth: () => Promise.resolve(mockConnectorHealth) }),
    );

    render(<ConnectorHealthPage />);

    await waitFor(() =>
      expect(screen.getByText("testrail-fl-titling")).toBeInTheDocument(),
    );
    expect(screen.getByText("Pending configuration")).toBeInTheDocument();
    expect(screen.getByText(/1 connector awaiting configuration/i)).toBeInTheDocument();
    expect(
      screen.getByText(/TestRail URL, project ID, and credential reference/i),
    ).toBeInTheDocument();
  });

  it("shows a dynamically connected source even when runtime health has no connector entry", async () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.resolve([]),
        getSourceConnections: () =>
          Promise.resolve(
            mockSourceConnections
              .filter((connection) => connection.source === "jira")
              .map((connection) => ({
                ...connection,
                lastSyncAt: null,
                lastSuccessfulSyncAt: null,
              })),
          ),
      }),
    );

    render(<ConnectorHealthPage />);

    await waitFor(() => expect(screen.getByText("Jira")).toBeInTheDocument());
    const jiraRow = screen.getByText("Jira").closest("tr");
    if (!jiraRow) throw new Error("Jira connector row was not rendered");
    expect(within(jiraRow).getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Connected successfully; synchronization has not run yet.")).toBeInTheDocument();
    expect(screen.queryByText(/no source connectors are configured yet/i)).not.toBeInTheDocument();
  });

  it("shows active synchronization with a spinner and start time instead of degraded", async () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.resolve([]),
        getSourceConnections: () =>
          Promise.resolve(
            mockSourceConnections
              .filter((connection) => connection.source === "jira")
              .map((connection) => ({
                ...connection,
                status: "syncing" as const,
                lastSyncAt: new Date(Date.now() - 2 * 60_000).toISOString(),
                lastSuccessfulSyncAt: null,
              })),
          ),
      }),
    );

    const { container } = render(<ConnectorHealthPage />);

    await waitFor(() => expect(screen.getByText("Syncing")).toBeInTheDocument());
    const syncingRow = screen.getByText("Syncing").closest("tr");
    if (!syncingRow) throw new Error("Syncing connector row was not rendered");
    expect(within(syncingRow).queryByText("Degraded")).not.toBeInTheDocument();
    expect(screen.getByText(/Started 2 minutes ago/i)).toBeInTheDocument();
    expect(screen.getByText("Synchronization is currently in progress.")).toBeInTheDocument();
    expect(container.querySelector(".badge svg.spin")).toBeInTheDocument();
  });

  it("renders nested GitHub repository health with independent mixed states", async () => {
    const github = mockSourceConnections.find((connection) => connection.source === "github");
    if (!github?.repositories) throw new Error("GitHub repository fixtures are missing");
    const repositories = github.repositories.map((repository) =>
      repository.id === "legacy-title-docs"
        ? {
            ...repository,
            error: {
              ...repository.error!,
              message:
                "Provider rejected https://github.example/repo?access_token=secret-value",
            },
          }
        : repository
    );
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.resolve(
          mockConnectorHealth.filter((connector) => connector.source === "github"),
        ),
        getSourceConnections: () => Promise.resolve([{ ...github, repositories }]),
      }),
    );

    render(<ConnectorHealthPage />);

    const automation = await screen.findByText(
      "Solera-Engineering/qa-titletec-fl-automation-pw",
    );
    const automationRow = automation.closest("tr");
    if (!automationRow) throw new Error("Automation repository row was not rendered");
    expect(within(automationRow).getByText("Healthy")).toBeInTheDocument();
    expect(automationRow).toHaveTextContent("418");
    expect(automationRow).toHaveTextContent("Successful:");

    const syncingRow = screen.getByText("Solera-Engineering/titletec-fl").closest("tr");
    expect(syncingRow).toHaveTextContent("Syncing");
    const disabledRow = screen.getByText("Solera-Engineering/tkl-quality-evidence").closest("tr");
    expect(disabledRow).toHaveTextContent("Disabled");
    const failingRow = screen.getByText("Solera-Engineering/legacy-title-docs").closest("tr");
    expect(failingRow).toHaveTextContent("Failing");
    expect(failingRow).toHaveTextContent("access_token=[redacted]");
    expect(failingRow).not.toHaveTextContent("secret-value");
  });

  it("shows an alert with the error message when the client rejects", async () => {
    setTklApiClientForTests(
      fakeClient({
        getConnectorHealth: () => Promise.reject(new Error("network unavailable")),
      }),
    );

    render(<ConnectorHealthPage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("network unavailable");
  });
});
