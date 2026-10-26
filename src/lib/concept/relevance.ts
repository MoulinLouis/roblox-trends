import { titleWords } from "@/lib/title";

// The folded words a search result must share with the phrases of a concept check. "+1" and the like are left out:
// every game of the +1 format shares them.
export function relevanceWords(phrases: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const phrase of phrases) {
    for (const word of titleWords(phrase).keys()) if (!/^\+\d+$/.test(word)) words.add(word);
  }
  return words;
}

export function isRelevant(text: { name: string; description: string }, words: ReadonlySet<string>): boolean {
  return [text.name, text.description].some((value) => [...titleWords(value).keys()].some((word) => words.has(word)));
}
