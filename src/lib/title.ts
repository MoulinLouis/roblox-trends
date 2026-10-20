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
  `^(${PROMOTIONAL_MARKERS.map(escapeRegExp).join("|")})(\\s*[!:]+\\s*|\\s+-+\\s+|\\s+(?=\\S))`,
  "i",
);

export function normalizeTitle(title: string): string {
  let normalized = title.normalize("NFKC").replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ");
  normalized = normalized.replace(BRACKETED_TEXT, (marker) =>
    containsWholeMarker(marker.slice(1, -1), BRACKET_MARKERS) ? " " : marker,
  );
  normalized = stripLeadingMarker(normalized.trimStart());
  return normalized
    .replace(/[^\p{L}\p{N}+'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingMarker(text: string): string {
  const match = LEADING_MARKER.exec(text);
  if (!match) return text;
  const [prefix, marker, separator] = match;
  const rest = text.slice(prefix.length);
  const punctuated = /[!:-]/.test(separator);
  // Capitals mark a promotion only when the rest of the title is not written in capitals too.
  const capitalized = marker === marker.toUpperCase() && /\p{Ll}/u.test(rest);
  return punctuated || capitalized ? rest : text;
}

function containsWholeMarker(text: string, markers: readonly string[]): boolean {
  const words = ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;
  return markers.some((marker) => words.includes(` ${marker} `));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
