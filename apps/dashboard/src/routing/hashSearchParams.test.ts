import { afterEach, describe, expect, it } from "vitest";
import { hashSearchParam } from "./hashSearchParams";

describe("hashSearchParam", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("reads and decodes deep-link context from a hash route", () => {
    window.location.hash =
      "#/ask?q=What%20covers%20STT-3731%3F&workItemId=STT-3731";

    expect(hashSearchParam("q")).toBe("What covers STT-3731?");
    expect(hashSearchParam("workItemId")).toBe("STT-3731");
  });

  it("returns an empty value for a missing parameter", () => {
    window.location.hash = "#/investigate";

    expect(hashSearchParam("q")).toBe("");
  });
});
