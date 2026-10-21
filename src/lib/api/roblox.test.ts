import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_CONFIG } from "@/lib/config";
import { clearResponseCache } from "./http";
import { RobloxClient, ROBLOX_MAXIMUM_IDS_PER_REQUEST } from "./roblox";

describe("collector batch sizes", () => {
  // A larger batch would be split into several requests: a failed later request would then lose the answers of the
  // earlier ones for poll and votes, and thumbnails would no longer count an unanswered request as a failed batch.
  it.each([
    ["poll", JOB_CONFIG.poll.batchSize],
    ["votes", JOB_CONFIG.votes.batchSize],
    ["thumbnails", JOB_CONFIG.thumbnails.batchSize],
  ])("fit one Roblox request for %s", (_, batchSize) => {
    expect(batchSize).toBeLessThanOrEqual(ROBLOX_MAXIMUM_IDS_PER_REQUEST);
  });
});

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
    expect(urls[0].searchParams.get("countPerUniverse")).toBe("3");
    expect(urls[0].searchParams.get("size")).toBe("768x432");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400 Bad Request"));
  });

  it("keeps the other batches when one envelope is malformed", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) return Response.json({ data: "x" });
      return Response.json({ data: [{ universeId: 51, error: null, thumbnails: [{ targetId: 7, state: "Completed", imageUrl: "https://tr.rbxcdn.com/d/768/432/Image/Png" }] }] });
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const universeIds = Array.from({ length: 51 }, (_, index) => String(index + 1));

    const thumbnails = await new RobloxClient().getGameThumbnails(universeIds);

    expect([...thumbnails]).toEqual([["51", { imageUrl: "https://tr.rbxcdn.com/d/768/432/Image/Png", mediaId: 7 }]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Thumbnail batch failed"));
  });
});

describe("RobloxClient.getThumbnails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearResponseCache();
  });

  it("keeps the other icon batches when one fails", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      urls.push(new URL(String(input)));
      if (urls.length === 1) return new Response("Bad Request", { status: 400, statusText: "Bad Request" });
      return Response.json({ data: [{ targetId: 51, state: "Completed", imageUrl: "https://tr.rbxcdn.com/e/150/150/Image/Webp" }] });
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const universeIds = Array.from({ length: 51 }, (_, index) => String(index + 1));

    const icons = await new RobloxClient().getThumbnails(universeIds);

    expect([...icons]).toEqual([["51", "https://tr.rbxcdn.com/e/150/150/Image/Webp"]]);
    expect(urls.map((url) => url.searchParams.get("universeIds")?.split(",").length)).toEqual([50, 1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("400 Bad Request"));
  });

  it("keeps the other icon batches when one envelope is malformed", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) return Response.json({ data: "x" });
      return Response.json({ data: [{ targetId: 51, state: "Completed", imageUrl: "https://tr.rbxcdn.com/e/150/150/Image/Webp" }] });
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const universeIds = Array.from({ length: 51 }, (_, index) => String(index + 1));

    const icons = await new RobloxClient().getThumbnails(universeIds);

    expect([...icons]).toEqual([["51", "https://tr.rbxcdn.com/e/150/150/Image/Webp"]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Thumbnail batch failed"));
  });
});

describe("RobloxClient.resolveUniverseId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearResponseCache();
  });

  it("returns the universe of a place", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ universeId: 456 })));
    expect(await new RobloxClient().resolveUniverseId("123")).toBe("456");
  });

  it("returns null for a place without a universe", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ universeId: null })));
    expect(await new RobloxClient().resolveUniverseId("123")).toBeNull();
  });
});
