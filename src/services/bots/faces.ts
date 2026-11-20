// Per-bot Telegram faces — ONE module for the whole team (unified
// 2026-11-19 in the merge lane: Billing's and Tracker's parallel
// faces.ts files carried different APIs over the same facts; this is
// the single surviving module, exporting both API families over one
// BOT_FACES table).
//
// Owner decision 2026-11-19: each bot gets its OWN Telegram account
// (own BotFather token) and its own profile photo, and messages as
// itself in the group — the owner wants to see each bot's face when
// it talks. The one-face model was rejected.
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
//   group.ts), bot chains/handoffs are depth-capped, a bot answers
//   another bot only when addressed, and bots are structurally
//   barred from the proposal decision grammar.
//
// What does NOT exist yet (owner/ops steps, never in the repo):
// most of the bot accounts themselves. `username` is null until the
// owner creates the account in @BotFather; the token lives in Fly
// secrets only (TELEGRAM_<BOT>_BOT_TOKEN), never in the repo, never
// in chat. This module carries the SHAPE (env var names, setup
// checklist, settings verification, sender trust) so the wiring is
// ready the day the accounts exist. No username is invented here:
// Abel (@AbelExecutiveBot) and Dispatch Scout (@DispatchScoutBot)
// are recorded because the owner created them and their tokens were
// verified live on 2026-11-19.

import type { BotSlug } from "./registry";
import { BOT_REGISTRY } from "./registry";
import { botUsernameFor } from "./sending";

export interface BotFace {
  slug: BotSlug;
  displayName: string;
  /**
   * BotFather username, without the leading "@". Null until the
   * owner creates this bot in @BotFather. The group handler only
   * trusts bot senders whose username is listed here.
   */
  username: string | null;
  /**
   * Profile photo reference: the repo path under public/ once the
   * owner picks the photo, or a Telegram file_id once set. Null
   * until set — the owner picks each bot's photo.
   */
  photoRef: string | null;
  /** Profile photo: the owner sets each bot's photo himself. */
  photoStatus: "not-set" | "set";
  /** Env var holding this bot's BotFather token (Fly secret). The VALUE never lives in the repo. */
  tokenEnvVar: string;
  /** Webhook path segment for this bot's updates (per-bot webhook). */
  webhookPath: string;
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
  abel: { slug: "abel", displayName: "Abel", username: "AbelExecutiveBot", photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_BOT_TOKEN", webhookPath: "/api/telegram/webhook/abel" },
  // Created by the owner in @BotFather 2026-11-19 ~2:35 PM CT; token
  // verified live and set in Fly as TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN.
  "dispatch-scout": { slug: "dispatch-scout", displayName: "Dispatch Scout", username: "DispatchScoutBot", photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN", webhookPath: "/api/telegram/webhook/dispatch-scout" },
  tracker: { slug: "tracker", displayName: "Tracker", username: null, photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_TRACKER_BOT_TOKEN", webhookPath: "/api/telegram/webhook/tracker" },
  "compliance-watchdog": { slug: "compliance-watchdog", displayName: "Compliance Watchdog", username: null, photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN", webhookPath: "/api/telegram/webhook/compliance-watchdog" },
  maintenance: { slug: "maintenance", displayName: "Maintenance", username: null, photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_MAINTENANCE_BOT_TOKEN", webhookPath: "/api/telegram/webhook/maintenance" },
  billing: { slug: "billing", displayName: "Billing", username: null, photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_BILLING_BOT_TOKEN", webhookPath: "/api/telegram/webhook/billing" },
  auditor: { slug: "auditor", displayName: "Auditor", username: null, photoRef: null, photoStatus: "not-set", tokenEnvVar: "TELEGRAM_AUDITOR_BOT_TOKEN", webhookPath: "/api/telegram/webhook/auditor" },
};

export function botFace(slug: BotSlug): BotFace {
  return BOT_FACES[slug];
}

/** Same lookup as botFace — the name Tracker's code uses. */
export function faceFor(slug: BotSlug): BotFace {
  return BOT_FACES[slug];
}

/**
 * The bot's Telegram username (owner 2026-11-20: EVERY bot gets its own BotFather account).
 * Not a secret: TELEGRAM_<BOT>_BOT_USERNAME (sending.ts botUsernameFor — set when the account
 * is created, no code change), else the table above. Null = account not created yet.
 */
export function botFaceUsername(slug: BotSlug, env: Record<string, string | undefined> = process.env): string | null {
  return botUsernameFor(slug, env) ?? BOT_FACES[slug].username;
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
