import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("renders unified intelligence by default", async () => {
    render(<App />);

    expect(screen.getByText("TKL Dashboard")).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Search & Investigate" }))
        .toBeInTheDocument(),
    );
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Primary navigation" }))
      .getAllByRole("link")).toHaveLength(5);
  });

  it("preserves query parameters when redirecting a legacy route", async () => {
    window.location.hash = "#/coverage-gaps?q=STT-42";
    render(<App />);

    await waitFor(() =>
      expect(window.location.hash).toBe("#/insights/coverage?q=STT-42"),
    );
    expect(screen.getByRole("link", { name: "Coverage" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
