import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MockTklApiClient, setTklApiClientForTests } from "../api/client";
import { SourceConnectionsPage } from "./SourceConnectionsPage";

describe("SourceConnectionsPage", () => {
  afterEach(() => setTklApiClientForTests(null));

  it("connects a source, clears the credential, and exposes JIT-only follow-up actions", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "TestRail" });
    const card = heading.closest("article");
    if (!card) throw new Error("TestRail connection card was not rendered");
    fireEvent.change(within(card).getByLabelText("TestRail URL"), {
      target: { value: "https://testrail.example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Account email", { selector: "input" }), {
      target: { value: "qa@example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Project ID"), { target: { value: "12" } });
    const credential = within(card).getByLabelText("Credential", { selector: "input" });
    fireEvent.change(credential, { target: { value: "synthetic-test-token" } });
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    await waitFor(() => {
      const refreshedCard = screen.getByRole("heading", { name: "TestRail" }).closest("article");
      if (!refreshedCard) throw new Error("TestRail connection card was not rendered");
      expect(within(refreshedCard).getByRole("button", { name: "Test connection" })).toBeEnabled();
      expect(within(refreshedCard).queryByRole("button", { name: "Sync now" }))
        .not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("synthetic-test-token")).not.toBeInTheDocument();
  });

  it("does not expose a control that starts a broad source synchronization", async () => {
    const client = new MockTklApiClient();
    const sync = vi.spyOn(client, "syncSourceConnection");
    setTklApiClientForTests(client);

    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Jira" });
    const card = heading.closest("article");
    if (!card) throw new Error("Jira connection card was not rendered");
    expect(within(card).queryByRole("button", { name: /sync now|syncing/i }))
      .not.toBeInTheDocument();
    expect(sync).not.toHaveBeenCalled();
  });

  it("allows cancellation of a legacy active source synchronization", async () => {
    const client = new MockTklApiClient();
    vi.spyOn(client, "getSourceConnections").mockResolvedValue(
      (await client.getSourceConnections()).map((connection) =>
        connection.source === "jira"
          ? { ...connection, status: "syncing" as const }
          : connection
      ),
    );
    setTklApiClientForTests(client);

    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Jira" });
    const card = heading.closest("article");
    if (!card) throw new Error("Jira connection card was not rendered");
    expect(within(card).queryByRole("button", { name: "Syncing…" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Cancel legacy sync" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Disconnect" })).toBeDisabled();
    expect(within(card).getByLabelText("Jira base URL")).toBeDisabled();

  });

  it("cancels only the active sync and refreshes the product status", async () => {
    const client = new MockTklApiClient();
    const baseConnections = await client.getSourceConnections();
    let syncing = true;
    vi.spyOn(client, "getSourceConnections").mockImplementation(() =>
      Promise.resolve(
        baseConnections.map((connection) =>
          connection.source === "jira"
            ? { ...connection, status: syncing ? "syncing" as const : "connected" as const }
            : connection
        ),
      ),
    );
    const cancel = vi.spyOn(client, "cancelSourceConnectionSync").mockImplementation(
      async (source) => {
        syncing = false;
        const connection = baseConnections.find((item) => item.source === source);
        if (!connection) throw new Error("Unknown source");
        return { ...connection, status: "connected", error: null };
      },
    );
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Jira" });
    const card = heading.closest("article");
    if (!card) throw new Error("Jira connection card was not rendered");
    fireEvent.click(within(card).getByRole("button", { name: "Cancel legacy sync" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith("jira"));
    await waitFor(() => {
      const refreshedCard = screen.getByRole("heading", { name: "Jira" }).closest("article");
      if (!refreshedCard) throw new Error("Jira connection card was not rendered");
      expect(within(refreshedCard).queryByRole("button", { name: "Cancel legacy sync" }))
        .not.toBeInTheDocument();
      expect(within(refreshedCard).queryByRole("button", { name: "Sync now" }))
        .not.toBeInTheDocument();
    });
  });

  it("discovers TestRail suites and keeps project-wide knowledge as the default", async () => {
    const client = new MockTklApiClient();
    const save = vi.spyOn(client, "saveSourceConnection");
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "TestRail" });
    const card = heading.closest("article");
    if (!card) throw new Error("TestRail connection card was not rendered");

    fireEvent.change(within(card).getByLabelText("TestRail URL"), {
      target: { value: "https://testrail.example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Account email", { selector: "input" }), {
      target: { value: "qa@example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Project ID"), { target: { value: "12" } });
    fireEvent.change(within(card).getByLabelText("Credential", { selector: "input" }), {
      target: { value: "synthetic-test-token" },
    });

    expect(within(card).getByRole("radio", { name: /All suites/ })).toBeChecked();
    expect(within(card).getByRole("radio", { name: /Selected suites only/ })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "Load suites" }));

    expect(await within(card).findByText("Automation Testing")).toBeInTheDocument();
    expect(within(card).getByRole("radio", { name: /Selected suites only/ })).toBeEnabled();
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls.at(-1)?.[1].config).toMatchObject({
      projectId: "12",
      suiteScope: "all",
    });
    expect(save.mock.calls.at(-1)?.[1].config).not.toHaveProperty("suiteIds");
  });

  it("requires at least one discovered suite for selected TestRail scope", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "TestRail" });
    const card = heading.closest("article");
    if (!card) throw new Error("TestRail connection card was not rendered");

    fireEvent.change(within(card).getByLabelText("TestRail URL"), {
      target: { value: "https://testrail.example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Account email", { selector: "input" }), {
      target: { value: "qa@example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Project ID"), { target: { value: "12" } });
    fireEvent.change(within(card).getByLabelText("Credential", { selector: "input" }), {
      target: { value: "synthetic-test-token" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Load suites" }));
    await within(card).findByText("Automation Testing");
    fireEvent.click(within(card).getByRole("radio", { name: /Selected suites only/ }));
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Select at least one TestRail suite or use All suites.",
    );
    fireEvent.click(within(card).getByRole("checkbox", { name: /Automation Testing/ }));
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));
    await waitFor(() => {
      expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("offers ingestion for every configured source connector", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const confluenceHeading = await screen.findByRole("heading", { name: "Confluence" });
    const card = confluenceHeading.closest("article");
    expect(card).not.toBeNull();
    expect(card).not.toHaveTextContent("Knowledge ingestion is planned");
  });

  it("resolves an exact Confluence root page and defaults to its page tree", async () => {
    const client = new MockTklApiClient();
    const save = vi.spyOn(client, "saveSourceConnection");
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Confluence" });
    const card = heading.closest("article");
    if (!card) throw new Error("Confluence connection card was not rendered");

    const pageUrl = within(card).getByLabelText("Confluence root page URLs");
    expect(pageUrl.closest("label")).toHaveClass("connection-form__field--full");
    fireEvent.change(pageUrl, {
      target: {
        value: "https://wiki.app.solera.com/confluence/display/STT/FL+2.0",
      },
    });
    fireEvent.change(within(card).getByLabelText("Account email", { selector: "input" }), {
      target: { value: "qa@example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Confluence token"), {
      target: { value: "synthetic-confluence-token" },
    });
    expect(
      within(card).getByRole("radio", { name: /Page and all descendants/ }),
    ).toBeChecked();
    fireEvent.click(within(card).getByRole("button", { name: "Load pages" }));
    expect(await within(card).findByText("FL 2.0")).toBeInTheDocument();
    expect(card).toHaveTextContent("Space STT");
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls.at(-1)?.[1].config).toMatchObject({
      baseUrl: "https://wiki.app.solera.com/confluence",
      authMode: "bearer",
      contentScope: "tree",
      spaceKeys: ["STT"],
      rootPageRefs: ["1000:STT"],
      rootPageUrls: [
        "https://wiki.app.solera.com/confluence/display/STT/FL+2.0",
      ],
    });
  });

  it("discards Confluence discovery results after the inputs change", async () => {
    const client = new MockTklApiClient();
    let resolveDiscovery: ((value: {
      baseUrl: string;
      authMode: "basic" | "bearer";
      roots: Array<{ id: string; title: string; spaceKey: string; url: string }>;
    }) => void) | undefined;
    vi.spyOn(client, "discoverConfluencePages").mockImplementation(
      () => new Promise((resolve) => {
        resolveDiscovery = resolve;
      }),
    );
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Confluence" });
    const card = heading.closest("article");
    if (!card) throw new Error("Confluence connection card was not rendered");

    const pageUrl = within(card).getByLabelText("Confluence root page URLs");
    fireEvent.change(pageUrl, {
      target: { value: "https://wiki.example/confluence/display/QA/Old" },
    });
    fireEvent.change(within(card).getByLabelText("Account email", { selector: "input" }), {
      target: { value: "qa@example.com" },
    });
    fireEvent.change(within(card).getByLabelText("Confluence token"), {
      target: { value: "synthetic-confluence-token" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Load pages" }));
    expect(within(card).getByRole("button", { name: "Loading pages…" })).toBeDisabled();

    fireEvent.change(pageUrl, {
      target: { value: "https://wiki.example/confluence/display/QA/New" },
    });
    resolveDiscovery?.({
      baseUrl: "https://wiki.example/confluence",
      authMode: "bearer",
      roots: [{
        id: "10",
        title: "Old",
        spaceKey: "QA",
        url: "https://wiki.example/confluence/display/QA/Old",
      }],
    });

    await waitFor(() => {
      expect(within(card).queryByText("Old")).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Load pages" })).toBeEnabled();
    });
  });

  it("explains Jira credentials and rejects incomplete Solera configuration", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Jira" });
    const card = heading.closest("article");
    if (!card) throw new Error("Jira connection card was not rendered");

    fireEvent.change(within(card).getByLabelText("Jira base URL"), {
      target: { value: "https://jira.app.solera.com/" },
    });
    fireEvent.change(within(card).getByLabelText("Jira project key"), {
      target: { value: "STT" },
    });
    fireEvent.change(within(card).getByLabelText("JQL filter"), {
      target: { value: "STT" },
    });
    fireEvent.change(within(card).getByLabelText("New Jira personal access token (PAT) (required to rotate)"), {
      target: { value: "synthetic-jira-token" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Use https://jira.app.solera.com/jira as the Jira base URL.",
    );
    expect(card).toHaveTextContent("TKL sends it to Jira as a Bearer token");

    fireEvent.change(within(card).getByLabelText("Jira base URL"), {
      target: { value: "https://jira.app.solera.com/jira" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      '"STT" is a project key, not a JQL filter.',
    );
  });

  it("normalizes a GitHub repository URL and keeps one shared secret editor", async () => {
    const client = new MockTklApiClient();
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const card = heading.closest("article");
    if (!card) throw new Error("GitHub connection card was not rendered");

    const repository = within(card).getByLabelText("Repository URL");
    fireEvent.change(repository, {
      target: {
        value: "https://github.com/Solera-Engineering/qa-titletec-fl-automation-pw.git",
      },
    });
    fireEvent.blur(repository);

    expect(repository).toHaveValue(
      "https://github.com/Solera-Engineering/qa-titletec-fl-automation-pw",
    );
    expect(card).toHaveTextContent("TKL derives the API configuration automatically.");
    expect(card).toHaveTextContent("Shared GitHub PAT configured · secret hidden");
    expect(within(card).getAllByLabelText(/GitHub personal access token/)).toHaveLength(1);
    expect(within(card).getByLabelText(/GitHub personal access token/)).toHaveAttribute(
      "type",
      "password",
    );
    expect(within(card).queryByRole("button", { name: /show secret/i })).not.toBeInTheDocument();
  });

  it("derives the ReportPortal base URL and project identifier from a dashboard URL", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "ReportPortal" });
    const card = heading.closest("article");
    if (!card) throw new Error("ReportPortal connection card was not rendered");

    const url = within(card).getByLabelText("ReportPortal URL");
    fireEvent.change(url, {
      target: {
        value: "http://pusngipraprpa01.axadmin.net:8080/ui/#vehiclesolutions/dashboard/1543",
      },
    });
    fireEvent.blur(url);

    expect(url).toHaveValue("http://pusngipraprpa01.axadmin.net:8080");
    expect(within(card).getByLabelText("Project identifier")).toHaveValue("vehiclesolutions");
    expect(within(card).getByLabelText("Project identifier").closest("label")).toHaveClass(
      "connection-form__field--full",
    );
  });

  it("explains a private GitHub repository 404 as a possible token access problem", async () => {
    const client = new MockTklApiClient();
    const connections = await client.getSourceConnections();
    vi.spyOn(client, "getSourceConnections").mockResolvedValue(
      connections.map((connection) => connection.source === "github"
        ? {
            ...connection,
            repositories: connection.repositories?.map((repository) => ({
              ...repository,
              syncStatus: repository.syncStatus === "syncing" ? "idle" as const : repository.syncStatus,
            })),
          }
        : connection),
    );
    vi.spyOn(client, "saveSourceConnection").mockRejectedValue(
      new Error("The source validation request failed with status 404."),
    );
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const card = heading.closest("article");
    if (!card) throw new Error("GitHub connection card was not rendered");

    fireEvent.change(within(card).getByLabelText(/GitHub personal access token/), {
      target: { value: "synthetic-github-token" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Reconnect \/ rotate|Connect/ }));

    await waitFor(() => expect(
      within(card).getAllByRole("alert").some((alert) =>
        alert.textContent?.includes(
          "Verify the repository URL, token repository access, and organization SSO or approval.",
        ),
      ),
    ).toBe(true));
  });

  it("adds, edits, tests, enables, disables, and removes repositories without broad sync", async () => {
    const client = new MockTklApiClient();
    const create = vi.spyOn(client, "createGitHubRepository");
    const update = vi.spyOn(client, "updateGitHubRepository");
    const test = vi.spyOn(client, "testGitHubRepository");
    const remove = vi.spyOn(client, "deleteGitHubRepository");
    setTklApiClientForTests(client);
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const card = heading.closest("article");
    if (!card) throw new Error("GitHub connection card was not rendered");
    const url = within(card).getByLabelText("Repository URL");
    fireEvent.change(url, {
      target: { value: "https://github.com/Solera-Engineering/dashboard-new.git" },
    });
    fireEvent.blur(url);
    fireEvent.change(within(card).getByLabelText("Repository purpose"), {
      target: { value: "application" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      repository: "Solera-Engineering/dashboard-new",
      url: "https://github.com/Solera-Engineering/dashboard-new",
      purpose: "application",
      lifecycle: "active",
      enabled: true,
    }));
    const repositoryHeading = await within(card).findByRole("heading", {
      name: "Solera-Engineering/dashboard-new",
    });
    let repositoryCard = repositoryHeading.closest("article");
    if (!repositoryCard) throw new Error("Repository card was not rendered");

    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(card).getByLabelText("Repository lifecycle"), {
      target: { value: "maintenance" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ lifecycle: "maintenance" }),
    ));

    repositoryCard = (await within(card).findByRole("heading", {
      name: "Solera-Engineering/dashboard-new",
    })).closest("article");
    if (!repositoryCard) throw new Error("Repository card was not rendered");
    await waitFor(() => expect(within(repositoryCard!).getByRole("button", { name: "Test" }))
      .toBeEnabled());
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(test).toHaveBeenCalled());

    repositoryCard = (await within(card).findByRole("heading", {
      name: "Solera-Engineering/dashboard-new",
    })).closest("article");
    if (!repositoryCard) throw new Error("Repository card was not rendered");
    await waitFor(() => expect(within(repositoryCard!).getByRole("button", { name: "Disable" }))
      .toBeEnabled());
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(
      expect.any(String),
      { enabled: false },
    ));
    await waitFor(() => expect(within(repositoryCard!).getByRole("button", { name: "Enable" }))
      .toBeEnabled());
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Enable" }));

    expect(within(repositoryCard).queryByRole("button", { name: "Sync" }))
      .not.toBeInTheDocument();

    await waitFor(() => expect(within(repositoryCard!).getByRole("button", { name: "Remove" }))
      .toBeEnabled());
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    await waitFor(() => expect(within(card).queryByRole("heading", {
      name: "Solera-Engineering/dashboard-new",
    })).not.toBeInTheDocument());
  });

  it("provides GitHub token creation and SSO guidance without exposing a secret", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const card = heading.closest("article");
    if (!card) throw new Error("GitHub connection card was not rendered");

    expect(
      within(card).getByText("How to create and authorize the GitHub token"),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Configure SSO/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Open GitHub token settings/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/tokens",
    );
    expect(within(card).queryByRole("button", { name: /show secret/i })).not.toBeInTheDocument();
  });

  it("explains how to identify the Jira project and validate a scoped JQL", async () => {
    setTklApiClientForTests(new MockTklApiClient());
    render(<SourceConnectionsPage />);

    const heading = await screen.findByRole("heading", { name: "Jira" });
    const card = heading.closest("article");
    if (!card) throw new Error("Jira connection card was not rendered");

    expect(within(card).getByText("How to configure the Jira scope")).toBeInTheDocument();
    expect(within(card).getByText(/the project key for/)).toHaveTextContent("ABC-123");
    expect(within(card).getByText(/can validate a connection/)).toHaveTextContent(
      "includes the entire project",
    );
    expect(within(card).getByRole("link", { name: /Open the Jira JQL guide/ })).toHaveAttribute(
      "href",
      "https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/",
    );
  });
});
