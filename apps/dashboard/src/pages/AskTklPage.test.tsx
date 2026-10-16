import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { AskTklRun } from "../contracts/types";
import { AskTklPage } from "./AskTklPage";

const answer: AskTklRun = {
  runId: "ask-run-1",
  agent: { id: "agent.ask-tkl", version: "0.1.0", mode: "read-only" },
  productId: "fl-titling",
  question: "What covers STT-3731?",
  workItemId: "STT-3731",
  generatedAt: "2026-09-14T12:00:00.000Z",
  intent: { primary: "coverage-context", matched: ["coverage-context"] },
  scope: {
    productId: "fl-titling",
    workItemId: "STT-3731",
    interpretation: "coverage context over the exact STT-3731 Jira hierarchy",
  },
  status: "insufficient-context",
  answer: "One requirement remains unverified. [S1]",
  citations: [{
    id: "S1",
    source: "jira",
    sourceId: "STT-3731",
    sourceVersion: "7",
    observedAt: "2026-09-13T12:00:00.000Z",
    resourceUri: "tkl://products/fl-titling/sources/jira/STT-3731/provenance",
    href: "https://tkl-api.example.com/v1/resources/read?productId=fl-titling",
  }],
  freshness: {
    status: "current",
    asOf: "2026-09-14T12:00:00.000Z",
    newestObservedAt: "2026-09-13T12:00:00.000Z",
    oldestObservedAt: "2026-09-13T12:00:00.000Z",
    staleCitationCount: 0,
    thresholdDays: 30,
  },
  confidence: { level: "medium", rationale: "Jira is current but test evidence is incomplete." },
  conflicts: [{
    id: "conflict:1",
    entityId: "requirement:STT-3731",
    reason: "Jira and Confluence disagree.",
  }],
  limitations: ["No ReportPortal evidence is present."],
  nextActions: ["Synchronize ReportPortal."],
  toolCalls: [{
    capability: "agent.coverage-context",
    status: "insufficient-context",
    summary: "Coverage checked.",
  }],
  evidenceMode: "combined",
  investigation: {
    required: true,
    status: "completed",
    stopReason: null,
    steps: ["Inspect linked repository evidence."],
    scope: { workItemId: "STT-3731" },
  },
  claims: [{
    type: "fact",
    text: "Title application",
    evidence: "requirement:STT-3731",
  }],
};

describe("AskTklPage", () => {
  afterEach(() => setTklApiClientForTests(null));

  it("renders a chat-like cited answer with freshness, conflicts, and limitations", async () => {
    const askTkl = vi.fn(async () => answer);
    setTklApiClientForTests({ askTkl } as unknown as TklApiClient);
    render(<AskTklPage />);

    fireEvent.change(screen.getByRole("textbox", { name: /Ask TKL question/i }), {
      target: { value: "What covers STT-3731?" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Optional Jira key/i }), {
      target: { value: "STT-3731" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Ask TKL$/i }));

    await waitFor(() =>
      expect(screen.getByText(/One requirement remains unverified/)).toBeInTheDocument(),
    );
    expect(askTkl).toHaveBeenCalledWith({
      question: "What covers STT-3731?",
      workItemId: "STT-3731",
    });
    expect(screen.getByText(/newest/)).toBeInTheDocument();
    expect(screen.getByText(/Jira and Confluence disagree/)).toBeInTheDocument();
    expect(screen.getByText(/No ReportPortal evidence/)).toBeInTheDocument();
    expect(screen.getByText(/Evidence mode/i)).toBeInTheDocument();
    expect(screen.getByText(/Investigation plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Claim classification/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\[S1\] jira:STT-3731/i }))
      .toHaveAttribute("href", answer.citations[0].href);
  });

  it("shows explicit abstention without inventing citations", async () => {
    const abstained: AskTklRun = {
      ...answer,
      status: "abstained",
      answer: "I cannot answer this from grounded TKL evidence.",
      citations: [],
      conflicts: [],
      confidence: { level: "none", rationale: "Unsupported question." },
      freshness: { ...answer.freshness, status: "unknown", newestObservedAt: null, oldestObservedAt: null },
    };
    setTklApiClientForTests({
      askTkl: vi.fn(async () => abstained),
    } as unknown as TklApiClient);
    render(<AskTklPage />);

    fireEvent.change(screen.getByRole("textbox", { name: /Ask TKL question/i }), {
      target: { value: "What is the weather?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Ask TKL$/i }));

    await waitFor(() =>
      expect(screen.getByText(/cannot answer this from grounded TKL evidence/i))
        .toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.getByText("none confidence")).toBeInTheDocument();
  });
});
