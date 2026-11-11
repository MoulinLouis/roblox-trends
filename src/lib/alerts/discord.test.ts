import { describe, expect, it, vi } from "vitest";
import { ALERT_CONFIG } from "../config";
import {
  alertEvidence,
  DiscordError,
  digestMessage,
  postDiscord,
  waveMessage,
  type AlertEvidence,
  type DiscordMessage,
} from "./discord";
import type { AlertDecision, CardFacts } from "./types";

function facts(overrides: Partial<CardFacts> = {}): CardFacts {
  return {
    name: "Ragdoll Physics Simulator",
    rootPlaceId: 111,
    thumbnailUrl: "https://tr.rbxcdn.com/thumb.png",
    robloxCreatedAt: new Date("2026-11-03T10:00:00Z"),
    crossedAt: new Date("2026-11-10T14:00:00Z"),
    lastCcu: 2_345,
    ccuDayBefore: 410,
    likeRatio: 0.87,
    family: "simulator",
    template: "simulator",
    rewardLoop: "collect and upgrade",
    coreAction: "ragdoll",
    peakCcu: 3_000,
    ...overrides,
  };
}

const decision: AlertDecision = {
  kind: "wave",
  universeId: 1,
  keys: ["action:simulator|ragdoll", "word:ragdoll", "word:physic"],
  priors: {
    "action:simulator|ragdoll": [2, 3],
    "word:ragdoll": [2],
    "word:physic": [],
  },
};

function evidence(
  id = 1,
  overrides: Partial<CardFacts> = {},
  d: Partial<AlertDecision> = {},
): AlertEvidence {
  const map = new Map<number, CardFacts>([
    [id, facts({ ...overrides })],
    [
      2,
      facts({
        name: "Ragdoll Launch",
        rootPlaceId: 222,
        crossedAt: new Date("2026-11-05T00:00:00Z"),
        peakCcu: 8_000,
        robloxCreatedAt: new Date("2026-11-01T00:00:00Z"),
      }),
    ],
    [
      3,
      facts({
        name: "Rag Tower",
        rootPlaceId: 333,
        crossedAt: new Date("2026-11-07T00:00:00Z"),
        peakCcu: 1_500,
      }),
    ],
  ]);
  return alertEvidence({ ...decision, universeId: id, ...d }, map, {
    "action:simulator|ragdoll": { tracked: 12, recent: 5 },
    "word:ragdoll": { tracked: 4, recent: 3 },
    "word:physic": { tracked: 2, recent: 1 },
  });
}

function allText(message: DiscordMessage): string {
  const parts: string[] = [message.content ?? ""];
  for (const e of message.embeds) {
    parts.push(e.title ?? "", e.description ?? "", e.footer?.text ?? "");
    for (const f of e.fields ?? []) parts.push(f.name, f.value);
  }
  return parts.join("\n");
}

function totalCharacters(message: DiscordMessage): number {
  let total = 0;
  for (const e of message.embeds) {
    total +=
      (e.title ?? "").length +
      (e.description ?? "").length +
      (e.footer?.text ?? "").length;
    for (const f of e.fields ?? []) total += f.name.length + f.value.length;
  }
  return total;
}

function checkLimits(message: DiscordMessage) {
  expect(message.allowed_mentions).toEqual({ parse: [] });
  expect(message.embeds.length).toBeLessThanOrEqual(10);
  expect(totalCharacters(message)).toBeLessThanOrEqual(6_000);
  for (const e of message.embeds) {
    expect((e.title ?? "").length).toBeLessThanOrEqual(256);
    expect((e.description ?? "").length).toBeLessThanOrEqual(4_096);
    expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
    for (const f of e.fields ?? []) {
      expect(f.name.length).toBeLessThanOrEqual(256);
      expect(f.value.length).toBeLessThanOrEqual(1_024);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.value.length).toBeGreaterThan(0);
    }
  }
}

const BANNED = [
  "go",
  "opportunity",
  "score",
  "recommend",
  "recommended",
  "should",
  "winner",
  "best",
];

describe("alertEvidence", () => {
  it("holds the candidate, each key with its priors and counts, and the concept command", () => {
    const e = evidence();
    expect(e.game.name).toBe("Ragdoll Physics Simulator");
    expect(e.game.crossedAt).toBe("2026-11-10T14:00:00.000Z");
    const action = e.keys.find((k) => k.key === "action:simulator|ragdoll")!;
    expect(action.trackedGames).toBe(12);
    expect(action.recentGames).toBe(5);
    expect(action.priors.map((p) => p.name)).toEqual([
      "Ragdoll Launch",
      "Rag Tower",
    ]);
    expect(action.priors[0]).toMatchObject({
      crossedAt: "2026-11-05T00:00:00.000Z",
      peakCcu: 8_000,
      ageDays: 4,
    });
    expect(e.conceptCommand).toBe(
      'npm run concept -- "ragdoll physics" "ragdoll"',
    );
  });

  it("does not repeat a core action equal to the title words", () => {
    const e = alertEvidence(
      {
        ...decision,
        keys: ["action:simulator|ragdoll", "word:ragdoll"],
        priors: {},
      },
      new Map([[1, facts({ name: "Ragdoll" })]]),
      {},
    );
    expect(e.conceptCommand).toBe('npm run concept -- "ragdoll"');
  });

  it("tolerates a prior missing from the facts", () => {
    const e = alertEvidence(
      { ...decision, priors: { "word:ragdoll": [99] } },
      new Map([[1, facts()]]),
      {},
    );
    expect(e.keys.find((k) => k.key === "word:ragdoll")!.priors).toEqual([
      {
        universeId: 99,
        name: null,
        crossedAt: null,
        peakCcu: null,
        ageDays: null,
      },
    ]);
    const text = allText(waveMessage(e));
    expect(text).toContain("99");
  });

  it("strips double quotes from the concept phrases", () => {
    const e = alertEvidence(
      {
        kind: "first_breakout",
        universeId: 1,
        keys: ["word:say"],
        priors: { "word:say": [] },
      },
      new Map([
        [1, facts({ name: 'Say "Say" Hello', coreAction: 'the "x" thing' })],
      ]),
      {},
    );
    expect(e.conceptCommand).not.toMatch(/""|\\"/);
    expect(e.conceptCommand!.match(/"/g)!.length % 2).toBe(0);
  });
});

describe("waveMessage", () => {
  it("renders one embed with the linked title, thumbnail and fields", () => {
    const m = waveMessage(evidence());
    checkLimits(m);
    expect(m.embeds).toHaveLength(1);
    const embed = m.embeds[0];
    expect(embed.title).toBe("Ragdoll Physics Simulator");
    expect(embed.url).toBe("https://www.roblox.com/games/111");
    expect(embed.thumbnail?.url).toBe("https://tr.rbxcdn.com/thumb.png");
    expect(embed.timestamp).toBe("2026-11-10T14:00:00.000Z");
    const fields = embed.fields!;
    const trajectory = fields.find((f) => f.name === "Trajectory")!;
    expect(trajectory.value).toContain("2,345");
    expect(trajectory.value).toContain("2026-11-10 14:00 UTC");
    expect(trajectory.value).toContain("410");
    expect(fields.find((f) => f.name === "Format")!.value).toContain(
      "simulator",
    );
    const key = fields.find(
      (f) => f.name.includes("ragdoll") && f.name.startsWith("Gameplay"),
    )!;
    expect(key.value).toContain("Ragdoll Launch");
    expect(key.value).toContain("8,000");
    expect(key.value).toContain("2026-11-05 UTC");
    expect(key.value).toContain(
      "12 tracked games, 5 created in the last 14 days",
    );
    expect(
      fields.some((f) =>
        f.value.includes('npm run concept -- "ragdoll physics" "ragdoll"'),
      ),
    ).toBe(true);
  });

  it("says when a key has no earlier breakout", () => {
    const text = allText(waveMessage(evidence()));
    expect(text).toContain("No earlier breakout");
  });

  it("makes no verdict", () => {
    const text = allText(waveMessage(evidence()));
    for (const word of BANNED)
      expect(text).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  });

  it("renders the same from the evidence read back from JSON", () => {
    const e = evidence();
    const back = JSON.parse(JSON.stringify(e)) as AlertEvidence;
    expect(waveMessage(back)).toEqual(waveMessage(e));
    expect(digestMessage([back])).toEqual(digestMessage([e]));
  });

  it("never pings and stays inside the limits with a hostile, long name", () => {
    const name = `@everyone ${"x".repeat(600)}`;
    const m = waveMessage(evidence(1, { name }));
    checkLimits(m);
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });

  it("stays inside the limits with many keys and priors", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `word:longword${i}`);
    const priors = Object.fromEntries(
      keys.map((k) => [k, [2, 3, 2, 3, 2, 3, 2, 3]]),
    );
    const map = new Map([
      [1, facts({ name: "L".repeat(300) })],
      [2, facts({ name: "P".repeat(300) })],
      [3, facts({ name: "Q".repeat(300) })],
    ]);
    const e = alertEvidence(
      { kind: "wave", universeId: 1, keys, priors },
      map,
      {},
    );
    checkLimits(waveMessage(e));
  });
});

describe("digestMessage", () => {
  it("gives 10 embeds, most CCU first, and 'and 2 more' for 12", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      evidence(1, {
        name: `Game ${i}`,
        lastCcu: 1_000 + i * 10,
        rootPlaceId: 1000 + i,
      }),
    );
    const m = digestMessage(list);
    checkLimits(m);
    expect(m.embeds).toHaveLength(10);
    expect(m.embeds[0].title).toBe("Game 11");
    expect(m.embeds[9].title).toBe("Game 2");
    expect(m.content).toContain("and 2 more");
    expect(m.embeds[0].url).toBe("https://www.roblox.com/games/1011");
  });

  it("has no 'more' line when nothing is cut", () => {
    const m = digestMessage([evidence()]);
    expect(m.content ?? "").not.toContain("more");
    for (const word of BANNED)
      expect(allText(m)).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  });

  it("stays under 6,000 characters in total for the worst case", () => {
    const keys = Array.from(
      { length: 30 },
      (_, i) => `word:averylongkeyword${i}`,
    );
    const priors = Object.fromEntries(keys.map((k) => [k, [2, 3, 4]]));
    const list = Array.from({ length: 12 }, (_, i) => {
      const long = `${"Name".repeat(80)} ${keys.map((k) => k.slice(5)).join(" ")} ${i}`;
      const map = new Map([
        [
          1,
          facts({
            name: long,
            lastCcu: 5_000 + i,
            family: "f".repeat(100),
            coreAction: "c".repeat(100),
            template: "t".repeat(100),
            rewardLoop: "r".repeat(100),
          }),
        ],
        [2, facts({ name: "P".repeat(300) })],
        [3, facts({ name: "Q".repeat(300) })],
        [4, facts({ name: "R".repeat(300) })],
      ]);
      return alertEvidence(
        { kind: "first_breakout", universeId: 1, keys, priors },
        map,
        {},
      );
    });
    const m = digestMessage(list);
    checkLimits(m);
    expect(m.embeds).toHaveLength(10);
  });
});

describe("postDiscord", () => {
  const token = "SECRETtoken123";
  const url = `https://discord.com/api/webhooks/123456/${token}`;
  const message: DiscordMessage = {
    embeds: [],
    allowed_mentions: { parse: [] },
  };

  function noLeak(error: unknown) {
    expect(error).toBeInstanceOf(DiscordError);
    const e = error as Error;
    for (const text of [
      e.message,
      String(e),
      String(e.cause ?? ""),
      e.stack ?? "",
    ]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain("discord.com");
      expect(text).not.toContain("123456");
    }
  }

  async function failure(run: () => Promise<void>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("did not throw");
  }

  it("posts the message as JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postDiscord(url, message, fetchImpl as unknown as typeof fetch);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual(message);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on 429 with the retry delay and no URL", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
    );
    const error = await failure(() =>
      postDiscord(url, message, fetchImpl as unknown as typeof fetch),
    );
    noLeak(error);
    expect((error as Error).message).toContain("429");
    expect((error as Error).message).toContain("1.5");
  });

  it("throws on 500", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`oops ${url}`, { status: 500 }),
    );
    const error = await failure(() =>
      postDiscord(url, message, fetchImpl as unknown as typeof fetch),
    );
    noLeak(error);
    expect((error as Error).message).toContain("500");
  });

  it("throws on a rejected fetch whose message holds the URL", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${url}`, { cause: new Error(url) });
    });
    noLeak(
      await failure(() =>
        postDiscord(url, message, fetchImpl as unknown as typeof fetch),
      ),
    );
  });

  it("throws on a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException(`The operation timed out ${url}`, "TimeoutError");
    });
    const error = await failure(() =>
      postDiscord(url, message, fetchImpl as unknown as typeof fetch),
    );
    noLeak(error);
    expect((error as Error).message).toContain("timed out");
  });

  it("throws on a malformed URL without echoing it", async () => {
    const bad = `not a url ${token}`;
    const error = await failure(() => postDiscord(bad, message));
    expect(error).toBeInstanceOf(DiscordError);
    expect(String(error)).not.toContain(token);
    expect(String((error as Error).cause ?? "")).not.toContain(token);
  });

  it("uses the configured timeout", () => {
    expect(ALERT_CONFIG.discordTimeoutMs).toBe(10_000);
  });
});
