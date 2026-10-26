import { titleText, titleWords } from "@/lib/title";

// Scripts written without spaces between words, where a word is matched inside the text instead of as a whole word,
// and whose two-letter words ("타일", "跳水") still mean something.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// The words a search result must share with the phrases of a concept check. "+1" and the like are left out: every
// game of the +1 format shares them.
export function relevanceWords(phrases: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const phrase of phrases) {
    for (const word of titleWords(phrase).keys()) {
      if (!/^\+\d+$/.test(word) && !UNSPACED_SCRIPT.test(word)) words.add(word);
    }
    for (const token of titleText(phrase).toLowerCase().split(/\s+/)) {
      if (UNSPACED_SCRIPT.test(token) && [...token].length >= 2) words.add(token);
    }
  }
  return words;
}

export function isRelevant(text: { name: string; description: string }, words: ReadonlySet<string>): boolean {
  const values = [text.name, text.description];
  const folded = new Set(values.flatMap((value) => [...titleWords(value).keys()]));
  const plain = values.map((value) => titleText(value).toLowerCase()).join("\n");
  return [...words].some((word) => (UNSPACED_SCRIPT.test(word) ? plain.includes(word) : folded.has(word)));
}
