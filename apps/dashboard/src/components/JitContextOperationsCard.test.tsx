import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type { TicketContextOperations } from "../contracts/types";
import { mockTicketContextOperations } from "../mocks/fixtures";
import { JitContextOperationsCard } from "./JitContextOperationsCard";

function operations(overrides: Partial<TicketContextOperations> = {}): TicketContextOperations {
  return {
    ...structuredClone(mockTicketContextOperations),
    health: {
      status: "healthy",
      reasons: [],
    },
    durable: {
      ...mockTicketContextOperations.durable,
      jobStates: {
        ...mockTicketContextOperations.durable.jobStates,
        partial: 0,
        unavailable: 0,
      },
    },
    memory: { ...mockTicketContextOperations.memory },
    capacity: { ...mockTicketContextOperations.capacity },
    invalidations: {
      ...mockTicketContextOperations.invalidations,
      dispositions: {
        ...mockTicketContextOperations.invalidations.dispositions,
        rejected: 0,
      },
    },
    lastWorkerFailure: null,
    lastPersistenceFailure: null,
    ...overrides,
  };
}

function useOperationsClient(
  getTicketContextOperations: TklApiClient["getTicketContextOperations"],
) {
  setTklApiClientForTests({ getTicketContextOperations } as unknown as TklApiClient);
}

afterEach(() => {
  vi.useRealTimers();
  setTklApiClientForTests(null);
});

describe("JitContextOperationsCard", () => {
  it("renders an idle healthy status with all operational groups", async () => {
    useOperationsClient(() => Promise.resolve(operations()));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("The JIT context queue is idle.")).toBeInTheDocument();
    expect(screen.getByText("Durable job states")).toBeInTheDocument();
    expect(screen.getByText("Invalidation dispositions")).toBeInTheDocument();
    expect(screen.getByText("Last successful completion")).toBeInTheDocument();
    expect(screen.getByText("Last invalidation")).toBeInTheDocument();
    expect(screen.getByText("Last retention sweep")).toBeInTheDocument();
  });

  it("announces active queue work and shows queue age", async () => {
    useOperationsClient(() => Promise.resolve(operations({
      memory: {
        queued: 3,
        active: 1,
        delayedRetry: 0,
        paused: false,
        oldestQueuedAgeMs: 125_000,
      },
    })));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText(/3 queued, 1 active, 0 delayed retry/i))
      .toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("2 min")).toBeInTheDocument();
  });

  it("renders the canonical degraded health returned by the API", async () => {
    useOperationsClient(() => Promise.resolve(operations({
      health: {
        status: "degraded",
        reasons: ["capacity_high", "worker_failure"],
      },
      capacity: { used: 95, max: 100, percent: 95 },
      lastWorkerFailure: {
        at: "2026-09-15T17:10:00.000Z",
        code: "worker_timeout",
      },
    })));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText(/capacity is at least 90%/i)).toBeInTheDocument();
    expect(screen.getByText(/a worker failure has not yet been followed/i)).toBeInTheDocument();
    expect(screen.getByText("worker_timeout")).toBeInTheDocument();
  });

  it("does not degrade for historical partial jobs or recovered failures", async () => {
    useOperationsClient(() => Promise.resolve(operations({
      durable: {
        ...mockTicketContextOperations.durable,
        jobStates: {
          ...mockTicketContextOperations.durable.jobStates,
          partial: 4,
          unavailable: 2,
        },
      },
      invalidations: {
        ...mockTicketContextOperations.invalidations,
        dispositions: {
          ...mockTicketContextOperations.invalidations.dispositions,
          rejected: 7,
        },
      },
      lastWorkerFailure: {
        at: "2026-09-15T16:00:00.000Z",
        code: "worker_timeout",
      },
      lastSuccessfulCompletion: "2026-09-15T17:00:00.000Z",
    })));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText("Healthy")).toBeInTheDocument();
  });

  it("sanitizes malformed failure codes and never renders provider messages", async () => {
    useOperationsClient(() => Promise.resolve(operations({
      lastPersistenceFailure: {
        at: "2026-09-15T17:10:00.000Z",
        code: "Provider said Bearer secret-token",
      },
    })));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText("invalid_failure_code")).toBeInTheDocument();
    expect(screen.queryByText(/secret-token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider said/i)).not.toBeInTheDocument();
  });

  it("shows a useful empty state without hiding operational fields", async () => {
    useOperationsClient(() => Promise.resolve(operations({
      durable: {
        jobStates: {
          pending: 0,
          running: 0,
          complete: 0,
          partial: 0,
          unavailable: 0,
          cancelled: 0,
        },
        totalJobs: 0,
        deliveryReceipts: 0,
      },
      attempts: 0,
      retries: 0,
      invalidations: {
        dispositions: {
          accepted: 0,
          duplicate: 0,
          obsolete: 0,
          "not-hot": 0,
          rejected: 0,
        },
        last: null,
      },
      lastSuccessfulCompletion: null,
      lastRetentionSweep: null,
    })));

    render(<JitContextOperationsCard />);

    expect(await screen.findByText(/no JIT context work has been recorded yet/i))
      .toBeInTheDocument();
    expect(screen.getByText("Durable jobs")).toBeInTheDocument();
    expect(screen.getAllByText("None recorded").length).toBeGreaterThan(1);
  });

  it("scopes an operations request failure to the card", async () => {
    useOperationsClient(() => Promise.reject(new Error("status endpoint unavailable")));

    render(<JitContextOperationsCard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("JIT context status is unavailable");
    expect(alert).not.toHaveTextContent("status endpoint unavailable");
    expect(screen.getByRole("heading", { name: "JIT Context" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  });

  it("polls about every five seconds while work exists and stops when idle", async () => {
    vi.useFakeTimers();
    const getTicketContextOperations = vi.fn()
      .mockResolvedValueOnce(operations({
        memory: {
          queued: 1,
          active: 0,
          delayedRetry: 0,
          paused: false,
          oldestQueuedAgeMs: 500,
        },
      }))
      .mockResolvedValueOnce(operations());
    useOperationsClient(getTicketContextOperations);

    render(<JitContextOperationsCard />);
    await act(async () => { await Promise.resolve(); });
    expect(getTicketContextOperations).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(4_999);
      await Promise.resolve();
    });
    expect(getTicketContextOperations).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getTicketContextOperations).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(getTicketContextOperations).toHaveBeenCalledTimes(2);
  });

  it("cleans up polling on unmount", async () => {
    vi.useFakeTimers();
    const getTicketContextOperations = vi.fn(() => Promise.resolve(operations({
      memory: {
        queued: 0,
        active: 1,
        delayedRetry: 0,
        paused: false,
        oldestQueuedAgeMs: null,
      },
    })));
    useOperationsClient(getTicketContextOperations);

    const { unmount } = render(<JitContextOperationsCard />);
    await act(async () => { await Promise.resolve(); });
    expect(getTicketContextOperations).toHaveBeenCalledTimes(1);

    unmount();
    act(() => vi.advanceTimersByTime(5_000));
    expect(getTicketContextOperations).toHaveBeenCalledTimes(1);
  });

  it("does not overlap requests when refresh is used during an active request", async () => {
    let resolveRequest!: (value: TicketContextOperations) => void;
    const getTicketContextOperations = vi.fn(() => new Promise<TicketContextOperations>(
      (resolve) => { resolveRequest = resolve; },
    ));
    useOperationsClient(getTicketContextOperations);

    render(<JitContextOperationsCard />);
    await waitFor(() => expect(getTicketContextOperations).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeDisabled();

    resolveRequest(operations());
    await screen.findByText("Healthy");
  });
});
