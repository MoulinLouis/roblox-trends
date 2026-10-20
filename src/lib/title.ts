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
  let normalized = title.normalize("NFKC").replace(/\p{Extended_Pictographic}|️|‍/gu, " ");
  normalized = normalized.replace(/[\[({【][^\])}】]{0,48}[\])}】]/g, (marker) => {
    const content = marker.slice(1, -1).toLowerCase();
    return PROMOTIONAL_MARKERS.some((word) => content.includes(word)) ? " " : marker;
  });
  normalized = normalized.replace(
    new RegExp(`^(?:${PROMOTIONAL_MARKERS.map(escapeRegExp).join("|")})[!:\\-\\s]+`, "i"),
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
