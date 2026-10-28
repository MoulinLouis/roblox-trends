import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { downloadThumbnailJpeg } from "./thumbnails";

const thumbnailUrl = "https://tr.rbxcdn.com/180DAY-example/768/432/Image/Png/noFilter";

function respondWith(response: () => Response): typeof fetch {
  return async () => response();
}

async function thumbnailPng(): Promise<Buffer> {
  return sharp({ create: { width: 768, height: 432, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

describe("downloadThumbnailJpeg", () => {
  it("re-encodes a PNG thumbnail as a JPEG of the same size", async () => {
    const png = await thumbnailPng();
    const jpeg = await downloadThumbnailJpeg(
      thumbnailUrl,
      respondWith(() => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } })),
    );

    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const metadata = await sharp(jpeg!).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 768, height: 432 });
  });

  it("requests the stored URL", async () => {
    const requested: string[] = [];
    const png = await thumbnailPng();
    await downloadThumbnailJpeg(thumbnailUrl, async (input) => {
      requested.push(String(input));
      return new Response(new Uint8Array(png));
    });

    expect(requested).toEqual([thumbnailUrl]);
  });

  it("returns null for a response that is not 2xx", async () => {
    const png = await thumbnailPng();
    const fetchImage = respondWith(() => new Response(new Uint8Array(png), { status: 404 }));

    await expect(downloadThumbnailJpeg(thumbnailUrl, fetchImage)).resolves.toBeNull();
  });

  it("returns null for a body that is not an image", async () => {
    const fetchImage = respondWith(() => new Response("<html>Not found</html>", { headers: { "content-type": "text/html" } }));

    await expect(downloadThumbnailJpeg(thumbnailUrl, fetchImage)).resolves.toBeNull();
  });

  it("returns null without a request for a game without a thumbnail", async () => {
    let requests = 0;
    const fetchImage: typeof fetch = async () => {
      requests += 1;
      return new Response(new Uint8Array(await thumbnailPng()));
    };

    await expect(downloadThumbnailJpeg(null, fetchImage)).resolves.toBeNull();
    expect(requests).toBe(0);
  });

  it("returns null when the request fails", async () => {
    const fetchImage: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(downloadThumbnailJpeg(thumbnailUrl, fetchImage)).resolves.toBeNull();
  });
});
