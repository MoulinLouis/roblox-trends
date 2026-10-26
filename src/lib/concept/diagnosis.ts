import { CONCEPT_CHECK_CONFIG } from "@/lib/config";
import type { ConceptAttempt, ConceptSummary, DiagnosisLabel } from "./types";

const dayMs = 24 * 60 * 60 * 1000;

type DiagnosisRules = typeof CONCEPT_CHECK_CONFIG.diagnosis;

// Plain rules, printed with their thresholds beside the report: no score. The leader is the attempt with the most
// players, or the most visits when none has any; it may also be fading, but is never "liked but stuck".
export function diagnose(attempts: ConceptAttempt[], rules: DiagnosisRules = CONCEPT_CHECK_CONFIG.diagnosis): ConceptAttempt[] {
  const leader = [...attempts].sort(
    (left, right) => right.playing - left.playing || right.visits - left.visits || left.universeId - right.universeId,
  )[0];
  return attempts.map((attempt) => {
    const labels: DiagnosisLabel[] = [];
    const isLeader = attempt === leader;
    if (isLeader) labels.push("leader");
    const peak = attempt.history?.peakCcu ?? null;
    if (peak !== null && peak >= rules.fadingMinimumPeakCcu && attempt.playing <= peak * rules.fadingMaximumShareOfPeak) {
      labels.push("fading");
    }
    const liked =
      !isLeader &&
      attempt.likeRatio !== null &&
      attempt.upVotes + attempt.downVotes >= rules.likedMinimumVotes &&
      attempt.likeRatio >= rules.likedMinimumRatio &&
      attempt.playing < rules.stuckMaximumPlayers &&
      attempt.visits < rules.stuckMaximumVisits;
    if (liked) labels.push("liked but stuck");
    else if (attempt.visits < rules.noAudienceMaximumVisits) labels.push("no audience");
    return { ...attempt, labels };
  });
}

export function compareByCreation(left: ConceptAttempt, right: ConceptAttempt): number {
  return left.created.getTime() - right.created.getTime() || left.universeId - right.universeId;
}

export function summarize(
  attempts: ConceptAttempt[],
  counts: { hidden: number; unavailable: number },
  now: Date,
  recentDays: number = CONCEPT_CHECK_CONFIG.recentDays,
): ConceptSummary {
  const byCreation = [...attempts].sort(compareByCreation);
  const first = byCreation[0];
  const leader = attempts.find((attempt) => attempt.labels.includes("leader"));
  const recentSince = now.getTime() - recentDays * dayMs;
  return {
    attempts: attempts.length,
    hidden: counts.hidden,
    unavailable: counts.unavailable,
    firstAttempt: first ? { universeId: first.universeId, name: first.name, created: first.created } : null,
    leader: leader
      ? { universeId: leader.universeId, name: leader.name, playing: leader.playing, visits: leader.visits, fading: leader.labels.includes("fading") }
      : null,
    recent: byCreation
      .filter((attempt) => attempt.created.getTime() >= recentSince)
      .map((attempt) => ({ universeId: attempt.universeId, name: attempt.name, created: attempt.created })),
  };
}
