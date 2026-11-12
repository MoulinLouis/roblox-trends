import { ALERT_CONFIG } from "../config";
import { titleWords } from "../title";
import type { AlertDecision, AlertKind, CardFacts } from "./types";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

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
  // How the card names the key, in French, e.g. `mot du titre « ragdoll »`.
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

// Non-breaking space: the French typography keeps it before `:` `%` and inside « ».
const NB = " ";

function quoted(text: string): string {
  return `«${NB}${text}${NB}»`;
}

// A classification value as the owner reads it: the literal `none` is "aucun".
function shown(value: string, feminine = false): string {
  if (value !== "none") return value;
  return feminine ? "aucune" : "aucun";
}

function keyLabel(key: string, spelled: Map<string, string>): string {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === "word")
    return `mot du titre ${quoted(spelled.get(value) ?? value)}`;
  if (kind === "action")
    return `gameplay ${quoted(value.split("|").map((part) => shown(part, true)).join(" / "))}`;
  if (kind === "template") return `modèle de titre ${quoted(shown(value))}`;
  return key;
}

// Alerts recorded before the cards were French store English labels; this reads them in French.
export function frenchLabel(label: string): string {
  const word = /^Title word: "(.*)"$/s.exec(label);
  if (word !== null) return `mot du titre ${quoted(word[1])}`;
  const action = /^Gameplay: (.*)$/s.exec(label);
  if (action !== null)
    return `gameplay ${quoted(action[1].split(" / ").map((part) => shown(part, true)).join(" / "))}`;
  const template = /^Title template: (.*)$/s.exec(label);
  if (template !== null) return `modèle de titre ${quoted(shown(template[1]))}`;
  return label;
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
      phrase.toLowerCase() !== '"none"' &&
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
          ageDays: calendarDays(
            prior.robloxCreatedAt.toISOString(),
            prior.crossedAt.toISOString(),
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

const NUMBER_FORMAT = new Intl.NumberFormat("fr-FR");

function number(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function plural(count: number, one: string, many: string): string {
  return `${number(count)} ${count > 1 ? many : one}`;
}

function days(count: number): string {
  return plural(count, "jour", "jours");
}

// Every date is shown in the owner's time zone, in French.
function parts(iso: string, options: Intl.DateTimeFormatOptions) {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    timeZone: ALERT_CONFIG.digestTimeZone,
    hourCycle: "h23",
    ...options,
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    formatted.find((part) => part.type === type)?.value ?? "";
  return get;
}

// `dim. 2 nov.`
function day(iso: string): string {
  const get = parts(iso, { weekday: "short", day: "numeric", month: "short" });
  return `${get("weekday")} ${dayOfMonth(get("day"))} ${get("month")}`;
}

function dayOfMonth(value: string): string {
  return value === "1" ? "1er" : value;
}

// `mer. 11 nov. à 12 h`, with the minutes only when they are not :00.
function moment(iso: string): string {
  const get = parts(iso, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const hour = Number(get("hour"));
  const minutes = Number(get("minute"));
  let clock = `${hour}${NB}h${minutes === 0 ? "" : `${NB}${get("minute")}`}`;
  if (minutes === 0 && hour === 0) clock = "minuit";
  if (minutes === 0 && hour === 12) clock = "midi";
  return `${get("weekday")} ${dayOfMonth(get("day"))} ${get("month")} à${NB}${clock}`;
}

// `il y a 3 h`, `il y a 2 j`.
function ago(iso: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(iso);
  if (elapsed < HOUR_MS) return `il y a moins d'1${NB}h`;
  if (elapsed < DAY_MS) return `il y a ${Math.floor(elapsed / HOUR_MS)}${NB}h`;
  return `il y a ${Math.floor(elapsed / DAY_MS)}${NB}j`;
}

// Whole calendar days between two instants, counted on the dates shown (owner's time zone), so the age agrees with
// the dates next to it.
export function calendarDays(from: string, to: string): number {
  const number = (iso: string) => {
    const get = parts(iso, { year: "numeric", month: "numeric", day: "numeric" });
    return Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  };
  return Math.max(0, Math.round((number(to) - number(from)) / DAY_MS));
}

function ageDays(game: GameEvidence): number {
  return calendarDays(game.robloxCreatedAt, game.crossedAt);
}

function dayBeforeCard(game: GameEvidence): string {
  return game.ccuDayBefore === null
    ? "pas de relevé la veille"
    : `${number(game.ccuDayBefore)} la veille de sa percée`;
}

function dayBeforeDigest(game: GameEvidence): string {
  return game.ccuDayBefore === null
    ? "pas de relevé la veille"
    : `${number(game.ccuDayBefore)} la veille`;
}

function likes(game: GameEvidence): string | null {
  return game.likeRatio === null
    ? null
    : `${Math.round(game.likeRatio * 100)}${NB}% de j'aime`;
}

function format(game: GameEvidence): string {
  const lines = [
    [`Famille${NB}:`, game.family, true],
    [`Modèle de titre${NB}:`, game.template, false],
    [`Récompense${NB}:`, game.rewardLoop, true],
    [`Action principale${NB}:`, game.coreAction, true],
  ] as const;
  const present = lines
    .filter(([, value]) => value !== null)
    .map(([name, value, feminine]) => `${name} ${escapeMarkdown(shown(value!, feminine))}`);
  return present.length === 0 ? "Pas encore classé" : present.join("\n");
}

function priorLine(prior: PriorEvidence): string {
  if (
    prior.name === null ||
    prior.crossedAt === null ||
    prior.peakCcu === null ||
    prior.ageDays === null
  ) {
    return `• Jeu ${prior.universeId} (infos indisponibles)`;
  }
  const name = escapeMarkdown(
    truncate(prior.name, ALERT_CONFIG.cardNameCharacters),
  );
  return `• ${name} — ${day(prior.crossedAt)} (pic ${number(prior.peakCcu)} joueurs, ${prior.ageDays}${NB}j après sa création)`;
}

function counts(key: KeyEvidence): string {
  const recent = `${number(key.recentGames)} ${key.recentGames > 1 ? "créés" : "créé"}`;
  const carry = key.trackedGames > 1 ? "portent" : "porte";
  return `${plural(key.trackedGames, "jeu suivi", "jeux suivis")} ${carry} ce motif, dont ${recent} ces ${ALERT_CONFIG.recentGamesDays} derniers jours.`;
}

function label(key: KeyEvidence): string {
  return escapeMarkdown(frenchLabel(key.label));
}

// The wave line of a card: the highest rank among its keys, counted from the priors that crossed within the window
// the decision used.
function waveRank(evidence: AlertEvidence): number {
  const crossed = Date.parse(evidence.game.crossedAt);
  const windowMs = evidence.waveWindowDays * DAY_MS;
  let rank = 1;
  for (const key of evidence.keys) {
    const inWindow = key.priors.filter(
      (prior) => prior.crossedAt !== null && crossed - Date.parse(prior.crossedAt) <= windowMs,
    ).length;
    rank = Math.max(rank, inWindow + 1);
  }
  return rank;
}

function waveLine(evidence: AlertEvidence): string {
  const rank = waveRank(evidence);
  const name = escapeMarkdown(
    truncate(
      evidence.game.name.replace(/\s+/g, " ").trim(),
      ALERT_CONFIG.cardNameCharacters,
    ),
  );
  const crossed =
    rank === 1 ? "1 jeu du même motif a dépassé" : `${rank} jeux du même motif ont dépassé`;
  return `🌊 **Vague en formation**${NB}: ${crossed} ${number(ALERT_CONFIG.crossingCcu)} joueurs en même temps en moins de ${days(evidence.waveWindowDays)}${NB}; ${name} est le ${rank === 1 ? "1er" : `${rank}e`}.`;
}

function keyField(key: KeyEvidence): {
  name: string;
  value: string;
  inline: boolean;
} {
  const lines = key.priors
    .slice(0, ALERT_CONFIG.cardMaximumPriors)
    .map(priorLine);
  if (key.priors.length > lines.length) {
    const more = key.priors.length - lines.length;
    lines.push(`et ${plural(more, "autre", "autres")}`);
  }
  const priors =
    lines.length === 0
      ? `Aucun jeu de ce motif n'avait dépassé ${number(ALERT_CONFIG.crossingCcu)} joueurs ces ${ALERT_CONFIG.lookbackDays} derniers jours.`
      : `Déjà percé avant lui${NB}:\n${lines.join("\n")}`;
  return {
    name: truncate(
      `🔎 Motif${NB}: ${label(key)}`,
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

// The push card of one game: one embed with its numbers, dates, format, one field per key and the concept check.
// `now` is the render time, against which the ages are computed.
export function waveMessage(
  evidence: AlertEvidence,
  config = ALERT_CONFIG,
  now = new Date(),
): DiscordMessage {
  const game = evidence.game;
  const limit = config.discordFieldValueCharacters;
  const fields: NonNullable<DiscordEmbed["fields"]> = [
    {
      name: "👥 Joueurs",
      value: truncate(`**${number(game.lastCcu)}** à la détection\n${dayBeforeCard(game)}`, limit),
      inline: true,
    },
    {
      name: "📈 Percée",
      value: truncate(`**${moment(game.crossedAt)}**\n${ago(game.crossedAt, now)}`, limit),
      inline: true,
    },
    {
      name: "🎂 Créé",
      value: truncate(`**${day(game.robloxCreatedAt)}**\n${ageDays(game)}${NB}j avant sa percée`, limit),
      inline: true,
    },
  ];
  const liked = likes(game);
  if (liked !== null) fields.push({ name: "👍 Avis", value: liked, inline: true });
  fields.push(
    { name: "🎮 Format", value: truncate(format(game), limit), inline: false },
    ...evidence.keys.slice(0, config.cardMaximumKeys).map(keyField),
  );
  if (evidence.keys.length > config.cardMaximumKeys) {
    const more = evidence.keys.length - config.cardMaximumKeys;
    fields.push({
      name: "Autres motifs",
      value: `${plural(more, "autre motif", "autres motifs")}, dans la table alerts`,
      inline: false,
    });
  }
  if (evidence.conceptCommand !== null) {
    fields.push({
      name: `🧪 Vérifier l'idée`,
      value: truncate(`\`${evidence.conceptCommand}\``, limit),
      inline: false,
    });
  }
  const description = `Un jeu créé il y a moins de ${days(config.candidateMaximumAgeDays)} vient de passer ${number(config.crossingCcu)} joueurs en même temps, et d'autres jeux du même motif l'ont fait juste avant lui${NB}: une vague commence peut-être.`;
  const embed: DiscordEmbed = {
    ...baseEmbed(evidence),
    description: truncate(description, config.discordDescriptionCharacters),
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
  now: Date,
): DiscordEmbed {
  const game = evidence.game;
  const liked = likes(game);
  // `none` values are skipped, and so is a value equal to the one before it.
  const kept: string[] = [];
  for (const value of [game.family, game.template, game.coreAction]) {
    if (value !== null && value !== "none" && value !== kept.at(-1))
      kept.push(value);
  }
  const format = kept.map(escapeMarkdown).join(" · ");
  const patterns = evidence.keys
    .map((key) => `${label(key)} (${plural(key.trackedGames, "jeu suivi", "jeux suivis")})`)
    .join(`${NB}; `);
  const lines = [
    `👥 **${number(game.lastCcu)} joueurs** à la détection · percée **${moment(game.crossedAt)}** (${ago(game.crossedAt, now)}) · ${dayBeforeDigest(game)}`,
    `🎂 Créé le **${day(game.robloxCreatedAt)}** (${ageDays(game)}${NB}j avant sa percée)${liked === null ? "" : ` · 👍 ${liked}`}`,
  ];
  if (format !== "") lines.push(`🎮 ${format}`);
  if (patterns !== "")
    lines.push(
      `🆕 Premier à percer depuis ${config.lookbackDays} jours${NB}: ${truncate(patterns, config.digestPatternCharacters)}`,
    );
  const embed: DiscordEmbed = {
    ...baseEmbed(evidence),
    description: truncate(lines.join("\n"), config.discordDescriptionCharacters),
  };
  const command =
    evidence.conceptCommand === null ? null : fitCommand(evidence.conceptCommand, config.digestCommandCharacters);
  if (command !== null) embed.footer = { text: `🧪 ${command}` };
  return embed;
}

// The daily digest: one compact embed per game, most players first, at most digestMaximumGames, with a line saying how
// many are left out when it cuts.
export function digestMessage(
  evidences: AlertEvidence[],
  config = ALERT_CONFIG,
  now = new Date(),
): DiscordMessage {
  const limit = Math.min(
    config.digestMaximumGames,
    config.discordMaximumEmbeds,
  );
  const sorted = [...evidences].sort((a, b) => b.game.lastCcu - a.game.lastCcu);
  const included = sorted.slice(0, limit);
  const cut = sorted.length - included.length;
  const single = sorted.length === 1;
  const cutText =
    cut === 0
      ? ""
      : ` ${included.length === 1 ? "Voici le plus joué" : `Voici les ${included.length} plus joués`}${NB}; ${cut === 1 ? "l'autre est" : `les ${cut} autres sont`} dans la table alerts.`;
  const content = truncate(
    `📬 **Les nouvelles percées du jour**${NB}: ${single ? "1 jeu récent a dépassé" : `${sorted.length} jeux récents ont dépassé`} ${number(config.crossingCcu)} joueurs en même temps sur un motif sans percée ces ${config.lookbackDays} derniers jours.${cutText}\n_Une percée = un jeu créé il y a moins de ${days(config.candidateMaximumAgeDays)} qui passe ${number(config.crossingCcu)} joueurs en même temps. Un motif = un mot du titre, un gameplay ou un modèle de titre que d'autres jeux partagent._`,
    config.discordContentCharacters,
  );
  const budget = Math.floor(
    config.discordMessageCharacters / Math.max(1, included.length),
  );
  return {
    content,
    embeds: included.map((evidence) =>
      fit(digestEmbed(evidence, config, now), budget),
    ),
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
