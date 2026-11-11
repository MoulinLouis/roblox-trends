import { ALERT_CONFIG } from "../config";
import { titleWords } from "../title";
import type { AlertDecision, AlertKind, CardFacts } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

// A prior breakout of a key; everything but the id is null when its facts could not be read.
export interface PriorEvidence {
  universeId: number;
  name: string | null;
  crossedAt: string | null;
  peakCcu: number | null;
  // Whole days between the game's creation and its crossing.
  ageDays: number | null;
}

export interface KeyEvidence {
  key: string;
  // How the card names the key, e.g. `Title word: "ragdoll"`.
  label: string;
  priors: PriorEvidence[];
  trackedGames: number;
  recentGames: number;
}

export interface GameEvidence {
  name: string;
  rootPlaceId: number;
  thumbnailUrl: string | null;
  robloxCreatedAt: string;
  crossedAt: string;
  lastCcu: number;
  ccuDayBefore: number | null;
  likeRatio: number | null;
  family: string | null;
  template: string | null;
  rewardLoop: string | null;
  coreAction: string | null;
  peakCcu: number;
}

// What `alerts.evidence` stores and the messages render. Plain JSON only: dates are ISO strings.
export interface AlertEvidence {
  kind: AlertKind;
  universeId: number;
  // The wave window the decision was made with, so the card counts the breakouts inside it as decided.
  waveWindowDays: number;
  game: GameEvidence;
  keys: KeyEvidence[];
  // The local concept check for the owner to run; null when the decision names no phrase.
  conceptCommand: string | null;
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  timestamp?: string;
  thumbnail?: { url: string };
  footer?: { text: string };
  fields?: { name: string; value: string; inline: boolean }[];
}

export interface DiscordMessage {
  content?: string;
  embeds: DiscordEmbed[];
  // Always empty: a game title carrying @everyone must never ping.
  allowed_mentions: { parse: never[] };
}

// A failed webhook call. Its message names the kind of failure and the HTTP status, never the URL, which holds the
// webhook's token.
export class DiscordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordError";
  }
}

function gameEvidence(facts: CardFacts): GameEvidence {
  return {
    name: facts.name,
    rootPlaceId: facts.rootPlaceId,
    thumbnailUrl: facts.thumbnailUrl,
    robloxCreatedAt: facts.robloxCreatedAt.toISOString(),
    crossedAt: facts.crossedAt.toISOString(),
    lastCcu: facts.lastCcu,
    ccuDayBefore: facts.ccuDayBefore,
    likeRatio: facts.likeRatio,
    family: facts.family,
    template: facts.template,
    rewardLoop: facts.rewardLoop,
    coreAction: facts.coreAction,
    peakCcu: facts.peakCcu,
  };
}

// A phrase of the concept command, pasted into a terminal by the owner: titles and classifications are controlled by
// creators and a model, so only letters, digits, spaces, hyphens and apostrophes survive; no shell expansion can happen
// inside the double quotes.
function quotedPhrase(text: string): string {
  const safe = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s'-]+/, "")
    .trim();
  return `"${safe}"`;
}

// Discord renders markdown in embed descriptions and field values, masked links included: text from creators or the
// model is escaped before it is shown there.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~|>[\]()`]/g, "\\$&");
}

function keyLabel(key: string, spelled: Map<string, string>): string {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === "word") return `Title word: "${spelled.get(value) ?? value}"`;
  if (kind === "action") return `Gameplay: ${value.replace("|", " / ")}`;
  if (kind === "template") return `Title template: ${value}`;
  return key;
}

function conceptCommand(
  decision: AlertDecision,
  facts: CardFacts,
): string | null {
  const keys = new Set(decision.keys);
  const words = [...titleWords(facts.name)]
    .filter(([folded]) => keys.has(`word:${folded}`))
    .map(([, form]) => form);
  const phrases: string[] = [];
  if (words.length > 0) phrases.push(quotedPhrase(words.join(" ")));
  if (
    decision.keys.some((key) => key.startsWith("action:")) &&
    facts.coreAction !== null
  ) {
    phrases.push(quotedPhrase(facts.coreAction));
  }
  // An empty phrase says nothing, and a core action equal to the title words would repeat them.
  const usable = phrases.filter(
    (phrase, index) =>
      phrase !== '""' &&
      phrases.findIndex(
        (other) => other.toLowerCase() === phrase.toLowerCase(),
      ) === index,
  );
  return usable.length === 0 ? null : `npm run concept -- ${usable.join(" ")}`;
}

// The evidence of an alert. `facts` holds the candidate and its prior breakouts; a prior missing from it is kept by id.
// `keyGames` counts, per key, the tracked games carrying it and those created in the last recentGamesDays.
export function alertEvidence(
  decision: AlertDecision,
  facts: Map<number, CardFacts>,
  keyGames: Record<string, { tracked: number; recent: number }>,
  config: Pick<typeof ALERT_CONFIG, "waveWindowDays"> = ALERT_CONFIG,
): AlertEvidence {
  const candidate = facts.get(decision.universeId);
  if (candidate === undefined)
    throw new Error(`No card facts for game ${decision.universeId}`);
  const spelled = titleWords(candidate.name);
  return {
    kind: decision.kind,
    universeId: decision.universeId,
    waveWindowDays: config.waveWindowDays,
    game: gameEvidence(candidate),
    keys: decision.keys.map((key) => ({
      key,
      label: keyLabel(key, spelled),
      priors: (decision.priors[key] ?? []).map((universeId): PriorEvidence => {
        const prior = facts.get(universeId);
        if (prior === undefined)
          return {
            universeId,
            name: null,
            crossedAt: null,
            peakCcu: null,
            ageDays: null,
          };
        return {
          universeId,
          name: prior.name,
          crossedAt: prior.crossedAt.toISOString(),
          peakCcu: prior.peakCcu,
          ageDays: Math.max(
            0,
            Math.floor(
              (prior.crossedAt.getTime() - prior.robloxCreatedAt.getTime()) /
                DAY_MS,
            ),
          ),
        };
      }),
      trackedGames: keyGames[key]?.tracked ?? 0,
      recentGames: keyGames[key]?.recent ?? 0,
    })),
    conceptCommand: conceptCommand(decision, candidate),
  };
}

// Cuts to `limit` UTF-16 code units (Discord's measure, and `string.length`), never splitting a surrogate pair.
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

function days(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

function hour(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function day(iso: string): string {
  return `${iso.slice(0, 10)} UTC`;
}

function ageDays(game: GameEvidence): number {
  return Math.max(
    0,
    Math.floor(
      (Date.parse(game.crossedAt) - Date.parse(game.robloxCreatedAt)) / DAY_MS,
    ),
  );
}

function trajectory(game: GameEvidence): string {
  const parts = [
    `${number(game.lastCcu)} CCU now`,
    `crossed ${number(ALERT_CONFIG.crossingCcu)} CCU at ${hour(game.crossedAt)}`,
    game.ccuDayBefore === null
      ? "no reading 24 hours before"
      : `${number(game.ccuDayBefore)} CCU 24 hours before`,
  ];
  if (game.likeRatio !== null)
    parts.push(`${Math.round(game.likeRatio * 100)}% likes`);
  return parts.join("; ");
}

function format(game: GameEvidence): string {
  const lines = [
    ["Family", game.family],
    ["Template", game.template],
    ["Reward loop", game.rewardLoop],
    ["Core action", game.coreAction],
  ] as const;
  const shown = lines
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${escapeMarkdown(value!)}`);
  return shown.length === 0 ? "Not classified yet" : shown.join("\n");
}

function priorLine(prior: PriorEvidence): string {
  if (
    prior.name === null ||
    prior.crossedAt === null ||
    prior.peakCcu === null ||
    prior.ageDays === null
  ) {
    return `Game ${prior.universeId} (facts unavailable)`;
  }
  const name = escapeMarkdown(
    truncate(prior.name, ALERT_CONFIG.cardNameCharacters),
  );
  return `${name}: crossed ${day(prior.crossedAt)}, peak ${number(prior.peakCcu)} CCU, ${days(prior.ageDays)} old`;
}

function counts(key: KeyEvidence): string {
  return `${number(key.trackedGames)} tracked games, ${number(key.recentGames)} created in the last ${ALERT_CONFIG.recentGamesDays} days`;
}

function kindLine(evidence: AlertEvidence): string {
  const age = ageDays(evidence.game);
  const kind =
    evidence.kind === "wave"
      ? "Another breakout of a pattern seen before"
      : "First breakout of its patterns";
  return `${kind}. Created ${day(evidence.game.robloxCreatedAt)}, ${days(age)} before crossing.`;
}

function ordinal(count: number): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 13) return `${count}th`;
  return `${count}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[count % 10] ?? "th"}`;
}

// The wave line of a card: the highest rank among its keys, counted from the priors that crossed within the window
// the decision used.
function waveLine(evidence: AlertEvidence): string {
  const crossed = Date.parse(evidence.game.crossedAt);
  const windowMs = evidence.waveWindowDays * DAY_MS;
  let rank = 1;
  for (const key of evidence.keys) {
    const inWindow = key.priors.filter(
      (prior) => prior.crossedAt !== null && crossed - Date.parse(prior.crossedAt) <= windowMs,
    ).length;
    rank = Math.max(rank, inWindow + 1);
  }
  return `Wave forming: ${ordinal(rank)} breakout of this pattern within ${days(evidence.waveWindowDays)}`;
}

function keyField(key: KeyEvidence): {
  name: string;
  value: string;
  inline: boolean;
} {
  const shown = key.priors
    .slice(0, ALERT_CONFIG.cardMaximumPriors)
    .map(priorLine);
  if (key.priors.length > shown.length)
    shown.push(`and ${key.priors.length - shown.length} more`);
  const priors =
    shown.length === 0
      ? "No earlier breakout"
      : `Earlier breakouts:\n${shown.join("\n")}`;
  return {
    name: truncate(
      escapeMarkdown(key.label),
      ALERT_CONFIG.discordFieldNameCharacters,
    ),
    value: truncate(
      `${priors}\n${counts(key)}`,
      ALERT_CONFIG.discordFieldValueCharacters,
    ),
    inline: false,
  };
}

function textLength(embed: DiscordEmbed): number {
  let total =
    (embed.title ?? "").length +
    (embed.description ?? "").length +
    (embed.footer?.text ?? "").length;
  for (const field of embed.fields ?? [])
    total += field.name.length + field.value.length;
  return total;
}

// Keeps the embed's texts within `budget` characters: drops the footer, then the last fields, then cuts the description
// and the title.
function fit(embed: DiscordEmbed, budget: number): DiscordEmbed {
  const result: DiscordEmbed = {
    ...embed,
    fields: embed.fields === undefined ? undefined : [...embed.fields],
  };
  if (textLength(result) > budget) delete result.footer;
  while (textLength(result) > budget && (result.fields?.length ?? 0) > 0)
    result.fields!.pop();
  if (textLength(result) > budget && result.description !== undefined) {
    const over = textLength(result) - budget;
    result.description = truncate(
      result.description,
      Math.max(0, result.description.length - over),
    );
  }
  if (textLength(result) > budget && result.title !== undefined) {
    const over = textLength(result) - budget;
    result.title = truncate(
      result.title,
      Math.max(1, result.title.length - over),
    );
  }
  return result;
}

function baseEmbed(evidence: AlertEvidence): DiscordEmbed {
  const game = evidence.game;
  return {
    title: truncate(game.name, ALERT_CONFIG.discordTitleCharacters),
    url: `https://www.roblox.com/games/${game.rootPlaceId}`,
    timestamp: game.crossedAt,
    ...(game.thumbnailUrl === null
      ? {}
      : { thumbnail: { url: game.thumbnailUrl } }),
  };
}

// The push card of one game: one embed with its trajectory, format, one field per key and the concept check.
export function waveMessage(
  evidence: AlertEvidence,
  config = ALERT_CONFIG,
): DiscordMessage {
  const fields: NonNullable<DiscordEmbed["fields"]> = [
    { name: "Trajectory", value: truncate(trajectory(evidence.game), config.discordFieldValueCharacters), inline: false },
    { name: "Format", value: truncate(format(evidence.game), config.discordFieldValueCharacters), inline: false },
    ...evidence.keys.slice(0, config.cardMaximumKeys).map(keyField),
  ];
  if (evidence.keys.length > config.cardMaximumKeys) {
    fields.push({
      name: "More patterns",
      value: `${evidence.keys.length - config.cardMaximumKeys} more keys, listed in the alert evidence`,
      inline: false,
    });
  }
  if (evidence.conceptCommand !== null) {
    fields.push({
      name: "Local concept check",
      value: truncate(
        `\`${evidence.conceptCommand}\``,
        config.discordFieldValueCharacters,
      ),
      inline: false,
    });
  }
  const embed: DiscordEmbed = {
    ...baseEmbed(evidence),
    description: truncate(
      kindLine(evidence),
      config.discordDescriptionCharacters,
    ),
    fields: fields.slice(0, config.discordMaximumFields),
  };
  return {
    content: truncate(waveLine(evidence), config.discordContentCharacters),
    embeds: [fit(embed, config.discordMessageCharacters)],
    allowed_mentions: { parse: [] },
  };
}

// The concept command within `limit` UTF-16 units, cut only between quoted phrases: it drops the last phrases (or the
// whole command) rather than leave a quote open, since the owner pastes it into a terminal.
function fitCommand(command: string, limit: number): string | null {
  if (command.length <= limit) return command;
  const prefix = "npm run concept --";
  const phrases = command.match(/"[^"]*"/g) ?? [];
  let text = prefix;
  let kept = 0;
  for (const phrase of phrases) {
    if (`${text} ${phrase}`.length > limit) break;
    text = `${text} ${phrase}`;
    kept += 1;
  }
  return kept === 0 ? null : text;
}

function digestEmbed(
  evidence: AlertEvidence,
  config: typeof ALERT_CONFIG,
): DiscordEmbed {
  const game = evidence.game;
  const patterns = evidence.keys
    .map(
      (key) =>
        `${escapeMarkdown(key.label)} (${key.priors.length} earlier, ${number(key.trackedGames)} tracked)`,
    )
    .join("; ");
  const embed: DiscordEmbed = {
    ...baseEmbed(evidence),
    description: `${trajectory(game)}\n${format(game).replace(/\n/g, "; ")}`,
    fields:
      patterns === ""
        ? []
        : [
            {
              name: "Patterns",
              value: truncate(patterns, config.digestPatternCharacters),
              inline: false,
            },
          ],
  };
  const command =
    evidence.conceptCommand === null ? null : fitCommand(evidence.conceptCommand, config.digestCommandCharacters);
  if (command !== null) embed.footer = { text: command };
  return embed;
}

// The daily digest: one compact embed per game, most CCU first, at most digestMaximumGames, with an "and N more" line
// when it cuts.
export function digestMessage(
  evidences: AlertEvidence[],
  config = ALERT_CONFIG,
): DiscordMessage {
  const limit = Math.min(
    config.digestMaximumGames,
    config.discordMaximumEmbeds,
  );
  const sorted = [...evidences].sort((a, b) => b.game.lastCcu - a.game.lastCcu);
  const shown = sorted.slice(0, limit);
  const cut = sorted.length - shown.length;
  const content = `Daily digest: ${sorted.length} first ${sorted.length === 1 ? "breakout" : "breakouts"}${
    cut > 0 ? `, and ${cut} more, listed in the alerts table` : ""
  }`;
  const budget = Math.floor(
    config.discordMessageCharacters / Math.max(1, shown.length),
  );
  return {
    content,
    embeds: shown.map((evidence) => fit(digestEmbed(evidence, config), budget)),
    allowed_mentions: { parse: [] },
  };
}

function retryAfter(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("retry_after" in body))
    return null;
  const value = (body as { retry_after: unknown }).retry_after;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Posts the message to a Discord webhook. The thrown DiscordError describes the failure by kind and status only: the
// underlying errors can embed the URL, so none of their text is copied.
export async function postDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(ALERT_CONFIG.discordTimeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new DiscordError(
        `Discord webhook timed out after ${ALERT_CONFIG.discordTimeoutMs} ms`,
      );
    }
    throw new DiscordError(
      "Discord webhook request failed (network error or invalid URL)",
    );
  }
  if (response.ok) return;
  let detail = "";
  if (response.status === 429) {
    const seconds = retryAfter(await response.json().catch(() => null));
    if (seconds !== null) detail = `, retry after ${seconds} s`;
  }
  throw new DiscordError(
    `Discord webhook answered HTTP ${response.status}${detail}`,
  );
}
