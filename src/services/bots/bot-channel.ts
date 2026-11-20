// The bot-to-bot channel: how team bots pick up each other's group
// messages — the group chat IS the shared channel (owner's model,
// 2026-11-19: everything posted in the room lands for all the bots;
// when Abel needs Watchdog he posts in the group addressed to
// Watchdog, and Watchdog picks it up there).
//
// TELEGRAM MECHANICS — verified against Telegram's own Bot Features
// documentation (core.telegram.org/bots/features, "Bot-to-Bot
// Communication", read 2026-11-19):
// - By default bots cannot see messages from other bots. The Bots
//   FAQ still carries that absolute line; the Features page documents
//   the exception below, and the exception is what this channel is
//   built on.
// - In a group, a bot receives another bot's message when it is
//   ADDRESSED to it — mentioned in a command (/command@OtherBot) or
//   a direct reply to the bot's message — provided at least one of
//   the two bots has Bot-to-Bot Communication Mode enabled in
//   @BotFather (/setbot2bot).
// - A bot with Bot-to-Bot Communication Mode enabled receives ALL
//   bot messages in the group (no mention or reply needed) when it
//   is a group admin OR has Group Privacy Mode disabled.
// - Humans are the easy half: every bot in the group receives the
//   owner's messages when its privacy mode is disabled (set BEFORE
//   joining the group, or remove and re-add the bot after changing
//   it) or when it is a group admin.
// - Telegram REQUIRES deduplication, rate limits, and a maximum
//   interaction depth when bot-to-bot is on ("Your bot must remain
//   stable even if another bot intentionally responds instantly and
//   continuously"). The safeguards below are that requirement, in
//   code: redelivery dedupe by message id, a chain-depth cap that
//   only a human message resets, the router's address rules (a bot
//   is woken only by a mention, a reply, or its own job keywords —
//   never by unaddressed chatter, never by itself), and the per-bot
//   spend caps that already gate every model turn.
//
// ACTIVATION REALITY: Telegram delivers each bot's updates to that
// bot's own webhook. Today the backend runs ONE webhook (the shared
// bot), so bot-authored updates cannot arrive yet — a bot never
// receives its own posts, and the shared bot has no other team bot
// posting as itself to hear. This module is the receiving logic,
// wired into the group handler now and unit-tested; it starts
// working the moment a second bot gets its own account + webhook
// (individual faces: each bot its own BotFather account, Bot-to-Bot
// Communication Mode ON, Group Privacy OFF, token in Fly). The
// structured handoff records (bots store, action 'handoff') carry
// the same work inside the backend until then — and the handoff is
// always ALSO posted in the room, so the owner sees every exchange;
// nothing coordinates in a database the owner never sees.

import { BOT_FACES, botFaceUsername } from "./faces";
import type { BotSlug } from "./registry";
import type { GroupRoute } from "./router";

/**
 * The most consecutive bot messages the room will answer without a
 * human speaking. Telegram's loop-prevention requirement, as a
 * number: at the cap, bots keep logging what they hear but stop
 * answering bots until the owner (or any human) posts again.
 */
export const MAX_BOT_CHAIN_DEPTH = 4;

/**
 * Which team bot a Telegram username belongs to, from the registry's
 * recorded usernames. Case-insensitive (Telegram usernames are).
 * Null for anything else — an unlisted bot is not in the room.
 */
export function identifyTeamBot(username: string | null | undefined): BotSlug | null {
  if (!username) return null;
  const wanted = username.replace(/^@/, "").toLowerCase();
  // One authoritative source (BT-006): each face's username — TELEGRAM_<BOT>_BOT_USERNAME, else the faces table.
  for (const face of Object.values(BOT_FACES)) {
    const username = botFaceUsername(face.slug);
    if (username && username.toLowerCase() === wanted) return face.slug;
  }
  return null;
}

export interface BotPickupVerdict {
  pickup: boolean;
  /** Why, in plain words — logged with the message, never posted. */
  reason: string;
}

/**
 * Decide whether a bot-authored group message gets answered, and by
 * the bot it routes to. Pure: the caller supplies the route (router)
 * and the chain depth (counted from the room's message log: bot
 * messages at the head, newest first, until the first human one).
 *
 * Rules, in order:
 * 1. A bot never answers itself (the router can route a bot's own
 *    words back to it by keyword — that is chatter, not a call).
 * 2. An unseated seat is not answered (it is not in the room yet).
 * 3. The router's shouldAnswer is the address test: mention, reply,
 *    or the bot's own job gate. Unaddressed bot chatter is heard
 *    (logged) but wakes nobody.
 * 4. The chain-depth cap: at MAX_BOT_CHAIN_DEPTH consecutive bot
 *    messages, bots stop answering bots until a human speaks.
 */
export function evaluateBotPickup(input: {
  senderSlug: BotSlug;
  route: GroupRoute;
  chainDepth: number;
}): BotPickupVerdict {
  if (input.route.target === input.senderSlug) {
    return { pickup: false, reason: "a bot never answers its own message" };
  }
  if (!input.route.seated) {
    return { pickup: false, reason: `${input.route.target} is not seated in the room yet` };
  }
  if (!input.route.shouldAnswer) {
    return { pickup: false, reason: "not addressed to a bot that should answer — heard and logged only" };
  }
  if (input.chainDepth >= MAX_BOT_CHAIN_DEPTH) {
    return {
      pickup: false,
      reason: `bot chain depth ${input.chainDepth} reached the cap of ${MAX_BOT_CHAIN_DEPTH} — bots stop answering bots until a human speaks`,
    };
  }
  return { pickup: true, reason: `addressed to ${input.route.target} via ${input.route.via}` };
}

/**
 * Chain depth from the room log (newest first): how many bot
 * messages sit at the head of the log with no human message among
 * them. A human post resets the chain to zero by definition.
 */
export function botChainDepth(recentNewestFirst: { sender_kind: string }[]): number {
  let depth = 0;
  for (const row of recentNewestFirst) {
    if (row.sender_kind !== "bot") break;
    depth += 1;
  }
  return depth;
}
