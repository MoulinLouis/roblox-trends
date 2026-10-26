import { describe, expect, it } from "vitest";
import { formatConceptReport } from "./report";
import type { ConceptAttempt, ConceptReport } from "./types";

function attempt(universeId: number, name: string, created: string, values: Partial<ConceptAttempt>): ConceptAttempt {
  const upVotes = values.upVotes ?? 0;
  const downVotes = values.downVotes ?? 0;
  return {
    universeId,
    name,
    description: "",
    creatorName: "Studio",
    created: new Date(`${created}T00:00:00Z`),
    updated: new Date("2026-10-20T00:00:00Z"),
    visits: 0,
    playing: 0,
    favorites: 0,
    upVotes,
    downVotes,
    likeRatio: upVotes + downVotes ? upVotes / (upVotes + downVotes) : null,
    matchedPhrases: ["stone skipping"],
    history: null,
    labels: [],
    ...values,
  };
}

const rock = attempt(1, "Skip a Rock!", "2026-01-05", { visits: 37_605, upVotes: 75, downVotes: 33 });
const stone = attempt(3, "Skip a Stone!", "2026-09-02", { visits: 9_308, upVotes: 21, downVotes: 3, labels: ["liked but stuck"] });
const owner = attempt(4, "+1 Stone Skipping", "2026-09-05", {
  creatorName: "Meow Labs",
  visits: 67_362_222,
  playing: 17_579,
  favorites: 2_135_833,
  upVotes: 90_073,
  downVotes: 3_057,
  labels: ["leader"],
  history: {
    firstObservedAt: new Date("2026-09-25T00:00:00Z"),
    peakCcu: 41_000,
    peakDay: new Date("2026-10-12T00:00:00Z"),
    daily: [],
    earlierNames: ["Stone Skipping"],
    sources: ["chart"],
  },
});

const report: ConceptReport = {
  phrases: ["stone skipping", "skip stones"],
  checkedAt: new Date("2026-10-26T18:00:00Z"),
  attempts: [rock, stone, owner],
  summary: {
    attempts: 3,
    hidden: 40,
    unavailable: 1,
    firstAttempt: { universeId: 1, name: "Skip a Rock!", created: rock.created },
    leader: {
      universeId: 4,
      name: "+1 Stone Skipping",
      playing: 17_579,
      visits: 67_362_222,
      fading: false,
      peakCcu: 41_000,
      peakDay: new Date("2026-10-12T00:00:00Z"),
    },
    recent: [],
  },
  failures: [],
  history: { status: "skipped", reason: "DATABASE_URL is not set" },
};

describe("formatConceptReport", () => {
  const text = formatConceptReport(report);

  it.each([
    'Concept check: "stone skipping", "skip stones"',
    "3 attempts (40 unrelated results hidden, 1 unavailable)",
    "First attempt: Skip a Rock! (2026-01-05)",
    "Leader: +1 Stone Skipping, 17,579 playing, 67,362,222 visits, tracked peak 41,000 on 2026-10-12",
    "Renamed:\n  +1 Stone Skipping: was Stone Skipping",
    "History: not read (DATABASE_URL is not set)",
    "no audience: under 10,000 visits and 100 playing",
    "liked but stuck: at least 85% likes on 20 or more votes, under 100 playing and 1,000,000 visits",
    "fading: playing at most 10% of a tracked peak of 1,000 or more",
    "leader: most playing, or most visits when none plays",
  ])("prints %s", (line) => {
    expect(text).toContain(line);
  });

  it("lists the attempts in creation order with their numbers", () => {
    const rows = text.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2} /.test(line));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^2026-01-05 +Skip a Rock! .* 37,605 .* 69% \(108\)/);
    expect(rows[1]).toMatch(/^2026-09-02 +Skip a Stone! .* 88% \(24\) .*liked but stuck/);
    expect(rows[2]).toMatch(/^2026-09-05 +\+1 Stone Skipping .*Meow Labs .* 67,362,222 .* 17,579 .* 2026-09-25 .* 41,000 .*leader/);
    expect(rows[0]).toContain("—");
  });

  it("says when nothing was found and which searches failed", () => {
    const empty = formatConceptReport({
      ...report,
      attempts: [],
      summary: { ...report.summary, attempts: 0, hidden: 0, unavailable: 0, firstAttempt: null, leader: null },
      failures: [{ phrase: "x", error: "HTTP 429" }],
      history: { status: "read" },
    });
    expect(empty).toContain("No attempt found");
    expect(empty).toContain('Search failed for "x": HTTP 429');
    expect(empty).not.toContain("First attempt");
  });

  it("leaves the tracked peak out of a leader the radar does not track", () => {
    const untracked = formatConceptReport({ ...report, summary: { ...report.summary, leader: { ...report.summary.leader!, peakCcu: null, peakDay: null } } });
    expect(untracked).toContain("Leader: +1 Stone Skipping, 17,579 playing, 67,362,222 visits\n");
  });
});
