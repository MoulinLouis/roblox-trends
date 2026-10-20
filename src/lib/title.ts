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

// Seasonal words mark a promotion only inside brackets; at the start of a title they can be the name.
const SEASONAL_MARKERS = [
  "halloween",
  "christmas",
  "xmas",
  "easter",
  "summer",
  "winter",
  "valentine",
  "valentines",
  "season",
  "szn",
];

const BRACKET_MARKERS = [...PROMOTIONAL_MARKERS, ...SEASONAL_MARKERS];

const BRACKETED_TEXT = /[\[({【][^\])}】]{0,48}[\])}】]/g;

const LEADING_MARKER = new RegExp(
  `^(${PROMOTIONAL_MARKERS.map(escapeRegExp).join("|")})(\\s*[!:-]+\\s*|\\s+(?=\\S))`,
  "i",
);

export function normalizeTitle(title: string): string {
  let normalized = title.normalize("NFKC").replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ");
  normalized = normalized.replace(BRACKETED_TEXT, (marker) =>
    containsWholeMarker(marker.slice(1, -1), BRACKET_MARKERS) ? " " : marker,
  );
  normalized = normalized.replace(LEADING_MARKER, (match, marker: string, separator: string) => {
    const punctuated = /[!:-]/.test(separator);
    const capitalized = marker === marker.toUpperCase();
    return punctuated || capitalized ? "" : match;
  });
  return normalized
    .replace(/[^\p{L}\p{N}+'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWholeMarker(text: string, markers: readonly string[]): boolean {
  const words = ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;
  return markers.some((marker) => words.includes(` ${marker} `));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
