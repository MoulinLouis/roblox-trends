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

const MARKERS = PROMOTIONAL_MARKERS.map(escapeRegExp).join("|");

// The versions an update marker may carry. A spaced number before a word starts the name instead ("UPDATE 99 Nights
// in the Forest").
const VERSION_FORMS = [
  "\\d+(?:\\.\\d+)*", // UPD3
  "\\s*v\\d+(?:\\.\\d+)*", // UPDATE v2
  "\\s*\\d+(?:\\.\\d+)+", // UPD 2.5
  "\\s+\\d+(?=\\s*(?:[!:|]|$)|\\s+-+\\s)", // UPDATE 2!, UPD 2 - Name, Name | UPDATE 2
];

const VERSION = `(?<=upd|update)(?:${VERSION_FORMS.join("|")})`;

const LEADING_MARKER = new RegExp(`^(${MARKERS})(${VERSION})?(\\s*[!:|]+\\s*|\\s+-+\\s+|\\s+(?=\\S))`, "i");

const TRAILING_SEPARATOR = /(\s*\|\s*|\s+-+\s+)/;

const ONLY_MARKERS = new RegExp(`^\\s*(?:(?:${MARKERS})(?:${VERSION})?(?![\\p{L}\\p{N}])[\\s!:]*)+$`, "iu");

// The concept of a title, which content fingerprints hash. Titles carry their announcements in brackets ("[⏳ 2H]",
// "[UPD 3]", "[WORLD 4]", "[LUFFY👒]"), so the concept is the text outside them; a title made only of brackets keeps
// those that are not markers.
export function normalizeTitle(title: string): string {
  const emojiFree = withoutEmoji(title);
  return firstWithWords([emojiFree.replace(BRACKETED_TEXT, " "), withoutBracketedMarkers(emojiFree)], emojiFree);
}

// The words of a title without its markers, bracketed ones included: explore searches the names titles put in
// brackets ("[Sprunki] Morphs").
export function titleText(title: string): string {
  const emojiFree = withoutEmoji(title);
  return firstWithWords([withoutBracketedMarkers(emojiFree)], emojiFree);
}

function withoutEmoji(title: string): string {
  return title.normalize("NFKC").replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ");
}

function withoutBracketedMarkers(text: string): string {
  return text.replace(BRACKETED_TEXT, (marker) =>
    containsWholeMarker(marker.slice(1, -1), BRACKET_MARKERS) ? " " : marker,
  );
}

// The first candidate left with a letter or a digit once its markers are stripped. A title made only of markers
// ("UPDATE!", "[NEW]") keeps them.
function firstWithWords(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    const normalized = keepWords(stripTrailingMarkers(stripLeadingMarkers(candidate.trim())));
    if (/[\p{L}\p{N}]/u.test(normalized)) return normalized;
  }
  return keepWords(fallback);
}

function keepWords(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}+'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingMarkers(text: string): string {
  let rest = text;
  for (let stripped = stripLeadingMarker(rest); stripped !== rest; stripped = stripLeadingMarker(rest)) {
    rest = stripped.trimStart();
  }
  return rest;
}

// "Iron Skies - Beta", "Swing For Eggs | UPDATE 2": segments after a bar or a spaced dash that hold only markers.
function stripTrailingMarkers(text: string): string {
  const parts = text.split(TRAILING_SEPARATOR);
  while (parts.length > 1 && ONLY_MARKERS.test(parts[parts.length - 1])) parts.splice(-2);
  return parts.join("");
}

function stripLeadingMarker(text: string): string {
  const match = LEADING_MARKER.exec(text);
  if (!match) return text;
  const [prefix, marker, , separator] = match;
  const rest = text.slice(prefix.length);
  const punctuated = /[!:|-]/.test(separator);
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
