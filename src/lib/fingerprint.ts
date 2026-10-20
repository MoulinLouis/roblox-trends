import { createHash } from "node:crypto";
import { normalizeTitle } from "./title";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

// Changes on any visible edit, including seasonal markers such as [🎃].
export function rawFingerprint(name: string, description: string): string {
  return sha1(`${name}\u0000${description}`);
}

// Changes only when the concept text changes; used to decide reclassification.
export function contentFingerprint(name: string, description: string): string {
  return sha1(`${normalizeTitle(name).toLocaleLowerCase()}\u0000${normalizeText(description)}`);
}

export function urlFingerprint(url: string): string {
  return sha1(url);
}
