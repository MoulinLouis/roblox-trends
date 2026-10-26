import { createHash } from "node:crypto";
import { normalizeTitle } from "./title";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Changes on any byte-level edit, including seasonal markers such as [🎃].
export function rawFingerprint(name: string, description: string): string {
  return sha1(`${name}\u0000${description}`);
}

// The algorithm behind contentFingerprint. Bump it whenever normalizeTitle or normalizeText returns something else:
// `npm run db:migrate` recomputes the stored fingerprints of earlier versions, and a classification records the
// version it compared, so a normalizer change does not read as a change of every game. Version 2 (2026-10-26) ignores
// bracketed text in titles, and update versions and trailing markers.
export const CONTENT_FINGERPRINT_VERSION = 2;

// Changes only when the concept text changes; used to decide reclassification.
export function contentFingerprint(name: string, description: string): string {
  return sha1(`${normalizeTitle(name).toLowerCase()}\u0000${normalizeText(description)}`);
}

export function urlFingerprint(url: string): string {
  return sha1(url);
}
