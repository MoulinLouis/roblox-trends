import sharp from "sharp";
import { CLASSIFICATION_CONFIG, EXTERNAL_REQUEST_CONFIG } from "@/lib/config";

// Downloads a stored 16:9 thumbnail and re-encodes it as JPEG; null when the URL is null, the response is not 2xx or
// the body is not an image. Never throws.
// Roblox stores 768×432 PNGs; two hundred of them in base64 can exceed the 256 MB batch limit, JPEGs cannot. The CDN is
// not rate-limited like the APIs, so this does not go through fetchJson.
export async function downloadThumbnailJpeg(url: string | null, fetchImage: typeof fetch = fetch): Promise<Buffer | null> {
  if (url === null) {
    return null;
  }
  try {
    const response = await fetchImage(url, { signal: AbortSignal.timeout(EXTERNAL_REQUEST_CONFIG.defaultTimeoutMs) });
    if (!response.ok) {
      // An unread body holds its connection until it is garbage-collected.
      await response.body?.cancel();
      return null;
    }
    const body = Buffer.from(await response.arrayBuffer());
    return await sharp(body).jpeg({ quality: CLASSIFICATION_CONFIG.thumbnailJpegQuality }).toBuffer();
  } catch {
    return null;
  }
}
