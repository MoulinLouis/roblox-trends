import { afterEach, describe, expect, it, vi } from "vitest";
import { clearResponseCache } from "./http";
import { RobloxClient } from "./roblox";

describe("RobloxClient.getGameThumbnails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearResponseCache();
  });

  it("requests 16:9 thumbnails without generic defaults and keeps other batches when one fails", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      urls.push(new URL(String(input)));
      if (urls.length === 1) return new Response("Bad Request", { status: 400, statusText: "Bad Request" });
      return Response.json({ data: [{ universeId: 51, error: null, thumbnails: [{ targetId: 7, state: "Completed", imageUrl: "https://tr.rbxcdn.com/d/768/432/Image/Png" }] }] });
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const universeIds = Array.from({ length: 51 }, (_, index) => String(index + 1));

    const thumbnails = await new RobloxClient().getGameThumbnails(universeIds);

    expect([...thumbnails]).toEqual([["51", { imageUrl: "https://tr.rbxcdn.com/d/768/432/Image/Png", mediaId: 7 }]]);
    expect(urls.map((url) => url.searchParams.get("universeIds")?.split(",").length)).toEqual([50, 1]);
    expect(urls[0].searchParams.get("defaults")).toBe("false");
    expect(urls[0].searchParams.get("size")).toBe("768x432");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400 Bad Request"));
  });
});
