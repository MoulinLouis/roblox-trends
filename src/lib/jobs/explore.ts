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

// The words that rising games share are the vocabulary of what is trending now. A word counts once per title and
// must be shared by `minimumTitles` titles; when fewer titles are available, one is enough.
export function selectSearchTerms(titles: string[], count: number, minimumTitles: number): string[] {
  const words = new Map<string, { titles: number; forms: Map<string, number> }>();
  for (const title of titles) {
    for (const [word, form] of titleWords(title)) {
      const entry = words.get(word) ?? { titles: 0, forms: new Map<string, number>() };
      entry.titles += 1;
      entry.forms.set(form, (entry.forms.get(form) ?? 0) + 1);
      words.set(word, entry);
    }
  }
  const minimumOccurrences = titles.length >= minimumTitles ? minimumTitles : 1;
  return [...words.entries()]
    .filter(([, entry]) => entry.titles >= minimumOccurrences)
    .sort(([leftWord, left], [rightWord, right]) => right.titles - left.titles || compareText(leftWord, rightWord))
    .slice(0, count)
    .map(([, entry]) => commonestForm(entry.forms));
}

// The words of a title, each folded word mapped to the form the title spells it in. Hyphens join words
// ("Steal-a-Brainrot"); a possessive or a plural folds into the word ("Egg's" and "Eggs" into "egg"), but a double s
// does not ("boss").
function titleWords(title: string): Map<string, string> {
  const words = new Map<string, string>();
  for (const token of normalizeTitle(title).toLowerCase().split(/[\s-]+/)) {
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
  roblox: Pick<RobloxApi, "getRecommendations" | "searchGames" | "getGameDetails">;
}

interface EndpointOutcome {
  candidates: PromotionCandidate[];
  requests: number;
  failures: number;
  // Successful responses that listed no games: one is a quiet answer, all of them a format change.
  emptyResponses: number;
  // Requests not made because an earlier one was rate limited.
  skippedRequests: number;
  rateLimited: boolean;
}

// One request per detail (a seed or a search term). A failed request is logged and the next one runs, except after a
// rate limit that outlasted the client's retries: the next requests to the same endpoint would only extend it.
async function exploreEndpoint(
  source: "recommendation" | "search",
  details: string[],
  minimumCcu: number,
  request: (detail: string) => Promise<RobloxChartGame[]>,
): Promise<EndpointOutcome> {
  const outcome: EndpointOutcome = { candidates: [], requests: 0, failures: 0, emptyResponses: 0, skippedRequests: 0, rateLimited: false };
  for (const [index, detail] of details.entries()) {
    outcome.requests += 1;
    let listed: RobloxChartGame[];
    try {
      listed = await request(detail);
    } catch (error) {
      outcome.failures += 1;
      logger.warn("Exploration request failed", { source, detail, error: errorMessage(error) });
      if (isRateLimited(error)) {
        outcome.rateLimited = true;
        outcome.skippedRequests = details.length - index - 1;
        logger.warn("Exploration rate limited; skipping the remaining requests", { source, skipped: outcome.skippedRequests });
        break;
      }
      continue;
    }
    if (!listed.length) outcome.emptyResponses += 1;
    for (const game of listed) {
      if (game.playerCount >= minimumCcu) outcome.candidates.push({ universeId: game.universeId, source, detail });
    }
  }
  return outcome;
}

// An endpoint that answered no request with games is down or changed its format. Single failures stay isolated.
function endpointFailed(outcome: EndpointOutcome): boolean {
  return outcome.requests > 0 && outcome.failures + outcome.emptyResponses === outcome.requests;
}

function endpointStats({ candidates, ...stats }: EndpointOutcome) {
  return { ...stats, candidates: candidates.length };
}

// Expands the recommendations of rising young games and searches the words shared by the titles of a wider set of
// them. Discoveries of games already tracked are recorded too: they show how games relate, not only how they were
// first found.
export function createExploreJob(dependencies: ExploreDependencies): JobDefinition {
  const config = JOB_CONFIG.explore;
  return {
    name: "explore",
    intervalMinutes: config.intervalMinutes,
    timeoutMs: config.timeoutMs,
    async run({ db, now }) {
      // One query serves both: the top seeds for recommendations, every returned title for search terms.
      const rising = await selectRisingSeeds(db, now, {
        count: Math.max(config.seedCount, config.termTitleCount),
        maximumAgeDays: config.seedMaximumAgeDays,
        currentWindowHours: config.currentWindowHours,
        previousWindowOffsetHours: config.previousWindowOffsetHours,
        smoothingCcu: config.seedSmoothingCcu,
        minimumCurrentCcu: config.seedMinimumCurrentCcu,
      });
      const seeds = rising.slice(0, config.seedCount);
      const titles = rising.slice(0, config.termTitleCount).map((game) => game.name);
      const terms = selectSearchTerms(titles, config.searchTermCount, config.minimumTermTitles);
      const httpBefore = getHttpRequestMetrics();
      // Recommendations and search are separate endpoints, so a rate limit on one does not stop the other.
      const recommendation = await exploreEndpoint(
        "recommendation",
        seeds.map((seed) => String(seed.universeId)),
        config.minimumDiscoveryCcu,
        (seed) => dependencies.roblox.getRecommendations(seed, config.recommendationsPerSeed),
      );
      const search = await exploreEndpoint("search", terms, config.minimumDiscoveryCcu, (term) => dependencies.roblox.searchGames(term));
      const candidates = [...recommendation.candidates, ...search.candidates];
      const rateLimited = recommendation.rateLimited || search.rateLimited;
      let promoted = 0;
      let discoveries = 0;
      let promotionError: string | undefined;
      let promotionSkipped: "rateLimited" | undefined;
      if (recommendation.rateLimited) {
        // The Games API shares the recommendations host, which is still rate limited; the next run finds these again.
        promotionSkipped = "rateLimited";
        logger.warn("Exploration promotion skipped: the Games API host is rate limited", { candidates: candidates.length });
      } else {
        try {
          ({ promoted, discoveries } = await promoteUniverses(db, dependencies.roblox, candidates, now, { recordKnown: true }));
        } catch (error) {
          // Only a Games API failure is tolerated; a database error fails the run. The message already includes the cause.
          if (!(error instanceof PromotionApiError)) throw error;
          promotionError = error.message;
          logger.error("Exploration promotion failed; retrying next run", { error: promotionError });
        }
      }
      const degraded =
        endpointFailed(recommendation) || endpointFailed(search) || rateLimited || promotionError !== undefined || promotionSkipped !== undefined;
      return {
        status: degraded ? "degraded" : "success",
        stats: {
          seeds: seeds.length,
          titles: titles.length,
          terms,
          recommendation: endpointStats(recommendation),
          search: endpointStats(search),
          rateLimited,
          promotionRequested: new Set(candidates.map((candidate) => candidate.universeId)).size,
          promoted,
          discoveries,
          promotionError,
          promotionSkipped,
          http: httpMetricsSince(httpBefore),
        },
      };
    },
  };
}
