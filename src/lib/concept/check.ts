import type { RobloxApi } from "@/lib/api/roblox";
import { CONCEPT_CHECK_CONFIG } from "@/lib/config";
import { errorMessage } from "@/lib/logger";
import { compareByCreation, diagnose, summarize } from "./diagnosis";
import { isRelevant, relevanceWords } from "./relevance";
import type { ConceptAttempt, ConceptHistory, ConceptReport, HistoryStatus } from "./types";

const dayMs = 24 * 60 * 60 * 1000;

export interface ConceptCheckDependencies {
  api: Pick<RobloxApi, "searchGames" | "getGameDetails" | "getGameVotes">;
  // Absent when no database is configured; a rejection becomes { status: "failed" }, never an exception.
  readHistory?: (universeIds: number[], since: Date) => Promise<Map<number, ConceptHistory>>;
  // Why readHistory is absent, shown in the report.
  historySkippedReason?: string;
  now: Date;
}

// Searches each phrase, then reads the details and votes of every result once. A failed search is reported and the
// other phrases go on; failed details or votes reject the check, which has nothing to show without them.
export async function runConceptCheck(
  phrases: string[],
  dependencies: ConceptCheckDependencies,
  config = CONCEPT_CHECK_CONFIG,
): Promise<ConceptReport> {
  const { api, now } = dependencies;
  const matchedPhrases = new Map<number, string[]>();
  const failures: ConceptReport["failures"] = [];
  for (const phrase of phrases) {
    try {
      let pageToken: string | undefined;
      for (let page = 0; page < config.searchPagesPerPhrase; page += 1) {
        const result = await api.searchGames(phrase, pageToken);
        for (const game of result.games) {
          const matched = matchedPhrases.get(game.universeId) ?? [];
          if (!matched.includes(phrase)) matched.push(phrase);
          matchedPhrases.set(game.universeId, matched);
        }
        if (!result.nextPageToken) break;
        pageToken = result.nextPageToken;
      }
    } catch (error) {
      failures.push({ phrase, error: errorMessage(error) });
    }
  }

  const ids = [...matchedPhrases.keys()].map(String);
  const details = ids.length ? (await api.getGameDetails(ids)).filter((detail) => matchedPhrases.has(detail.id)) : [];
  const votes = new Map((ids.length ? await api.getGameVotes(ids) : []).map((vote) => [vote.id, vote]));
  // A phrase with no usable word (a two-letter word, another script) cannot tell results apart: every one is kept.
  const words = relevanceWords(phrases);
  const relevant = details.filter((detail) => words.size === 0 || isRelevant(detail, words));
  let attempts: ConceptAttempt[] = relevant.map((detail) => {
    const upVotes = votes.get(detail.id)?.upVotes ?? 0;
    const downVotes = votes.get(detail.id)?.downVotes ?? 0;
    return {
      universeId: detail.id,
      name: detail.name,
      description: detail.description,
      creatorName: detail.creator.name,
      created: detail.created,
      updated: detail.updated,
      visits: detail.visits,
      playing: detail.playing,
      favorites: detail.favoritedCount,
      upVotes,
      downVotes,
      likeRatio: upVotes + downVotes ? upVotes / (upVotes + downVotes) : null,
      matchedPhrases: matchedPhrases.get(detail.id) ?? [],
      history: null,
      labels: [],
    };
  });

  let history: HistoryStatus;
  if (!dependencies.readHistory) {
    history = { status: "skipped", reason: dependencies.historySkippedReason ?? "no database configured" };
  } else {
    try {
      const since = new Date(now.getTime() - config.historyDays * dayMs);
      const tracked = attempts.length ? await dependencies.readHistory(attempts.map((attempt) => attempt.universeId), since) : new Map();
      attempts = attempts.map((attempt) => ({ ...attempt, history: tracked.get(attempt.universeId) ?? null }));
      history = { status: "read" };
    } catch (error) {
      history = { status: "failed", error: errorMessage(error) };
    }
  }

  attempts = diagnose(attempts, config.diagnosis).sort(compareByCreation);
  const counts = { hidden: details.length - relevant.length, unavailable: ids.length - details.length };
  return {
    phrases,
    checkedAt: now,
    attempts,
    summary: summarize(attempts, counts, now, config.recentDays),
    failures,
    history,
  };
}
