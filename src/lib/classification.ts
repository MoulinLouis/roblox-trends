import type { GameTag, Taxonomy, TagDimension } from "./types";

const PROMOTIONAL_MARKERS = [
  "update",
  "updated",
  "new",
  "admin abuse",
  "event",
  "codes",
  "code",
  "release",
  "beta",
  "alpha",
  "x2",
  "2x",
  "x3",
  "3x",
  "upd",
];

export function normalizeTitle(title: string): string {
  let normalized = title.normalize("NFKC").replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ");
  normalized = normalized.replace(/[\[({【][^\])}】]{0,48}[\])}】]/g, (marker) => {
    const content = marker.slice(1, -1).toLowerCase();
    return PROMOTIONAL_MARKERS.some((word) => content.includes(word)) ? " " : marker;
  });
  normalized = normalized.replace(
    new RegExp(`^(?:${PROMOTIONAL_MARKERS.map(escapeRegExp).join("|")})[!:\-\\s]+`, "i"),
    "",
  );
  return normalized
    .replace(/[^\p{L}\p{N}+'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesAlias(text: string, alias: string): boolean {
  const escaped = escapeRegExp(alias.toLocaleLowerCase());
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function classifyGame(name: string, description: string, taxonomy: Taxonomy): GameTag[] {
  const text = `${normalizeTitle(name)} ${description}`.normalize("NFKC").toLocaleLowerCase();
  const results: GameTag[] = [];

  for (const [dimension, entries] of Object.entries(taxonomy) as [TagDimension, Taxonomy[TagDimension]][]) {
    for (const entry of entries) {
      if (entry.aliases.some((alias) => includesAlias(text, alias))) {
        results.push({ dimension, tag: entry.tag, source: "automatic" });
      }
    }
  }

  return results.filter(
    (candidate, index, all) =>
      all.findIndex((tag) => tag.dimension === candidate.dimension && tag.tag === candidate.tag) === index,
  );
}

export function formatTagStack(tags: GameTag[]): string {
  return tags.map((tag) => tag.tag).join(" + ");
}
