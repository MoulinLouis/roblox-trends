import { enqueueCandidates } from "@/db/candidates";
import type { Database } from "@/db/client";
import { recordDiscoveries } from "@/db/discovery";
import { lastSearchedTerms, selectExplorationSeeds } from "@/db/explore";
import { knownUniverseIds } from "@/db/games";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi, RobloxChartGame } from "@/lib/api/roblox";
import { compareText } from "@/lib/arrays";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { normalizeTitle } from "@/lib/title";
import { httpMetricsSince, isRateLimited } from "./batching";
import type { JobDefinition } from "./runner";
import type { DiscoverySource } from "./types";

// Words too generic to point to one trend: searching them returns the platform's biggest games, not related ones.
const SEARCH_STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "your",
  "you",
  "from",
  "into",
  "but",
  "are",
  "all",
  "can",
  "not",
  "how",
  "who",
  "what",
  "this",
  "that",
  "its",
  "our",
  "out",
  "game",
  "games",
  "roblox",
  "simulator",
  "obby",
  "tycoon",
  "update",
  "new",
]);

export interface VocabularyWord {
  // The folded word ("egg" for "Eggs" and "Egg's"), by which titles are counted.
  word: string;
  // Its commonest spelling in the titles, which the search sends.
  term: string;
  titles: number;
}

// The words that young games share are the vocabulary of what is made now. A word counts once per title and must be
// shared by `minimumTitles` titles, or by every title when fewer are available. Most shared first.
export function titleVocabulary(titles: string[], minimumTitles: number): VocabularyWord[] {
  const words = new Map<string, { titles: number; forms: Map<string, number> }>();
  for (const title of titles) {
    for (const [word, form] of titleWords(title)) {
      const entry = words.get(word) ?? { titles: 0, forms: new Map<string, number>() };
      entry.titles += 1;
      entry.forms.set(form, (entry.forms.get(form) ?? 0) + 1);
      words.set(word, entry);
    }
  }
  const minimumOccurrences = Math.min(minimumTitles, titles.length);
  return [...words.entries()]
    .filter(([, entry]) => entry.titles >= minimumOccurrences)
    .map(([word, entry]) => ({ word, term: commonestForm(entry.forms), titles: entry.titles }))
    .sort((left, right) => right.titles - left.titles || compareText(left.word, right.word));
}

// The search order: a word's titles times the hours since its last search, capped (a word not searched within the cap
// counts the cap). A word just searched waits behind the others until its score catches up, so the most shared words
// come back often and the rarest still come back. Ties go to the more shared word.
export function rankSearchTerms(
  vocabulary: VocabularyWord[],
  lastSearchedAt: ReadonlyMap<string, Date>,
  now: Date,
  capHours: number,
): VocabularyWord[] {
  const score = (entry: VocabularyWord) => {
    const searchedAt = lastSearchedAt.get(entry.word);
    const hours = searchedAt ? Math.max(0, (now.getTime() - searchedAt.getTime()) / 3_600_000) : capHours;
    return entry.titles * Math.min(hours, capHours);
  };
  return vocabulary
    .map((entry) => ({ entry, score: score(entry) }))
    .sort((left, right) => right.score - left.score || right.entry.titles - left.entry.titles || compareText(left.entry.word, right.entry.word))
    .map(({ entry }) => entry);
}

// The folded word of a searched term, keyed like titleVocabulary; the latest search of any spelling counts.
export function termSearchTimes(searched: ReadonlyMap<string, Date>): Map<string, Date> {
  const byWord = new Map<string, Date>();
  for (const [term, searchedAt] of searched) {
    const word = [...titleWords(term).keys()][0] ?? term.toLowerCase();
    const previous = byWord.get(word);
    if (!previous || searchedAt > previous) byWord.set(word, searchedAt);
  }
  return byWord;
}

// The words of a title, each folded word mapped to the form the title spells it in. Hyphens join words
// ("Steal-a-Brainrot"); a possessive or a plural folds into the word ("Egg's" and "Eggs" into "egg"), but a double s
// does not ("boss"). A plus and a number are a word of their own ("+1 Speed Every Second" formats), other numbers are
// not.
function titleWords(title: string): Map<string, string> {
  const words = new Map<string, string>();
  for (const token of normalizeTitle(title).toLowerCase().split(/[\s-]+/)) {
    if (/^\+\d+$/.test(token)) {
      if (!words.has(token)) words.set(token, token);
      continue;
    }
    const form = token.replace(/^['+]+|['+]+$/g, "").replace(/'s$/, "");
    const word = form.length >= 4 && form.endsWith("s") && !form.endsWith("ss") ? form.slice(0, -1) : form;
    if (word.length < 3 || !/\p{L}/u.test(word) || SEARCH_STOP_WORDS.has(word) || SEARCH_STOP_WORDS.has(form)) continue;
    if (!words.has(word)) words.set(word, form);
  }
  return words;
}

// The search runs on the commonest spelling, so a word folded by mistake ("chaos") is still searched as written. A
// tie goes to the shorter form: the singular over its plural.
function commonestForm(forms: Map<string, number>): string {
  const [[form]] = [...forms.entries()].sort(
    ([leftForm, left], [rightForm, right]) => right - left || leftForm.length - rightForm.length || compareText(leftForm, rightForm),
  );
  return form;
}

export interface ExploreDependencies {
  roblox: Pick<RobloxApi, "getSortContent" | "getRecommendations" | "searchGames">;
  // Measures the deadline only.
  clock?: () => number;
  // Tests read fewer countries; production takes JOB_CONFIG.explore.
  countries?: readonly string[];
}

interface Sighting {
  universeId: number;
  source: DiscoverySource;
  detail: string;
  playerCount: number;
}

interface EndpointOutcome {
  requests: number;
  failures: number;
  // Successful responses that listed no games: one is a quiet answer, all of them a format change.
  emptyResponses: number;
  // Games listed at or above the minimum CCU, tracked or not.
  sightings: number;
  rateLimited: boolean;
}

// One endpoint's requests. A failed request is logged and counted, and the next one runs, except after a rate limit
// that outlasted the client's retries: the next requests to the same endpoint would only extend it.
class Endpoint {
  readonly outcome: EndpointOutcome = { requests: 0, failures: 0, emptyResponses: 0, sightings: 0, rateLimited: false };

  constructor(
    private readonly source: DiscoverySource,
    private readonly minimumCcu: number,
  ) {}

  // The response and the games it listed at or above the minimum CCU, or null when the request failed.
  async request<T>(detail: string, call: () => Promise<T>, games: (response: T) => RobloxChartGame[]) {
    this.outcome.requests += 1;
    let response: T;
    try {
      response = await call();
    } catch (error) {
      this.outcome.failures += 1;
      logger.warn("Exploration request failed", { source: this.source, detail, error: errorMessage(error) });
      if (isRateLimited(error)) {
        this.outcome.rateLimited = true;
        logger.warn("Exploration rate limited; skipping the remaining requests", { source: this.source });
      }
      return null;
    }
    const listed = games(response);
    if (!listed.length) this.outcome.emptyResponses += 1;
    const sightings: Sighting[] = listed
      .filter((game) => game.playerCount >= this.minimumCcu)
      .map((game) => ({ universeId: game.universeId, source: this.source, detail, playerCount: game.playerCount }));
    this.outcome.sightings += sightings.length;
    return { response, sightings };
  }

  // An endpoint that answered no request with games is down or changed its format. Single failures stay isolated.
  get failed(): boolean {
    return this.outcome.requests > 0 && this.outcome.failures + this.outcome.emptyResponses === this.outcome.requests;
  }
}

// Sightings of tracked games are recorded as discoveries: they show how games relate, not only how they were first
// found. Untracked games join the promotion queue, which poll works through within the game details budget.
async function recordSightings(db: Database, sightings: Sighting[], seenAt: Date) {
  if (!sightings.length) return { discoveries: 0, queued: [] as number[] };
  const known = await knownUniverseIds(db, [...new Set(sightings.map((sighting) => sighting.universeId))]);
  const discoveries = await recordDiscoveries(
    db,
    sightings
      .filter((sighting) => known.has(sighting.universeId))
      .map(({ universeId, source, detail }) => ({ universeId, source, detail, firstSeenAt: seenAt, lastSeenAt: seenAt })),
  );
  const unknown = sightings.filter((sighting) => !known.has(sighting.universeId));
  await enqueueCandidates(db, unknown.map((sighting) => ({ ...sighting, seenAt })));
  return { discoveries, queued: unknown.map((sighting) => sighting.universeId) };
}

// Reads Up-and-Coming and Top Trending by country, then expands the recommendations of the young games and searches
// the words their titles share, until the deadline.
export function createExploreJob(dependencies: ExploreDependencies): JobDefinition {
  const config = JOB_CONFIG.explore;
  const clock = dependencies.clock ?? Date.now;
  return {
    name: "explore",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const startedMs = clock();
      const deadline = startedMs + config.deadlineMs;
      const pastDeadline = () => clock() > deadline;
      // When the run saw a game: `now` moved on by the time elapsed since the run started, so a sighting late in the
      // run is not dated 45 minutes early, and a replay of an earlier hour stays in it.
      const seenAt = () => new Date(now.getTime() + clock() - startedMs);
      const seeds = await selectExplorationSeeds(db, now, {
        count: config.seedCount,
        maximumAgeDays: config.seedMaximumAgeDays,
        windowHours: config.seedWindowHours,
        minimumCcu: config.seedMinimumCcu,
      });
      const vocabulary = titleVocabulary(
        seeds.map((seed) => seed.name),
        config.minimumTermTitles,
      );
      const searched = await lastSearchedTerms(db, new Date(now.getTime() - config.termRecencyCapHours * 3_600_000), now);
      const ranked = rankSearchTerms(vocabulary, termSearchTimes(searched), now, config.termRecencyCapHours);
      const httpBefore = getHttpRequestMetrics();
      let discoveries = 0;
      const queued = new Set<number>();
      const record = async (sightings: Sighting[]) => {
        const recorded = await recordSightings(db, sightings, seenAt());
        discoveries += recorded.discoveries;
        for (const universeId of recorded.queued) queued.add(universeId);
      };
      let stoppedByDeadline = false;
      // Whether another request may start on this endpoint; past the deadline, none may on any.
      const mayRequest = (endpoint: Endpoint) => {
        if (endpoint.outcome.rateLimited) return false;
        if (pastDeadline()) stoppedByDeadline = true;
        return !stoppedByDeadline;
      };

      // Sorts and search share apis.roblox.com, whose client waits out each search's one-minute window: sorts go first.
      const chart = new Endpoint("chart", config.minimumDiscoveryCcu);
      const countries = dependencies.countries ?? config.countries;
      for (const country of countries) {
        for (const sortId of config.countrySortIds) {
          if (!mayRequest(chart)) break;
          const answer = await chart.request(
            `${sortId}:${country}`,
            () => dependencies.roblox.getSortContent(sortId, country),
            (sort) => sort.games,
          );
          if (answer) await record(answer.sightings);
        }
      }

      // Recommendations and search run side by side: each is paced on its own endpoint (recommendations every 2.5 s,
      // search once a minute), so neither waits for the other. Every answer is recorded at once, so poll promotes what
      // the run finds while it goes on, and a run that times out keeps it.
      const recommendation = new Endpoint("recommendation", config.minimumDiscoveryCcu);
      const search = new Endpoint("search", config.minimumDiscoveryCcu);
      const terms: string[] = [];
      const recommend = async () => {
        for (const seed of seeds) {
          if (!mayRequest(recommendation)) break;
          const answer = await recommendation.request(
            String(seed.universeId),
            () => dependencies.roblox.getRecommendations(String(seed.universeId), config.recommendationsPerSeed),
            (games) => games,
          );
          if (answer) await record(answer.sightings);
        }
      };
      const searchTerms = async () => {
        for (const { term } of ranked) {
          let pageToken: string | undefined;
          for (let page = 0; page < config.searchPagesPerTerm; page += 1) {
            if (!mayRequest(search)) return;
            const answer = await search.request(
              term,
              () => dependencies.roblox.searchGames(term, pageToken),
              (result) => result.games,
            );
            if (!answer) break;
            if (page === 0) terms.push(term);
            await record(answer.sightings);
            if (!answer.response.nextPageToken) break;
            pageToken = answer.response.nextPageToken;
          }
        }
      };
      await Promise.all([recommend(), searchTerms()]);

      const rateLimited = chart.outcome.rateLimited || recommendation.outcome.rateLimited || search.outcome.rateLimited;
      const degraded = chart.failed || recommendation.failed || search.failed || rateLimited;
      return {
        status: degraded ? "degraded" : "success",
        stats: {
          seeds: seeds.length,
          vocabulary: vocabulary.length,
          // The terms whose first page answered this run: the next runs rank the terms by when they were searched.
          terms,
          chart: chart.outcome,
          recommendation: recommendation.outcome,
          search: search.outcome,
          rateLimited,
          stoppedBy: stoppedByDeadline ? "deadline" : null,
          // Untracked games found this run, queued for promotion by poll.
          queued: queued.size,
          discoveries,
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
