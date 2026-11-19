// Bot faces — one Telegram account per bot (owner rule 2026-11-19:
// individual faces, not one face for the team). Each bot gets its own
// BotFather bot, its own profile photo, and messages as itself in the
// group, so the owner sees each bot's face when it talks.
//
// The Telegram mechanics that make this work (verified 2026-11-19
// against Telegram's own docs, core.telegram.org/api/bots/bot-to-bot
// and core.telegram.org/bots/faq):
// - Bot-to-Bot Communication Mode (Bot API 9.6, April 2026) must be
//   enabled for every bot in @BotFather. With it on, a bot receives
//   another bot's message when the message contains a command mention
//   addressed to it (/command@TargetBot) or is a direct reply to one
//   of its messages (at least one of the two bots needs the mode on).
//   A bot with the mode on ALSO receives other bots' messages without
//   a mention or reply when it is a group admin or has Group Privacy
//   Mode disabled.
// - Group Privacy Mode must be disabled in @BotFather for every bot
//   (or the bot made a group admin), or the bot only receives
//   commands, replies, and messages sent via it — it would not see
//   the owner's ordinary group messages.
// - Without the mode, the default applies: bots do not see messages
//   from other bots, regardless of settings (Bots FAQ). The mode is
//   the exception, and it is a manual @BotFather step — no API flips
//   it. The group-as-channel target shape depends on the owner (or
//   King's lane) doing that setup per bot; until then, bot-to-bot
//   delivery falls back to the handoff queue (bot_handoffs) and the
//   room post is still visible to the owner.
// - Telegram warns the mode can create infinite reply loops. The
//   loop guards live in code: a bot answers another bot ONLY when
//   addressed by name or in reply (decideTrackerSpeech in
//   services/bots/tracker.ts), never its own chatter, never
//   unprompted; handoff chains are depth-capped; the group-message
//   log dedupes by Telegram message id.
//
// This file holds IDENTITY ONLY — usernames, photo references, token
// env var names, webhook paths. No token VALUES, ever: tokens live in
// Fly secrets / env, named here so the webhook route can bind each
// bot's sender to its own token. A face with username null is not
// created yet (the owner creates it in @BotFather); isTeamBotUsername
// only trusts usernames listed here, so an unknown bot in the room is
// ignored fail-closed.

import type { BotSlug } from "./registry";

export interface BotFace {
  slug: BotSlug;
  displayName: string;
  /**
   * BotFather username, with or without the leading "@". Null until
   * the owner creates this bot in @BotFather. The group handler only
   * trusts bot senders whose username is listed here.
   */
  username: string | null;
  /**
   * Profile photo reference: the repo path under public/ once the
   * owner picks the photo, or a Telegram file_id once set. Null until
   * set — the owner picks each bot's photo.
   */
  photoRef: string | null;
  /** Env var holding this bot's token. The VALUE never lives in the repo. */
  tokenEnvVar: string;
  /** Webhook path segment for this bot's updates (per-bot webhook). */
  webhookPath: string;
}

export const BOT_FACES: Record<BotSlug, BotFace> = {
  abel: {
    slug: "abel",
    displayName: "Abel",
    username: "@AbelExecutiveBot",
    photoRef: null,
    tokenEnvVar: "TELEGRAM_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/abel",
  },
  "dispatch-scout": {
    slug: "dispatch-scout",
    displayName: "Dispatch Scout",
    // Created by the owner in @BotFather 2026-11-19 ~2:35 PM CT; token
    // verified live and set in Fly as TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN
    // (staged). Still his steps: /setprivacy Disable for Scout, then
    // add Scout to the Road to Legacy Crew group.
    username: "@DispatchScoutBot",
    photoRef: null,
    tokenEnvVar: "TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/dispatch-scout",
  },
  tracker: {
    slug: "tracker",
    displayName: "Tracker",
    username: null,
    photoRef: null,
    tokenEnvVar: "TELEGRAM_TRACKER_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/tracker",
  },
  "compliance-watchdog": {
    slug: "compliance-watchdog",
    displayName: "Compliance Watchdog",
    username: null,
    photoRef: null,
    tokenEnvVar: "TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/compliance-watchdog",
  },
  maintenance: {
    slug: "maintenance",
    displayName: "Maintenance",
    username: null,
    photoRef: null,
    tokenEnvVar: "TELEGRAM_MAINTENANCE_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/maintenance",
  },
  billing: {
    slug: "billing",
    displayName: "Billing",
    username: null,
    photoRef: null,
    tokenEnvVar: "TELEGRAM_BILLING_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/billing",
  },
  auditor: {
    slug: "auditor",
    displayName: "Auditor",
    username: null,
    photoRef: null,
    tokenEnvVar: "TELEGRAM_AUDITOR_BOT_TOKEN",
    webhookPath: "/api/telegram/webhook/auditor",
  },
};

export function faceFor(slug: BotSlug): BotFace {
  return BOT_FACES[slug];
}

/** Normalised username, without "@", lowercased. Telegram usernames are case-insensitive. */
function normaliseUsername(username: string): string {
  return username.replace(/^@/, "").toLowerCase();
}

/** The team bot usernames that exist so far (faces already created in @BotFather). */
export function teamBotUsernames(): string[] {
  return (Object.values(BOT_FACES) as BotFace[])
    .map((face) => face.username)
    .filter((username): username is string => username !== null)
    .map(normaliseUsername);
}

/** Which team bot a username belongs to, or null when it is not one of the team's faces. */
export function slugForUsername(username: string | null | undefined): BotSlug | null {
  if (!username) return null;
  const wanted = normaliseUsername(username);
  for (const face of Object.values(BOT_FACES) as BotFace[]) {
    if (face.username !== null && normaliseUsername(face.username) === wanted) return face.slug;
  }
  return null;
}

/** True only for a username listed as one of the team's faces. An unknown bot is never trusted. */
export function isTeamBotUsername(username: string | null | undefined): boolean {
  return slugForUsername(username) !== null;
}

/** True when the face exists in @BotFather (username set). Token presence is a runtime env check, not a registry fact. */
export function faceConfigured(slug: BotSlug): boolean {
  return BOT_FACES[slug].username !== null;
}
