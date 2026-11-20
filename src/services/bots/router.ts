// Group-chat routing (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// One private group, him + the bots. Every bot hears every message;
// only the relevant one answers, the rest stay quiet.
//
// Routing order: a reply to a bot's message goes to that bot; a name
// mention goes to the named bot; a job keyword goes to the bot whose
// job it is; everything else goes to Abel. The router is pure — no
// database, no network — so the same message always routes the same
// way and the tests can prove it.
//
// Phase 0 wires only Abel + Dispatch Scout into the room. The router
// still names the intended bot for the other seats; the group handler
// answers those with "not in the room yet" instead of pretending the
// bot is there.

import {
  shouldWatchdogSpeak,
  WATCHDOG_KEYWORD_PATTERNS,
  WATCHDOG_MENTION_PATTERNS,
  type SpeakVia,
} from "./compliance-watchdog";
import { BOT_REGISTRY, GROUP_SEATS, isBotSlug, type BotSlug } from "./registry";

export interface GroupMessageInput {
  text: string;
  /** 'owner' for Sajacous; 'bot' for a bot speaking in the room. */
  senderKind: "owner" | "bot";
  /** Bot slug when senderKind is 'bot'. */
  senderSlug?: BotSlug;
  /** Bot slug of the message this one replies to, when it replies to one. */
  replyToBotSlug?: BotSlug;
}

export interface GroupRoute {
  /** The bot this message is for. */
  target: BotSlug;
  /** How the route was decided. */
  via: "reply" | "mention" | "keyword" | "default";
  /** Whether the target bot should answer out loud. */
  shouldAnswer: boolean;
  /** True when the target seat is wired into the room in this phase. */
  seated: boolean;
}

const MENTION_PATTERNS: { slug: BotSlug; patterns: RegExp[] }[] = [
  { slug: "abel", patterns: [/\babe\b/i, /\babel\b/i] },
  { slug: "dispatch-scout", patterns: [/\bdispatch scout\b/i, /\bscout\b/i, /\bdispatch\b/i] },
  { slug: "tracker", patterns: [/\btracker\b/i] },
  // Watchdog's mention patterns live in its own module (the speak gate).
  { slug: "compliance-watchdog", patterns: WATCHDOG_MENTION_PATTERNS },
  { slug: "maintenance", patterns: [/\bmaintenance\b/i, /\bshop\b/i, /\brepair\b/i] },
  { slug: "billing", patterns: [/\bbilling\b/i, /\binvoice\b/i] },
  { slug: "auditor", patterns: [/\bauditor\b/i, /\bcheck (this|that|it)\b/i, /\bverify\b/i] },
];

const KEYWORD_ROUTES: { slug: BotSlug; patterns: RegExp[] }[] = [
  {
    slug: "dispatch-scout",
    patterns: [/\bload\b/i, /\brate\b/i, /\bbroker\b/i, /\bdeadhead\b/i, /\bper mile\b/i, /\bshortlist\b/i, /\bpickup\b/i, /\bdelivery\b/i],
  },
  {
    // Watchdog's job words live in its own module (the speak gate):
    // strong compliance terms plus the HOS words. A message that
    // only brushes its job ("what are the receiver's hours?") still
    // routes here — the turn hands it off in words to the bot whose
    // job it is instead of answering outside its job.
    slug: "compliance-watchdog",
    patterns: WATCHDOG_KEYWORD_PATTERNS,
  },
  {
    slug: "billing",
    patterns: [/\bpay me\b/i, /\bsettlement\b/i, /\binvoice\b/i, /\bdetention pay\b/i],
  },
  {
    slug: "maintenance",
    patterns: [/\binspection\b/i, /\bmaintenance\b/i, /\bshop\b/i, /\bbreakdown\b/i, /\btire\b/i],
  },
  {
    slug: "tracker",
    patterns: [/\beta\b/i, /\bcheck.call\b/i, /\bcheck call\b/i, /\bshipper\b/i, /\breceiver\b/i, /\bpod\b/i, /\bbol\b/i],
  },
  {
    slug: "auditor",
    patterns: [/\bdoes (that|this) add up\b/i, /\bmath\b/i, /\bwrong\b/i],
  },
];

export function routeGroupMessage(input: GroupMessageInput): GroupRoute {
  const text = input.text.trim();

  // Watchdog's speak gate decides for its own seat; every other bot
  // answers when routed to it, as today. A reply to a bot's message
  // is being called by name — Watchdog speaks.
  const speakFor = (slug: BotSlug, via: SpeakVia): boolean =>
    slug === "compliance-watchdog" ? shouldWatchdogSpeak({ text, via }) : true;

  // A reply to a bot's message goes to that bot.
  if (input.replyToBotSlug && isBotSlug(input.replyToBotSlug)) {
    return {
      target: input.replyToBotSlug,
      via: "reply",
      shouldAnswer: speakFor(input.replyToBotSlug, "reply"),
      seated: GROUP_SEATS.includes(input.replyToBotSlug),
    };
  }

  // A name mention goes to the named bot.
  for (const { slug, patterns } of MENTION_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { target: slug, via: "mention", shouldAnswer: speakFor(slug, "mention"), seated: GROUP_SEATS.includes(slug) };
    }
  }

  // A job keyword goes to the bot whose job it is.
  for (const { slug, patterns } of KEYWORD_ROUTES) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { target: slug, via: "keyword", shouldAnswer: speakFor(slug, "keyword"), seated: GROUP_SEATS.includes(slug) };
    }
  }

  // Everything else goes to Abel. A bot speaking in the room is never
  // routed to itself unless it was mentioned or replied to — bots do
  // not answer their own chatter.
  return {
    target: "abel",
    via: "default",
    shouldAnswer: input.senderKind === "owner",
    seated: true,
  };
}

/** The one-line reply when a message routes to a seat not wired yet. */
export function unseatedReply(target: BotSlug): string {
  const name = BOT_REGISTRY[target].displayName;
  return `${name} isn't in the room yet — that seat comes in a later phase. Abel can take this one for now.`;
}
