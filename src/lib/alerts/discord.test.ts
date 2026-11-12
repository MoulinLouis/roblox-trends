import { describe, expect, it, vi } from "vitest";
import { ALERT_CONFIG } from "../config";
import {
  alertEvidence,
  DiscordError,
  digestMessage,
  frenchLabel,
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

// Non-breaking and narrow no-break spaces read as plain spaces, so expectations stay readable.
function plain(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, " ");
}

const NOW = new Date("2026-11-11T14:00:00Z");

function allText(message: DiscordMessage): string {
  const parts: string[] = [message.content ?? ""];
  for (const e of message.embeds) {
    parts.push(e.title ?? "", e.description ?? "", e.footer?.text ?? "");
    for (const f of e.fields ?? []) parts.push(f.name, f.value);
  }
  return plain(parts.join("\n"));
}

function plainFields(message: DiscordMessage) {
  return message.embeds[0].fields!.map((f) => ({
    ...f,
    name: plain(f.name),
    value: plain(f.value),
  }));
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
  "opportunité",
  "recommandé",
  "recommande",
  "conseil",
  "conseillé",
  "devrais",
  "fonce",
  "gagnant",
  "à faire",
];

function bannedIn(text: string): string[] {
  return BANNED.filter((word) =>
    new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, "iu").test(text),
  );
}

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

describe("untrusted text", () => {
  const FORBIDDEN = ["$", "`", "!", "\\", ";", "|", "&", "<", ">", "(", ")"];

  it("keeps shell syntax out of the concept command", () => {
    const e = alertEvidence(
      {
        kind: "first_breakout",
        universeId: 1,
        keys: ["word:ragdoll", "word:sim", "action:simulator|x"],
        priors: {},
      },
      new Map([
        [
          1,
          facts({
            name: "$(touch x) Ragdoll `id` $HOME Sim!",
            coreAction: "run `id` $(reboot) now; rm | x & y",
          }),
        ],
      ]),
      {},
    );
    const command = e.conceptCommand!;
    const phrases = command.slice("npm run concept -- ".length);
    for (const bad of FORBIDDEN) expect(phrases).not.toContain(bad);
    expect(phrases).toMatch(/^"[^"]+"( "[^"]+")?$/);
    expect(phrases).toContain("ragdoll");
  });

  it("drops a phrase left empty", () => {
    const e = alertEvidence(
      { kind: "wave", universeId: 1, keys: ["action:a|b"], priors: {} },
      new Map([[1, facts({ coreAction: "$()`" })]]),
      {},
    );
    expect(e.conceptCommand).toBeNull();
  });

  it("escapes markdown and masked links in rendered text", () => {
    const name = "[Free Robux](https://evil.example) **x** ||y|| `z`";
    const e = evidence(1, { name, family: "[a](b)", coreAction: "*c*" }, {});
    e.keys[0].priors[0].name = name;
    for (const message of [waveMessage(e), digestMessage([e])]) {
      const texts = message.embeds.flatMap((m) => [
        m.description ?? "",
        ...(m.fields ?? []).flatMap((f) => [f.name, f.value]),
      ]);
      const joined = texts.join("\n");
      expect(joined).not.toMatch(/(?<!\\)\]\(/);
      if ((message.embeds[0].fields?.length ?? 0) > 1)
        expect(joined).toContain("\\[Free Robux\\]\\(");
      expect(joined).not.toMatch(/(?<!\\)\*\*x/);
      expect(joined).not.toMatch(/(?<!\\)\|\|y/);
      checkLimits(message);
    }
  });

  it("keeps the limits when escaping doubles a long name", () => {
    const name = "*".repeat(500);
    const e = evidence(1, { name }, {});
    e.keys[0].priors[0].name = name;
    checkLimits(waveMessage(e));
    checkLimits(digestMessage(Array.from({ length: 10 }, () => e)));
  });
});

describe("astral characters", () => {
  const emoji = "😀".repeat(400);

  it("keeps every limit by string length with emoji-heavy names on a wave card and a 10-game digest", () => {
    const e = evidence(1, { name: emoji, family: emoji, coreAction: emoji });
    for (const prior of e.keys.flatMap((key) => key.priors)) prior.name = emoji;
    const wave = waveMessage(e);
    checkLimits(wave);
    checkLimits(digestMessage(Array.from({ length: 10 }, () => e)));
    for (const text of [wave.embeds[0].title!, wave.embeds[0].description!]) {
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("cuts by UTF-16 length without splitting a surrogate pair", () => {
    const e = evidence(1, { name: "😀".repeat(300) });
    const title = waveMessage(e).embeds[0].title!;
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title).toMatch(/…$/);
    expect(title.slice(0, -1)).toBe("😀".repeat((title.length - 1) / 2));
  });
});

describe("message kinds", () => {
  it("says on a wave card how many breakouts of the pattern fall within the window, from the evidence", () => {
    // The candidate crossed 2026-11-10 14:00: prior 3 (11-07) is inside 5 days, prior 2 (11-05) is not.
    const m = waveMessage(evidence(), ALERT_CONFIG, NOW);
    expect(plain(m.content!)).toBe(
      "🌊 **Vague en formation** : Ragdoll Physics Simulator est le 2e jeu récent du même motif à dépasser 1 000 joueurs en 5 jours.",
    );
    const e = evidence();
    e.waveWindowDays = 7;
    expect(plain(waveMessage(e, ALERT_CONFIG, NOW).content!)).toContain(
      "est le 3e jeu récent du même motif à dépasser 1 000 joueurs en 7 jours.",
    );
  });

  it("keeps the wave content within its limit and escapes the name", () => {
    const m = waveMessage(evidence(1, { name: `@everyone **${"x".repeat(3000)}` }));
    expect(m.content!.length).toBeLessThanOrEqual(2_000);
    expect(m.content).toContain("\\*\\*");
  });

  it("titles the digest with its number of games, and says how many are left out when it cuts", () => {
    const one = plain(digestMessage([evidence()], ALERT_CONFIG, NOW).content!);
    expect(one).toBe(
      "📬 **Les nouvelles percées du jour** : 1 jeu récent a dépassé 1 000 joueurs en même temps sur un motif sans percée ces 60 derniers jours.\n_Une percée = un jeu créé il y a moins de 12 jours qui passe 1 000 joueurs en même temps. Un motif = un mot du titre, un gameplay ou un modèle de titre que d'autres jeux partagent._",
    );
    const list = Array.from({ length: 12 }, (_, i) => evidence(1, { name: `Game ${i}`, rootPlaceId: 1000 + i }));
    const [first, second] = plain(digestMessage(list, ALERT_CONFIG, NOW).content!).split("\n");
    expect(first).toBe(
      "📬 **Les nouvelles percées du jour** : 12 jeux récents ont dépassé 1 000 joueurs en même temps sur un motif sans percée ces 60 derniers jours. Voici les 10 plus joués ; les 2 autres sont dans la table alerts.",
    );
    expect(second.startsWith("_Une percée")).toBe(true);
    expect(plain(digestMessage(list.slice(0, 11)).content!)).toContain("l'autre est dans la table alerts.");
  });
});

describe("digest footer", () => {
  it("drops whole phrases rather than cut the command inside a quote", () => {
    const e = evidence();
    e.conceptCommand = `npm run concept -- "${"a".repeat(30)}" "${"b".repeat(30)}" "${"c".repeat(30)}"`;
    const footer = digestMessage([e]).embeds[0].footer!.text;
    expect(footer).toBe(`🧪 npm run concept -- "${"a".repeat(30)}" "${"b".repeat(30)}"`);
    expect(footer.length).toBeLessThanOrEqual(ALERT_CONFIG.digestCommandCharacters);
  });

  it("drops the whole command when not even one phrase fits", () => {
    const e = evidence();
    e.conceptCommand = `npm run concept -- "${"a".repeat(200)}"`;
    expect(digestMessage([e]).embeds[0].footer).toBeUndefined();
  });
});

describe("waveMessage", () => {
  it("renders one embed with the linked title, thumbnail and fields", () => {
    const m = waveMessage(evidence(), ALERT_CONFIG, NOW);
    checkLimits(m);
    expect(m.embeds).toHaveLength(1);
    const embed = m.embeds[0];
    expect(embed.title).toBe("Ragdoll Physics Simulator");
    expect(embed.url).toBe("https://www.roblox.com/games/111");
    expect(embed.thumbnail?.url).toBe("https://tr.rbxcdn.com/thumb.png");
    expect(embed.timestamp).toBe("2026-11-10T14:00:00.000Z");
    expect(plain(embed.description!)).toBe(
      "Un jeu créé il y a moins de 12 jours vient de passer 1 000 joueurs en même temps, et d'autres jeux du même motif l'ont fait juste avant lui : une vague commence peut-être.",
    );
    const fields = plainFields(m);
    expect(fields.slice(0, 4)).toEqual([
      { name: "👥 Joueurs", value: "**2 345** en ce moment\n410 la veille de sa percée", inline: true },
      { name: "📈 Percée", value: "**mar. 10 nov. à 15 h**\nil y a 1 j", inline: true },
      { name: "🎂 Créé", value: "**mar. 3 nov.**\n7 j avant sa percée", inline: true },
      { name: "👍 Avis", value: "87 % de j'aime", inline: true },
    ]);
    expect(fields[4]).toEqual({
      name: "🎮 Format",
      value: "Famille : simulator\nModèle de titre : simulator\nRécompense : collect and upgrade\nAction principale : ragdoll",
      inline: false,
    });
    const key = fields.find((f) => f.name === "🔎 Motif : gameplay « simulator / ragdoll »")!;
    expect(key.inline).toBe(false);
    expect(key.value).toBe(
      [
        "Déjà percé avant lui :",
        "• Ragdoll Launch — le jeu. 5 nov. (pic 8 000 joueurs, 4 j après sa création)",
        "• Rag Tower — le sam. 7 nov. (pic 1 500 joueurs, 3 j après sa création)",
        "12 jeux suivis portent ce motif, dont 5 créés ces 14 derniers jours.",
      ].join("\n"),
    );
    expect(fields.find((f) => f.name === "🧪 Vérifier l'idée")!.value).toBe(
      '`npm run concept -- "ragdoll physics" "ragdoll"`',
    );
  });

  it("omits the likes when unknown and says when there is no reading the day before or no format", () => {
    const m = waveMessage(
      evidence(1, { likeRatio: null, ccuDayBefore: null, family: null, template: null, rewardLoop: null, coreAction: null }),
      ALERT_CONFIG,
      NOW,
    );
    const fields = plainFields(m);
    expect(fields.some((f) => f.name === "👍 Avis")).toBe(false);
    expect(fields[0].value).toContain("pas de relevé la veille");
    expect(fields.find((f) => f.name === "🎮 Format")!.value).toBe("Pas encore classé");
  });

  it("says when a key has no earlier breakout, with the singular counts", () => {
    const text = allText(waveMessage(evidence()));
    expect(text).toContain(
      "Aucun jeu de ce motif n'avait dépassé 1 000 joueurs ces 60 derniers jours.\n2 jeux suivis portent ce motif, dont 1 créé ces 14 derniers jours.",
    );
    const e = evidence();
    e.keys[2].trackedGames = 1;
    expect(allText(waveMessage(e))).toContain("1 jeu suivi porte ce motif");
  });

  it("caps the priors and the keys, and names the rest in French", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `word:w${i}`);
    const priors = Object.fromEntries(keys.map((k) => [k, [2, 3, 2, 3, 2, 3, 2, 3]]));
    const map = new Map([
      [1, facts()],
      [2, facts({ name: "P" })],
      [3, facts({ name: "Q" })],
    ]);
    const m = waveMessage(alertEvidence({ kind: "wave", universeId: 1, keys, priors }, map, {}));
    const fields = plainFields(m);
    expect(fields.at(-1)!.name).toBe("Autres motifs");
    expect(fields.at(-1)!.value).toMatch(/^\d+ autres? motifs?, dans la table alerts$/);
    expect(fields.some((f) => /^et \d+ autres?$/m.test(f.value))).toBe(true);
  });

  it("makes no verdict, in French or English", () => {
    const text = allText(waveMessage(evidence()));
    expect(bannedIn(text)).toEqual([]);
    expect(bannedIn("Un conseil : fonce, c'est une opportunité à faire")).toEqual([
      "opportunité",
      "conseil",
      "fonce",
      "à faire",
    ]);
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
  it("gives 10 embeds, most players first, and says 2 are left out for 12", () => {
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
    expect(plain(m.content!)).toContain("les 2 autres sont dans la table alerts");
    expect(m.embeds[0].url).toBe("https://www.roblox.com/games/1011");
  });

  it("renders a compact game embed in French", () => {
    const e = evidence(1, { template: "{thing} Sandbox", family: "physics sandbox", coreAction: "none" }, {
      kind: "first_breakout",
      keys: ["action:physics sandbox|spawn tornadoes"],
      priors: {},
    });
    e.keys[0].trackedGames = 2;
    const embed = digestMessage([e], ALERT_CONFIG, NOW).embeds[0];
    expect(plain(embed.description!)).toBe(
      [
        "👥 **2 345 joueurs** en ce moment · percée **mar. 10 nov. à 15 h** (il y a 1 j) · 410 la veille",
        "🎂 Créé le **mar. 3 nov.** (7 j avant sa percée) · 👍 87 % de j'aime",
        "🎮 physics sandbox · {thing} Sandbox",
        "🆕 Premier à percer pour : gameplay « physics sandbox / spawn tornadoes » (2 jeux suivis)",
      ].join("\n"),
    );
    expect(embed.fields).toBeUndefined();
  });

  it("says nothing of cut games when nothing is cut", () => {
    const m = digestMessage([evidence()]);
    expect(plain(m.content!)).not.toContain("Voici");
    expect(bannedIn(allText(m))).toEqual([]);
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
    const m = digestMessage(list, ALERT_CONFIG, NOW);
    checkLimits(m);
    expect(m.embeds).toHaveLength(10);
    expect(totalCharacters(m)).toBeLessThanOrEqual(6_000);
    expect(m.content!.length).toBeLessThanOrEqual(2_000);
  });
});

describe("French dates", () => {
  // Paris is UTC+2 until 2026-10-25 01:00 UTC, then UTC+1.
  function crossingAt(iso: string) {
    return evidence(1, {
      crossedAt: new Date(iso),
      robloxCreatedAt: new Date("2026-10-20T10:00:00Z"),
    });
  }
  const now = new Date("2026-10-26T00:00:00Z");

  it("shows the Paris hour on both sides of a daylight saving change", () => {
    const summer = plainFields(waveMessage(crossingAt("2026-10-24T22:00:00Z"), ALERT_CONFIG, now));
    const winter = plainFields(waveMessage(crossingAt("2026-10-25T22:00:00Z"), ALERT_CONFIG, now));
    // 22:00 UTC is 00:00 the next day in summer time and 23:00 the same day in winter time.
    expect(summer[1].value).toBe("**dim. 25 oct. à 0 h**\nil y a 1 j");
    expect(winter[1].value).toBe("**dim. 25 oct. à 23 h**\nil y a 2 h");
    expect(summer[2].value).toBe("**mar. 20 oct.**\n4 j avant sa percée");
  });

  it("shows the minutes only when they are not 00, never ISO text or UTC", () => {
    const m = waveMessage(crossingAt("2026-11-10T11:30:00Z"), ALERT_CONFIG, new Date("2026-11-10T11:50:00Z"));
    expect(plainFields(m)[1].value).toBe("**mar. 10 nov. à 12 h 30**\nil y a moins d'1 h");
    const text = allText(m);
    expect(text).not.toMatch(/UTC|\d{4}-\d{2}-\d{2}/);
  });

  it("counts the relative age in hours under a day and days after", () => {
    const e = crossingAt("2026-11-10T11:00:00Z");
    const at = (iso: string) => plainFields(waveMessage(e, ALERT_CONFIG, new Date(iso)))[1].value;
    expect(at("2026-11-10T14:30:00Z")).toContain("il y a 3 h");
    expect(at("2026-11-12T12:00:00Z")).toContain("il y a 2 j");
  });

  it("writes the digest dates the same way", () => {
    const d = digestMessage([crossingAt("2026-10-25T22:00:00Z")], ALERT_CONFIG, now);
    expect(plain(d.embeds[0].description!)).toContain("percée **dim. 25 oct. à 23 h** (il y a 2 h)");
    expect(d.embeds[0].timestamp).toBe("2026-10-25T22:00:00.000Z");
  });
});

describe("French numbers and values", () => {
  it("groups thousands the French way and writes percentages with a space", () => {
    const m = waveMessage(evidence(1, { lastCcu: 1_234_567, likeRatio: 0.774 }), ALERT_CONFIG, NOW);
    const fields = plainFields(m);
    expect(fields[0].value).toContain("**1 234 567** en ce moment");
    expect(fields[3].value).toBe("77 % de j'aime");
    expect(m.content).toContain("1\u202f000");
  });

  it("shows the literal none as aucun, in the format and the gameplay key", () => {
    const e = evidence(1, { coreAction: "none", family: "none" }, { keys: ["action:none|none"], priors: {} });
    const text = allText(waveMessage(e));
    expect(text).toContain("Famille : aucun");
    expect(text).toContain("Action principale : aucun");
    expect(text).toContain("gameplay « aucun / aucun »");
    expect(text.replace(/`npm run concept[^`]*`/, "")).not.toMatch(/\bnone\b/);
  });
});

describe("labels", () => {
  it("builds the labels in French", () => {
    const e = evidence(1, {}, { keys: ["word:ragdoll", "template:{thing} Sandbox", "action:simulator|ragdoll"], priors: {} });
    expect(e.keys.map((k) => plain(k.label))).toEqual([
      "mot du titre « ragdoll »",
      "modèle de titre « {thing} Sandbox »",
      "gameplay « simulator / ragdoll »",
    ]);
  });

  it("translates a label stored by the previous version", () => {
    expect(plain(frenchLabel('Title word: "ragdoll"'))).toBe("mot du titre « ragdoll »");
    expect(plain(frenchLabel("Gameplay: simulator / ragdoll"))).toBe("gameplay « simulator / ragdoll »");
    expect(plain(frenchLabel("Title template: {thing} Sandbox"))).toBe("modèle de titre « {thing} Sandbox »");
    expect(plain(frenchLabel("Gameplay: none / x"))).toBe("gameplay « aucun / x »");
    const already = frenchLabel("mot du titre « ragdoll »");
    expect(frenchLabel(already)).toBe(already);
    expect(frenchLabel("word:odd")).toBe("word:odd");
  });

  it("renders an old English label in French on a card", () => {
    const e = evidence();
    e.keys[1].label = 'Title word: "ragdoll"';
    const m = waveMessage(e);
    expect(plainFields(m).some((f) => f.name === "🔎 Motif : mot du titre « ragdoll »")).toBe(true);
    expect(allText(m)).not.toContain("Title word");
    expect(allText(digestMessage([e]))).toContain("mot du titre « ragdoll »");
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
