import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MockTklApiClient, setTklApiClientForTests } from "../api/client";
import type { ArtifactResolution } from "../contracts/types";
import { UnifiedIntelligencePage } from "./UnifiedIntelligencePage";

afterEach(() => setTklApiClientForTests(null));

describe("UnifiedIntelligencePage", () => {
  it("shows candidates and requires an explicit choice when ambiguous", async () => {
    const resolution: ArtifactResolution = {
      productId: "fl-titling",
      query: "verify title",
      detected: {
        kind: "text",
        source: null,
        lookupValue: "verify title",
        exact: false,
      },
      status: "ambiguous",
      selected: null,
      candidates: [
        {
          ref: { source: "testrail", type: "test-case", externalId: "1201" },
          canonicalId: "manual-test:testrail:1201",
          title: "Verify title submission",
          match: "partial-title",
          confidence: 0.7,
          observedAt: "2026-09-15T12:00:00.000Z",
          sourceUrl: null,
        },
        {
          ref: { source: "github", type: "automated-test", externalId: "title.spec.ts" },
          canonicalId: "test:github:title",
          title: "Verify title submission error",
          match: "partial-title",
          confidence: 0.7,
          observedAt: null,
          sourceUrl: null,
        },
      ],
    };
    const client = new MockTklApiClient();
    vi.spyOn(client, "resolveArtifacts").mockResolvedValue(resolution);
    const improve = vi.spyOn(client, "runTestRailCaseImprovementAgent")
      .mockResolvedValue({
        runId: "case-run",
        agent: { id: "agent.testrail-improvement", version: "0.1.0" },
        productId: "fl-titling",
        workItemId: "C1201",
        caseId: "1201",
        generatedAt: "2026-09-15T12:00:00.000Z",
        status: "ready-for-review",
        confidence: { level: "medium", rationale: "Exact case evidence." },
        summary: "One exact TestRail case inspected.",
        proposals: [],
        evidence: {
          sources: ["testrail"],
          requirements: [],
          manualTests: [],
          relationships: [],
          candidateRelationships: [{
            id: "candidate:1201:1202",
            fromEntityId: "manual-test:testrail:1201",
            toEntityId: "manual-test:testrail:1202",
            type: "similar_to",
            origin: "inferred",
            confidence: 0.72,
            status: "review-required",
            rationale: "Bounded title and step-token similarity.",
          }],
          sourceStatus: {
            testrail: {
              state: "complete",
              connected: true,
              hydrated: true,
              linked: true,
              recordsCollected: 10,
              truncated: false,
              detail: "The bounded query collected 10 record(s).",
            },
            jira: {
              state: "not-linked",
              connected: true,
              hydrated: false,
              linked: false,
              recordsCollected: 0,
              truncated: false,
              detail: "No explicit Jira reference was available from the anchor.",
            },
          },
          citations: [],
        },
        limitations: [],
      });
    setTklApiClientForTests(client);

    render(
      <MemoryRouter>
        <UnifiedIntelligencePage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Find a quality artifact"), {
      target: { value: "verify title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Choose the artifact you meant")).toBeInTheDocument();
    expect(screen.queryByText("Investigation anchor")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: /TestRail Verify title submission C1201/,
    }));
    expect(await screen.findByText("Investigation anchor")).toBeInTheDocument();
    expect(screen.getByText("C1201 · test case")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("tabpanel", { name: "Evidence" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.getByRole("tabpanel", { name: "Actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Improve test case" }));
    expect(await screen.findByText("One exact TestRail case inspected."))
      .toBeInTheDocument();
    expect(screen.getByText("Evidence retrieved for this case")).toBeInTheDocument();
    expect(screen.getByText("No explicit Jira reference was available from the anchor."))
      .toBeInTheDocument();
    expect(screen.getByText(/1 similar case candidate.*need review/i)).toBeInTheDocument();
    expect(improve).toHaveBeenCalledWith("1201");
  });

  it("shows an actionable empty state", async () => {
    const client = new MockTklApiClient();
    setTklApiClientForTests(client);
    render(
      <MemoryRouter>
        <UnifiedIntelligencePage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Find a quality artifact"), {
      target: { value: "C9999" },
    });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() =>
      expect(screen.getByText(/No local artifact matched/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/retrieved on demand/)).toBeInTheDocument();
  });
});
