import { describe, expect, it } from "vitest";
import { errorMessage } from "./logger";

describe("errorMessage", () => {
  it("returns the message of an error without a cause", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies values that are not errors", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
    expect(errorMessage(42)).toBe("42");
  });

  it("appends the cause chain", () => {
    const error = new Error("fetch failed", { cause: new Error("ECONNREFUSED") });
    expect(errorMessage(error)).toBe("fetch failed: ECONNREFUSED");
  });

  it("ends the chain with a cause that is not an error", () => {
    const error = new Error("query failed", { cause: new Error("socket closed", { cause: "server restart" }) });
    expect(errorMessage(error)).toBe("query failed: socket closed: server restart");
  });

  it("names a cause that has an empty message by its code", () => {
    const cause = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(errorMessage(new Error("fetch failed", { cause }))).toBe("fetch failed: ECONNREFUSED");
  });

  it("follows at most five causes", () => {
    let error = new Error("level 7");
    for (let level = 6; level >= 0; level -= 1) error = new Error(`level ${level}`, { cause: error });
    expect(errorMessage(error)).toBe("level 0: level 1: level 2: level 3: level 4: level 5");
  });
});
