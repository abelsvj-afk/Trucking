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
// Phase 0 wired only Abel + Dispatch Scout into the room; Billing
// joined in Phase 2. The router still names the intended bot for
// the other seats; the group handler answers those with "not in the
// room yet" instead of pretending the bot is there.

import { GROUP_SEATS, isBotSlug, type BotSlug } from "./registry";

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

// Mention order matters: Billing's money terms are checked BEFORE
// Dispatch Scout's "broker". "Has the broker paid the invoice?" is
// Billing's job (payment status) even though it names a broker; a
// bare "find me a broker" still reaches the Scout, because none of
// Billing's patterns match it. The same order applies in the keyword
// list below: a message about money owed goes to Billing first.
// A bot's Telegram username (@DispatchScoutBot) is a mention too —
// it has no word boundaries inside it, so it needs its own pattern.
const MENTION_PATTERNS: { slug: BotSlug; patterns: RegExp[] }[] = [
  { slug: "abel", patterns: [/\babe\b/i, /\babel\b/i] },
  { slug: "billing", patterns: [/\bbilling\b/i, /\binvoice\b/i, /\bfactoring\b/i, /\bshort[-\s]?paid?\b/i, /\boverdue\b/i, /\bdeduction\b/i, /\b(broker|shipper)\b[^.!?]{0,50}\bpaid\b/i, /\bpaid\b[^.!?]{0,50}\b(broker|invoice)\b/i] },
  { slug: "dispatch-scout", patterns: [/@?dispatchscoutbot\b/i, /\bdispatch scout\b/i, /\bscout\b/i, /\bdispatch\b/i, /\bbroker\b/i] },
  { slug: "tracker", patterns: [/\btracker\b/i] },
  { slug: "compliance-watchdog", patterns: [/\bwatchdog\b/i, /\bcompliance\b/i, /\bsafety\b/i] },
  { slug: "maintenance", patterns: [/\bmaintenance\b/i, /\bshop\b/i, /\brepair\b/i] },
  { slug: "auditor", patterns: [/\bauditor\b/i, /\bcheck (this|that|it)\b/i, /\bverify\b/i] },
];

const KEYWORD_ROUTES: { slug: BotSlug; patterns: RegExp[] }[] = [
  // Billing first, for the same precedence reason as mentions: money
  // owed is Billing's job even when the sentence also names a load.
  // Bare "paid" is deliberately NOT here — "when do I get paid" is a
  // paycheck question for Abel, not an invoice question. Only the
  // unpaid / not-been-paid forms route to Billing.
  {
    slug: "billing",
    patterns: [
      /\bpay me\b/i,
      /\bsettlement\b/i,
      /\binvoice\b/i,
      /\bdetention pay\b/i,
      /\bunpaid\b/i,
      /\boverdue\b/i,
      /\bshort[-\s]?paid?\b/i,
      /\bdeduction\b/i,
      /\bfactoring\b/i,
      /\bpayment status\b/i,
      /\bwho owes\b/i,
      /\b(hasn'?t|haven'?t|has not|have not|not) been paid\b/i,
      /\bstill (waiting|owed)\b/i,
    ],
  },
  // Tracker before Dispatch Scout: POD / BOL / ETA are more specific
  // than the generic word "load", so "POD signed for the Detroit
  // load" is Tracker's job (delivery paperwork), not a load search.
  // A bare "find me a load" has no tracker term and still reaches
  // the Scout.
  {
    slug: "tracker",
    patterns: [/\beta\b/i, /\bcheck.call\b/i, /\bcheck call\b/i, /\bshipper\b/i, /\breceiver\b/i, /\bpod\b/i, /\bbol\b/i],
  },
  {
    slug: "dispatch-scout",
    patterns: [/\bload\b/i, /\brate\b/i, /\bbroker\b/i, /\bdeadhead\b/i, /\bper mile\b/i, /\bshortlist\b/i, /\bpickup\b/i, /\bdelivery\b/i],
  },
  {
    slug: "compliance-watchdog",
    patterns: [/\bhours\b/i, /\bduty\b/i, /\blog\b/i, /\bhos\b/i, /\brest\b/i, /\bsleeper\b/i],
  },
  {
    slug: "maintenance",
    patterns: [/\binspection\b/i, /\bmaintenance\b/i, /\bshop\b/i, /\bbreakdown\b/i, /\btire\b/i],
  },
  {
    slug: "auditor",
    patterns: [/\bdoes (that|this) add up\b/i, /\bmath\b/i, /\bwrong\b/i],
  },
];

export function routeGroupMessage(input: GroupMessageInput): GroupRoute {
  const text = input.text.trim();

  // A reply to a bot's message goes to that bot.
  if (input.replyToBotSlug && isBotSlug(input.replyToBotSlug)) {
    return {
      target: input.replyToBotSlug,
      via: "reply",
      shouldAnswer: true,
      seated: GROUP_SEATS.includes(input.replyToBotSlug),
    };
  }

  // A name mention goes to the named bot.
  for (const { slug, patterns } of MENTION_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { target: slug, via: "mention", shouldAnswer: true, seated: GROUP_SEATS.includes(slug) };
    }
  }

  // A job keyword goes to the bot whose job it is.
  for (const { slug, patterns } of KEYWORD_ROUTES) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { target: slug, via: "keyword", shouldAnswer: true, seated: GROUP_SEATS.includes(slug) };
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
  const name = target === "dispatch-scout" ? "Dispatch Scout" : target;
  return `${name} isn't in the room yet — that seat comes in a later phase. Abel can take this one for now.`;
}
