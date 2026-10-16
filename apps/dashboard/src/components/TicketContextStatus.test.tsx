import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type {
  TicketContextJob,
  TicketContextJobState,
  TicketContextSourceState,
} from "../contracts/types";
import { TicketContextStatus } from "./TicketContextStatus";

function source(
  state: TicketContextSourceState,
  overrides: Partial<TicketContextJob["sources"]["jira"]> = {},
): TicketContextJob["sources"]["jira"] {
  return {
    state,
    startedAt: state === "pending" || state === "not-connected" ? null : "2026-09-15T18:00:00.000Z",
    completedAt: ["running", "pending"].includes(state) ? null : "2026-09-15T18:01:00.000Z",
    attemptCount: state === "not-connected" ? 0 : 1,
    recordsCollected: 0,
    truncated: false,
    error: null,
    ...overrides,
  };
}

function job(
  state: TicketContextJobState,
  overrides: Partial<TicketContextJob> = {},
): TicketContextJob {
  const terminal = !["pending", "running"].includes(state);
  return {
    productId: "fl-titling",
    issueKey: "STT-123",
    state,
    createdAt: "2026-09-15T18:00:00.000Z",
    updatedAt: "2026-09-15T18:01:00.000Z",
    queuedAt: "2026-09-15T18:00:00.000Z",
    startedAt: state === "pending" ? null : "2026-09-15T18:00:02.000Z",
    completedAt: terminal ? "2026-09-15T18:01:00.000Z" : null,
    cancelledAt: state === "cancelled" ? "2026-09-15T18:01:00.000Z" : null,
    attemptCount: 1,
    nextRetryAt: null,
    sources: {
      jira: source(state === "pending" ? "pending" : terminal ? "complete" : "running"),
      testrail: source(state === "pending" ? "pending" : terminal ? "complete" : "running"),
      github: source(state === "pending" ? "pending" : terminal ? "complete" : "running"),
    },
    completeness: {
      status: state === "running" ? "pending" : state,
      complete: state === "complete",
      reasons: [],
    },
    ...overrides,
  };
}

function useClient(overrides: Partial<TklApiClient>) {
  setTklApiClientForTests({
    getTicketContextJob: () => Promise.resolve(null),
    refreshTicketContext: () => Promise.resolve(job("pending")),
    cancelTicketContext: () => Promise.resolve(job("cancelled")),
    ...overrides,
  } as TklApiClient);
}

afterEach(() => {
  setTklApiClientForTests(null);
  vi.useRealTimers();
});

describe("TicketContextStatus", () => {
  it("treats a missing job as a refreshable empty state", async () => {
    useClient({ getTicketContextJob: () => Promise.resolve(null) });

    render(<TicketContextStatus issueKey="STT-123" />);

    await waitFor(() => expect(screen.getByText(/no enrichment job exists yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh context/i })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("supports Jira project keys containing underscores", async () => {
    const getTicketContextJob = vi.fn(async () => null);
    useClient({ getTicketContextJob });

    render(<TicketContextStatus issueKey="qa_core-123" />);

    await waitFor(() => expect(getTicketContextJob).toHaveBeenCalledWith("QA_CORE-123"));
    expect(screen.getByText(/ticket context for QA_CORE-123/i)).toBeInTheDocument();
  });

  it("shows queued status without hiding current local results", async () => {
    useClient({ getTicketContextJob: () => Promise.resolve(job("pending")) });

    render(<TicketContextStatus issueKey="STT-123" />);

    await waitFor(() => expect(screen.getByText(/background enrichment is queued/i)).toBeInTheDocument());
    expect(screen.getByText(/current local results remain available/i)).toBeInTheDocument();
    expect(screen.getAllByText("Pending")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /cancel enrichment/i })).toBeEnabled();
  });

  it("shows running source progress, record counts, and retry timing", async () => {
    const running = job("running", {
      nextRetryAt: "2026-09-15T18:05:00.000Z",
      sources: {
        jira: source("refreshed", { recordsCollected: 6 }),
        testrail: source("running", { recordsCollected: 12, attemptCount: 2 }),
        github: source("pending"),
      },
    });
    useClient({ getTicketContextJob: () => Promise.resolve(running) });

    render(<TicketContextStatus issueKey="STT-123" />);

    await waitFor(() => expect(screen.getByText(/background enrichment is running/i)).toBeInTheDocument());
    expect(screen.getByText("6 records · 1 attempt")).toBeInTheDocument();
    expect(screen.getByText("12 records · 2 attempts")).toBeInTheDocument();
    expect(screen.getByText("Next retry")).toBeInTheDocument();
  });

  it.each([
    ["complete", "Complete"],
    ["unavailable", "Unavailable"],
    ["cancelled", "Cancelled"],
  ] as const)("renders terminal %s status", async (state, label) => {
    useClient({ getTicketContextJob: () => Promise.resolve(job(state)) });

    render(<TicketContextStatus issueKey="STT-123" />);

    await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /cancel enrichment/i })).not.toBeInTheDocument();
  });

  it("shows partial, truncated results and redacts provider error details", async () => {
    const partial = job("partial", {
      sources: {
        jira: source("complete", { recordsCollected: 4 }),
        testrail: source("partial", {
          recordsCollected: 100,
          truncated: true,
          error: {
            code: "provider_error",
            message: "token=super-secret-value https://provider.example/raw?payload=private",
          },
        }),
        github: source("not-connected"),
      },
      completeness: {
        status: "partial",
        complete: false,
        reasons: ["TestRail reached the configured collection limit."],
      },
    });
    useClient({ getTicketContextJob: () => Promise.resolve(partial) });

    render(<TicketContextStatus issueKey="STT-123" />);

    await waitFor(() => expect(screen.getByText(/100 records · 1 attempt · truncated/i)).toBeInTheDocument());
    expect(screen.getByText(/provider error/i)).toBeInTheDocument();
    expect(screen.getByText(/redacted endpoint/i)).toBeInTheDocument();
    expect(screen.queryByText(/super-secret-value/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider\.example/i)).not.toBeInTheDocument();
  });

  it("refreshes a missing job and then exposes cancellation", async () => {
    const refreshTicketContext = vi.fn(async () => job("pending"));
    useClient({
      getTicketContextJob: () => Promise.resolve(null),
      refreshTicketContext,
    });
    render(<TicketContextStatus issueKey="STT-123" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh context/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /refresh context/i }));

    await waitFor(() => expect(refreshTicketContext).toHaveBeenCalledWith("STT-123"));
    expect(screen.getByRole("button", { name: /cancel enrichment/i })).toBeInTheDocument();
  });

  it("cancels an active job and keeps action errors inside the card", async () => {
    const cancelTicketContext = vi.fn(async () => job("cancelled"));
    useClient({
      getTicketContextJob: () => Promise.resolve(job("running")),
      cancelTicketContext,
    });
    render(<TicketContextStatus issueKey="STT-123" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /cancel enrichment/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /cancel enrichment/i }));

    await waitFor(() => expect(cancelTicketContext).toHaveBeenCalledWith("STT-123"));
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });

  it("scopes refresh failures to the card", async () => {
    useClient({
      getTicketContextJob: () => Promise.resolve(null),
      refreshTicketContext: () => Promise.reject(new Error("refresh service unavailable")),
    });
    render(<TicketContextStatus issueKey="STT-123" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh context/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /refresh context/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "Refresh failed: refresh service unavailable",
    ));
  });

  it("polls serially while active and stops after completion", async () => {
    vi.useFakeTimers();
    const getTicketContextJob = vi.fn()
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValueOnce(job("complete"));
    useClient({ getTicketContextJob });
    render(<TicketContextStatus issueKey="STT-123" pollIntervalMs={500} />);
    await act(async () => undefined);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(getTicketContextJob).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(getTicketContextJob).toHaveBeenCalledTimes(2);
  });

  it("does not overlap polls and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: TicketContextJob) => void) | undefined;
    const getTicketContextJob = vi.fn()
      .mockResolvedValueOnce(job("running"))
      .mockImplementationOnce(() => new Promise<TicketContextJob>((resolve) => {
        resolvePoll = resolve;
      }));
    useClient({ getTicketContextJob });
    const view = render(<TicketContextStatus issueKey="STT-123" pollIntervalMs={500} />);
    await act(async () => undefined);

    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
    });
    expect(getTicketContextJob).toHaveBeenCalledTimes(2);

    view.unmount();
    resolvePoll?.(job("running"));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(2_000);
    });
    expect(getTicketContextJob).toHaveBeenCalledTimes(2);
  });

  it("does not let a stalled poll block cancellation or overwrite its result", async () => {
    vi.useFakeTimers();
    let resolvePoll: ((value: TicketContextJob) => void) | undefined;
    const getTicketContextJob = vi.fn()
      .mockResolvedValueOnce(job("running"))
      .mockImplementationOnce(() => new Promise<TicketContextJob>((resolve) => {
        resolvePoll = resolve;
      }));
    const cancelTicketContext = vi.fn(async () => job("cancelled"));
    useClient({ getTicketContextJob, cancelTicketContext });
    render(<TicketContextStatus issueKey="STT-123" pollIntervalMs={500} />);
    await act(async () => undefined);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel enrichment/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cancelTicketContext).toHaveBeenCalledWith("STT-123");
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);

    resolvePoll?.(job("running"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
  });
});
