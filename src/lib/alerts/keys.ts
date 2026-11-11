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

// The pattern keys of every tracked game, computed against the titles of all of them: the job and the backtest build
// their keys the same way. A game without a format row is keyed by its title words alone.
export function trackedGameKeys(
  tracked: ReadonlyArray<{ universeId: number; name: string }>,
  formats: ReadonlyMap<number, GameFormat>,
  options: { wordsOnly?: boolean } = {},
): Map<number, string[]> {
  const frequencies = wordFrequencies(tracked.map((game) => game.name));
  const keysOf = new Map<number, string[]>();
  for (const game of tracked) {
    const format = formats.get(game.universeId) ?? { name: game.name, family: null, template: null, coreAction: null };
    keysOf.set(game.universeId, patternKeys(format, frequencies, tracked.length, options));
  }
  return keysOf;
}
