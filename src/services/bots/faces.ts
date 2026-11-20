// Per-bot Telegram faces (Phase 2; owner decision 2026-11-19).
// Each bot gets its OWN Telegram account (own BotFather token) and
// its own profile photo, and messages as itself in the group — the
// owner wants to see each bot's face when it talks. The one-face
// model was rejected.
//
// Verified Telegram mechanics (core.telegram.org/api/bots/bot-to-bot,
// Bot API 9.6, read 2026-11-19 — this supersedes the Bots FAQ line
// "bots will not be able to see messages from other bots regardless
// of mode", which is the pre-9.6 rule):
// - Bot-to-Bot Communication Mode ON in @BotFather
//   (/mybots → Bot Settings → Bot-to-Bot Communication Mode → ON)
//   for every bot that participates.
// - Group Privacy OFF in @BotFather (or the bot is an admin in the
//   group). The bot must be REMOVED and RE-ADDED to the group after
//   a privacy change, or the change does not apply.
// - Then, in a group: a bot receives another bot's message when the
//   message contains a command mention addressed to it
//   (/command@TargetBot), when it is a direct reply to one of its
//   messages, and — with the mode on AND admin / privacy-off —
//   ALL of the other bots' messages, with no mention or reply
//   needed. At least one of the two bots must have the mode on.
// - Every bot with privacy off also receives every message the
//   OWNER posts: the group is the shared channel, and the owner's
//   words land for all the bots.
// - Loop warning, from Telegram itself: bot-to-bot communication
//   can create infinite reply loops — handling must terminate
//   predictably. This codebase bounds it: one webhook update is
//   claimed exactly once (room-log unique key, services/bots/
//   group.ts), one update produces at most one routed answer plus
//   at most one Billing note, and a bot's turn never invokes
//   another bot's turn in-process except the single Abel→Billing
//   fan-out, which is flag-gated off once Billing's own webhook
//   is live.
//
// What does NOT exist yet (owner/ops steps, never in the repo):
// the bot accounts themselves. `username` is null until the owner
// creates the account in @BotFather; the token lives in Fly secrets
// only (TELEGRAM_<BOT>_BOT_TOKEN), never in the repo, never in chat.
// This module carries the SHAPE (env var names, setup checklist,
// settings verification) so the wiring is ready the day the
// accounts exist. No username is invented here.

import type { BotSlug } from "./registry";
import { BOT_REGISTRY } from "./registry";

export interface BotFace {
  slug: BotSlug;
  displayName: string;
  /** Env var holding this bot's BotFather token (Fly secret). */
  tokenEnvVar: string;
  /** @BotFather username, e.g. "RoadToLegacyBillingBot". Null until the owner creates the account. */
  username: string | null;
  /** Profile photo: the owner sets each bot's photo himself. */
  photoStatus: "not-set" | "set";
}

/** Required BotFather settings for the group-as-channel shape. */
export const BOT_TO_BOT_SETTINGS = {
  /** @BotFather → /mybots → Bot Settings → Bot-to-Bot Communication Mode → ON. */
  botToBotMode: "Bot-to-Bot Communication Mode: ON",
  /** @BotFather → /mybots → Bot Settings → Group Privacy → OFF (or the bot is a group admin). */
  groupPrivacy: "Group Privacy: OFF (or group admin)",
  /** A privacy change applies only after the bot is removed and re-added to the group. */
  readdAfterPrivacyChange: "Remove and re-add the bot to the group after any privacy change",
  docUrl: "https://core.telegram.org/api/bots/bot-to-bot",
} as const;

export const BOT_FACES: Record<BotSlug, BotFace> = {
  abel: { slug: "abel", displayName: "Abel", tokenEnvVar: "TELEGRAM_BOT_TOKEN", username: null, photoStatus: "not-set" },
  "dispatch-scout": { slug: "dispatch-scout", displayName: "Dispatch Scout", tokenEnvVar: "TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN", username: "DispatchScoutBot", photoStatus: "not-set" },
  tracker: { slug: "tracker", displayName: "Tracker", tokenEnvVar: "TELEGRAM_TRACKER_BOT_TOKEN", username: null, photoStatus: "not-set" },
  "compliance-watchdog": { slug: "compliance-watchdog", displayName: "Compliance Watchdog", tokenEnvVar: "TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN", username: null, photoStatus: "not-set" },
  maintenance: { slug: "maintenance", displayName: "Maintenance", tokenEnvVar: "TELEGRAM_MAINTENANCE_BOT_TOKEN", username: null, photoStatus: "not-set" },
  billing: { slug: "billing", displayName: "Billing", tokenEnvVar: "TELEGRAM_BILLING_BOT_TOKEN", username: null, photoStatus: "not-set" },
  auditor: { slug: "auditor", displayName: "Auditor", tokenEnvVar: "TELEGRAM_AUDITOR_BOT_TOKEN", username: null, photoStatus: "not-set" },
};

export function botFace(slug: BotSlug): BotFace {
  return BOT_FACES[slug];
}

/** Token for one bot's face, from the environment. Null = the account is not wired yet. */
export function botFaceToken(slug: BotSlug, env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[BOT_FACES[slug].tokenEnvVar];
  return raw && raw.trim() !== "" ? raw : null;
}

export interface BotFaceStatus {
  slug: BotSlug;
  displayName: string;
  tokenEnvVar: string;
  tokenPresent: boolean;
  username: string | null;
  photoStatus: "not-set" | "set";
  /** What is still missing before this face can speak in the group. */
  missing: string[];
}

/** Pure env check: is this bot's face wired? No network, no secrets read out. */
export function resolveBotFace(slug: BotSlug, env: Record<string, string | undefined> = process.env): BotFaceStatus {
  const face = BOT_FACES[slug];
  const tokenPresent = botFaceToken(slug, env) !== null;
  const missing: string[] = [];
  if (!tokenPresent) missing.push(`Fly secret ${face.tokenEnvVar} is not set`);
  if (!face.username) missing.push("Telegram account not created yet in @BotFather (no username)");
  if (face.photoStatus !== "set") missing.push("Profile photo not set yet (owner sets it)");
  return {
    slug,
    displayName: face.displayName,
    tokenEnvVar: face.tokenEnvVar,
    tokenPresent,
    username: face.username,
    photoStatus: face.photoStatus,
    missing,
  };
}

/** The BotFather + group setup steps for one bot's face, in order. */
export function botFaceSetupChecklist(slug: BotSlug): string[] {
  const face = BOT_FACES[slug];
  return [
    `Create the account in @BotFather (/newbot) — ${face.displayName}. The token goes into the Fly secret ${face.tokenEnvVar}; it never goes in the repo or in chat.`,
    `Enable ${BOT_TO_BOT_SETTINGS.botToBotMode} for the new bot.`,
    `Set ${BOT_TO_BOT_SETTINGS.groupPrivacy} for the new bot.`,
    `Add the bot to the private group (and make it an admin if privacy stays on). ${BOT_TO_BOT_SETTINGS.readdAfterPrivacyChange}.`,
    `Set the webhook to /api/telegram/webhook?bot=${slug} (the app routes by the ?bot= parameter).`,
    `Set the bot's profile photo (owner sets it).`,
    `Send one test message in the group and confirm the bot answers as ${face.displayName}.`,
  ];
}

/** Display names as they prefix room messages ("Billing: ..."). */
const ROOM_SPEAKER_NAMES: Record<string, BotSlug> = {
  abel: "abel",
  "dispatch scout": "dispatch-scout",
  scout: "dispatch-scout",
  tracker: "tracker",
  "compliance watchdog": "compliance-watchdog",
  watchdog: "compliance-watchdog",
  maintenance: "maintenance",
  billing: "billing",
  auditor: "auditor",
};

/**
 * Attribute a room message to its speaker from the "Name: ..."
 * prefix the sender puts on it. Used ONLY to log who spoke in the
 * room record — never to route a live webhook update (Telegram
 * delivers the sender in the update itself). Returns null for
 * unprefixed text.
 */
export function parseRoomSpeaker(text: string): BotSlug | null {
  const match = text.match(/^\s*([A-Za-z ]+):\s/);
  if (!match) return null;
  return ROOM_SPEAKER_NAMES[match[1]!.trim().toLowerCase()] ?? null;
}

/** Display name for addressing a bot by name in the room. */
export function roomDisplayName(slug: BotSlug): string {
  return BOT_REGISTRY[slug].displayName;
}

export interface BotFaceLiveStatus {
  /** getMe can_read_all_group_messages: true = Group Privacy is OFF. */
  canReadAllGroupMessages: boolean | null;
  canJoinGroups: boolean | null;
  username: string | null;
}

/**
 * Live check of one bot's BotFather settings via getMe (no secrets
 * logged, no message sent). Only called by ops tooling with the
 * bot's token in hand — never in the request path. `fetchImpl` is
 * injectable so tests can fake Telegram.
 */
export async function fetchBotFaceStatus(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BotFaceLiveStatus> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
  if (!res.ok) throw new Error(`[faces] getMe failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    ok?: boolean;
    result?: { can_join_groups?: boolean; can_read_all_group_messages?: boolean; username?: string };
  };
  if (!body.ok || !body.result) throw new Error("[faces] getMe failed: unexpected response");
  return {
    canReadAllGroupMessages: typeof body.result.can_read_all_group_messages === "boolean" ? body.result.can_read_all_group_messages : null,
    canJoinGroups: typeof body.result.can_join_groups === "boolean" ? body.result.can_join_groups : null,
    username: body.result.username ?? null,
  };
}
