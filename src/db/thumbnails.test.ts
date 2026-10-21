import { describe, expect, it } from "vitest";
import { thumbnailKey } from "./thumbnails";

describe("thumbnailKey", () => {
  it("identifies a thumbnail by its media asset id, whatever its URL", () => {
    expect(thumbnailKey({ imageUrl: "https://tr.rbxcdn.com/a/Image", mediaId: 101 })).toBe("media:101");
    expect(thumbnailKey({ imageUrl: "https://tr.rbxcdn.com/b/Image", mediaId: 101 })).toBe("media:101");
  });

  it("falls back to the URL without a media asset id", () => {
    const key = thumbnailKey({ imageUrl: "https://tr.rbxcdn.com/a/Image", mediaId: null });
    expect(key).toMatch(/^url:[0-9a-f]{40}$/);
    expect(thumbnailKey({ imageUrl: "https://tr.rbxcdn.com/b/Image", mediaId: null })).not.toBe(key);
  });
});
