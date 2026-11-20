// Per-bot Telegram sending — individual faces (owner decision
// 2026-11-19: each bot its own Telegram account + profile photo,
// messaging as itself in the group; the research report's one-face
// model was rejected).
//
// How it works: every bot's token lives in its own env var,
// TELEGRAM_<SLUG>_BOT_TOKEN (e.g. TELEGRAM_MAINTENANCE_BOT_TOKEN),
// set as a Fly secret once the owner creates the bot in BotFather
// and sets its profile photo there. When the token is configured,
// the bot posts as itself — Telegram shows its own name and photo,
// so no text prefix is needed. When it is NOT configured yet, the
// bot falls back to the shared bot token with a "Name: " text prefix,
// so the message still arrives, labeled, and nothing is lost. The
// fallback is explicit in code (asSelf false), never silent.
//
// What this does NOT do: seeing each other's messages is a
// Telegram setting, not this module. By DEFAULT bots cannot see
// each other's messages at all — but Bot-to-Bot Communication Mode
// (Bot API 9.6, April 2026) delivers a bot's message to another bot
// when it carries a command mention addressed to it, or is a direct
// reply to one of its messages (and, with the Mode on plus admin /
// Privacy OFF, all bot messages). So inter-bot coordination runs
// BOTH ways: visible handoffs in the room (services/bots/handoff.ts)
// AND shared records in Supabase (proposals, audit log, memories)
// — the record is the durable state, the room line is the visible
// copy. The receive side for a bot's own token (webhook registration
// per token) is shared-backend work, not here: this module only
// resolves the SENDING token and username. Until the owner provisions
// Maintenance's token, everything still works through the fallback.
//
// Pure functions only — the actual HTTP send stays with the injected
// sendMessage / sendTelegramMessage, so this is unit-testable with no
// network.

import { BOT_SLUGS, type BotSlug } from "./registry";

/** Env var holding one bot's own Telegram token. */
export function botTokenEnvName(slug: BotSlug): string {
  return `TELEGRAM_${slug.toUpperCase().replace(/-/g, "_")}_BOT_TOKEN`;
}

export interface BotSender {
  /** The token to send with. */
  token: string;
  /** True when this is the bot's own token (it posts as itself). False = shared-token fallback, label the text. */
  asSelf: boolean;
}

/**
 * Resolve which token a bot sends with. Empty or whitespace-only
 * env values count as not configured — a blank secret must never
 * send as a half-configured bot.
 */
export function resolveBotSender(
  slug: BotSlug,
  sharedToken: string,
  env: Record<string, string | undefined> = process.env,
): BotSender {
  const own = (env[botTokenEnvName(slug)] ?? "").trim();
  if (own !== "") return { token: own, asSelf: true };
  return { token: sharedToken, asSelf: false };
}

/**
 * Label a bot's message for the room. As itself, Telegram shows the
 * bot's own name and photo — no prefix. On the shared-token
 * fallback, the "Name: " prefix is the only label the owner sees.
 */
export function labelBotMessage(displayName: string, text: string, asSelf: boolean): string {
  return asSelf ? text : `${displayName}: ${text}`;
}

/** Env var holding one bot's Telegram username (without @). */
export function botUsernameEnvName(slug: BotSlug): string {
  return `TELEGRAM_${slug.toUpperCase().replace(/-/g, "_")}_BOT_USERNAME`;
}

/**
 * One bot's configured Telegram username, without @. Null = not
 * provisioned yet — the owner creates the bot in BotFather and sets
 * the TELEGRAM_<BOT>_BOT_USERNAME Fly secret beside the token.
 */
export function botUsernameFor(
  slug: BotSlug,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = (env[botUsernameEnvName(slug)] ?? "").trim().replace(/^@/, "");
  return configured !== "" ? configured : null;
}

/**
 * A Telegram username (with or without @, any case) back to its bot
 * slug, from the configured usernames. Null = no seated bot has that
 * username — the message is from a bot this team does not know, and
 * the group handler ignores it. Usernames are the addressing the
 * Bot-to-Bot Mode delivers on: a handoff's command mention names
 * the target bot by username, and the sender is identified the same
 * way from the message's author.
 */
export function slugForBotUsername(
  username: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): BotSlug | null {
  if (!username) return null;
  const clean = username.replace(/^@/, "").toLowerCase();
  if (clean === "") return null;
  for (const slug of BOT_SLUGS) {
    const configured = botUsernameFor(slug, env);
    if (configured !== null && configured.toLowerCase() === clean) return slug;
  }
  return null;
}
