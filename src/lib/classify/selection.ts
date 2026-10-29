import { titleKey } from "@/lib/fingerprint";
import type { ClassifiedGame } from "./types";

// A tracked game with what the radar knows of its classifications (src/db/classifications.ts).
export interface ClassificationCandidate extends ClassifiedGame {
  lastCcu: number;
  pending: boolean;
  // The latest successful classification, or null.
  classified: { name: string; promptVersion: number } | null;
  // Failures since the latest success, oldest first.
  failures: { name: string; finishedAt: Date }[];
}

export type SelectionReason = "new" | "retitled" | "outdated";

export interface SelectionOptions {
  now: Date;
  limit: number;
  minimumPromptVersion: number;
  retryFailedAfterHours: number;
  maximumFailedAttempts: number;
}

export interface Selection {
  games: ClassifiedGame[];
  // Every game due, before the limit, by reason; and the games held back by their failures.
  counts: Record<SelectionReason | "waitingRetry" | "givenUp", number>;
}

const order: Record<SelectionReason, number> = { new: 0, retitled: 1, outdated: 2 };

export function selectGamesToClassify(candidates: readonly ClassificationCandidate[], options: SelectionOptions): Selection {
  const counts: Selection["counts"] = { new: 0, retitled: 0, outdated: 0, waitingRetry: 0, givenUp: 0 };
  const due: { candidate: ClassificationCandidate; reason: SelectionReason }[] = [];
  for (const candidate of candidates) {
    if (candidate.pending) continue;
    const reason = dueReason(candidate, options.minimumPromptVersion);
    if (reason === null) continue;
    // Only failures under the current title count: a new title deserves a fresh try.
    const key = titleKey(candidate.name);
    const failures = candidate.failures.filter((failure) => titleKey(failure.name) === key);
    if (failures.length >= options.maximumFailedAttempts) {
      counts.givenUp += 1;
      continue;
    }
    const lastFailure = failures.at(-1);
    if (lastFailure && options.now.getTime() - lastFailure.finishedAt.getTime() < options.retryFailedAfterHours * 3_600_000) {
      counts.waitingRetry += 1;
      continue;
    }
    counts[reason] += 1;
    due.push({ candidate, reason });
  }
  due.sort(
    (left, right) =>
      order[left.reason] - order[right.reason] ||
      right.candidate.lastCcu - left.candidate.lastCcu ||
      left.candidate.universeId - right.candidate.universeId,
  );
  const games = due.slice(0, options.limit).map(({ candidate }) => ({
    universeId: candidate.universeId,
    name: candidate.name,
    description: candidate.description,
    genre: candidate.genre,
    thumbnailUrl: candidate.thumbnailUrl,
  }));
  return { games, counts };
}

function dueReason(candidate: ClassificationCandidate, minimumPromptVersion: number): SelectionReason | null {
  if (candidate.classified === null) return "new";
  if (titleKey(candidate.classified.name) !== titleKey(candidate.name)) return "retitled";
  if (candidate.classified.promptVersion < minimumPromptVersion) return "outdated";
  return null;
}
