import { describe, expect, it } from "vitest";
import { parseImportArguments } from "./arguments";

describe("parseImportArguments", () => {
  it("accepts no argument", () => {
    expect(parseImportArguments([])).toEqual({});
  });

  it("reads --since", () => {
    expect(parseImportArguments(["--since=2026-09-30T00:00:00Z"])).toEqual({ since: new Date("2026-09-30T00:00:00Z") });
  });

  it.each([
    [["--since"], /--since needs a date/],
    [["--since="], /--since needs a date/],
    [["--since=yesterday"], /Invalid --since date: yesterday/],
    [["--since=2026-09-30", "--since=2026-10-01"], /--since is given more than once/],
    [["--dry-run"], /Unknown argument: --dry-run/],
    [["2026-09-30"], /Unknown argument: 2026-09-30/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseImportArguments(argv)).toThrow(message);
  });
});
