import { selectRisingSeeds } from "@/db/explore";
import { getHttpRequestMetrics } from "@/lib/api/http";
import type { RobloxApi, RobloxChartGame } from "@/lib/api/roblox";
import { compareText } from "@/lib/arrays";
import { JOB_CONFIG } from "@/lib/config";
import { errorMessage, logger } from "@/lib/logger";
import { normalizeTitle } from "@/lib/title";
import { httpMetricsSince, isRateLimited } from "./batching";
import { PromotionApiError, promoteUniverses, type PromotionCandidate } from "./promotion";
import type { JobDefinition } from "./runner";

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
  "game",
  "games",
  "roblox",
  "simulator",
  "obby",
  "tycoon",
  "update",
  "new",
]);

// The words that rising games share are the vocabulary of what is trending now. A word counts once per title, and
// among several titles it must be shared by at least two.
export function selectSearchTerms(titles: string[], count: number): string[] {
  const frequency = new Map<string, number>();
  for (const title of titles) {
    const tokens = new Set(
      normalizeTitle(title)
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^['+-]+|['+-]+$/g, ""))
        .filter((token) => token.length >= 3 && /\p{L}/u.test(token) && !SEARCH_STOP_WORDS.has(token)),
    );
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  const minimumOccurrences = titles.length > 1 ? 2 : 1;
  return [...frequency.entries()]
    .filter(([, occurrences]) => occurrences >= minimumOccurrences)
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, count)
    .map(([term]) => term);
}

export interface ExploreDependencies {
  roblox: Pick<RobloxApi, "getRecommendations" | "searchGames" | "getGameDetails">;
}

interface ExplorationOutcome {
  candidates: PromotionCandidate[];
  requests: number;
  failures: number;
  // Requests not made because an earlier one was rate limited.
  skipped: number;
  rateLimited: boolean;
}

// One request per detail (a seed or a search term). A failed request is logged and the next one runs, except after a
// rate limit that outlasted the client's retries: the next requests to the same endpoint would only extend it.
async function exploreEndpoint(
  source: "recommendation" | "search",
  details: string[],
  minimumCcu: number,
  request: (detail: string) => Promise<RobloxChartGame[]>,
): Promise<ExplorationOutcome> {
  const outcome: ExplorationOutcome = { candidates: [], requests: 0, failures: 0, skipped: 0, rateLimited: false };
  for (const [index, detail] of details.entries()) {
    outcome.requests += 1;
    try {
      for (const game of await request(detail)) {
        if (game.playerCount >= minimumCcu) outcome.candidates.push({ universeId: game.universeId, source, detail });
      }
    } catch (error) {
      outcome.failures += 1;
      logger.warn("Exploration request failed", { source, detail, error: errorMessage(error) });
      if (isRateLimited(error)) {
        outcome.rateLimited = true;
        outcome.skipped = details.length - index - 1;
        logger.warn("Exploration rate limited; skipping the remaining requests", { source, skipped: outcome.skipped });
        break;
      }
    }
  }
  return outcome;
}

// Expands the recommendations of rising young games and searches the words their titles share. Discoveries of games
// already tracked are recorded too: they show how games relate, not only how they were first found.
export function createExploreJob(dependencies: ExploreDependencies): JobDefinition {
  const config = JOB_CONFIG.explore;
  return {
    name: "explore",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      const seeds = await selectRisingSeeds(db, now, config.seedCount, config.seedMaximumAgeDays);
      const terms = selectSearchTerms(seeds.map((seed) => seed.name), config.searchTermCount);
      const httpBefore = getHttpRequestMetrics();
      // Recommendations and search are separate endpoints, so a rate limit on one does not stop the other.
      const outcomes = [
        await exploreEndpoint(
          "recommendation",
          seeds.map((seed) => String(seed.universeId)),
          config.minimumDiscoveryCcu,
          (seed) => dependencies.roblox.getRecommendations(seed, config.recommendationsPerSeed),
        ),
        await exploreEndpoint("search", terms, config.minimumDiscoveryCcu, (term) => dependencies.roblox.searchGames(term)),
      ];
      const candidates = outcomes.flatMap((outcome) => outcome.candidates);
      const rateLimited = outcomes.some((outcome) => outcome.rateLimited);
      let promoted = 0;
      let discoveries = 0;
      let promotionError: string | undefined;
      try {
        ({ promoted, discoveries } = await promoteUniverses(db, dependencies.roblox, candidates, now, { recordKnown: true }));
      } catch (error) {
        // Only a Games API failure is tolerated; a database error fails the run. The message already includes the cause.
        if (!(error instanceof PromotionApiError)) throw error;
        promotionError = error.message;
        logger.error("Exploration promotion failed; retrying next run", { error: promotionError });
      }
      // One failed request is isolated; an endpoint that failed every request is down or changed its format.
      const endpointFailed = outcomes.some((outcome) => outcome.requests > 0 && outcome.failures === outcome.requests);
      return {
        status: endpointFailed || rateLimited || promotionError !== undefined ? "degraded" : "success",
        stats: {
          seeds: seeds.length,
          terms,
          requests: sum(outcomes, (outcome) => outcome.requests),
          failures: sum(outcomes, (outcome) => outcome.failures),
          skippedRequests: sum(outcomes, (outcome) => outcome.skipped),
          rateLimited,
          candidates: candidates.length,
          promoted,
          discoveries,
          promotionError,
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
