import { mergeKey } from "../classify/merges";
import { ALERT_CONFIG } from "../config";
import { titleWords } from "../title";
import type { GameFormat } from "./types";

// The number of titles carrying each folded word of titleWords, once per title.
export function wordFrequencies(titles: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const word of titleWords(title).keys()) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

// The patterns a game belongs to: its title words that point to one trend (carried by enough titles, but not by too
// large a share of them), the gameplay of its classification and its title template. Sorted and unique.
export function patternKeys(
  game: GameFormat,
  frequencies: Map<string, number>,
  totalTitles: number,
  options: { wordsOnly?: boolean } = {},
  config: Pick<typeof ALERT_CONFIG, "minimumWordGames" | "maximumWordShare"> = ALERT_CONFIG,
): string[] {
  const keys = new Set<string>();
  for (const word of titleWords(game.name).keys()) {
    const count = frequencies.get(word) ?? 0;
    if (count >= config.minimumWordGames && count / totalTitles <= config.maximumWordShare) keys.add(`word:${word}`);
  }
  if (!options.wordsOnly) {
    const family = game.family === null ? "" : mergeKey(game.family);
    const coreAction = game.coreAction === null ? "" : mergeKey(game.coreAction);
    if (family !== "" && coreAction !== "") keys.add(`action:${family}|${coreAction}`);
    const template = game.template === null ? "" : mergeKey(game.template);
    if (template !== "" && template !== "none") keys.add(`template:${template}`);
  }
  return [...keys].sort();
}
