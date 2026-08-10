import { describe, expect, it } from "vitest";
import { normalizePostgresConnectionUrl } from "./connection-url";

describe("normalizePostgresConnectionUrl", () => {
  it.each(["prefer", "require", "verify-ca"])(
    "uses explicit certificate verification for sslmode=%s",
    (sslMode) => {
      expect(
        normalizePostgresConnectionUrl(
          `postgresql://user:secret@example.com/database?sslmode=${sslMode}`,
        ),
      ).toBe("postgresql://user:secret@example.com/database?sslmode=verify-full");
    },
  );

  it("preserves an explicit verify-full mode and other query parameters", () => {
    const connectionUrl =
      "postgresql://user:secret@example.com/database?sslmode=verify-full&channel_binding=require";

    expect(normalizePostgresConnectionUrl(connectionUrl)).toBe(connectionUrl);
  });

  it("does not alter unrelated values", () => {
    const connectionUrl =
      "postgresql://user:require@example.com/database?application_name=require";

    expect(normalizePostgresConnectionUrl(connectionUrl)).toBe(connectionUrl);
  });
});
