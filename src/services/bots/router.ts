// Group-chat routing (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// One private group, him + the bots — each bot messaging as itself
// under its own Telegram account + profile photo (owner, 2026-11-19:
// INDIVIDUAL FACES; the one-face model was rejected). Bot-to-bot
// delivery is Telegram's opt-in Bot-to-Bot Communication Mode
// (@BotFather /setbot2bot; by default bots never see each other —
// Bots FAQ): with the mode on per account, a teammate's group
// message addressed to a bot reaches that bot's account, so the
// group itself is the shared channel. Routing here decides which
// internal agent a message is FOR; the coordinator owns the final
// answer for the owner's messages.
//
// Routing order: a reply to a bot's message goes to that bot; a
// handoff from another bot goes where that bot sends it — carried
// in-process (routedByBotSlug) or, once Bot-to-Bot Mode is enabled,
// as a real group message from the teammate's account, routed by
// the same rules with senderKind "bot"; a name mention goes to the
// named bot; a job keyword goes to the bot whose job it is;
// everything else goes to Abel (owner messages only — a bot's
// message never falls through to Abel's model turn). The router is
// pure — no database, no network — so the same message always
// routes the same way and the tests can prove it.
//
// The router only says who a message is FOR. Whether the target
// speaks is the target bot's own decision (Tracker:
// decideTrackerSpeech in services/bots/tracker.ts — the team-room
// rule, owner 2026-11-19: a bot speaks when it has something to
// add, answers another bot that addresses it, and stays quiet
// when it has nothing to add).

import {
  shouldWatchdogSpeak,
  WATCHDOG_KEYWORD_PATTERNS,
  WATCHDOG_MENTION_PATTERNS,
  type SpeakVia,
} from "./compliance-watchdog";
// AUDITOR ROUTING (owner, 2026-11-19 — team-room correction): the
// group chat is a team room, not a strict queue. Bots hand work
// off to each other in the room and in-process; Abel is the boss
// for what needs the owner's attention, not the only one who
// talks. That corrects the earlier too-strict rule ("only Abel
// routes, only the named bot answers"). Reconciled for the
// Auditor:
//   - Called by name → it answers.
//   - Routed to it by Abel OR handed off by any other bot → it answers.
//   - Its own turn → it answers: a draft has landed and needs
//     checking (a message carrying checkable numbers), or a check
//     has found a problem.
//   - A message that merely LOOKS like its job (a keyword, no name,
//     no handoff, nothing checkable in it) still does NOT wake it:
//     it stays quiet and defers to Abel, the coordinator — but Abel
//     settles it in the room where he can (handing it to the Auditor
//     by name, or answering it himself) and only pulls the owner in
//     when a decision or approval is needed.
//   - In the Auditor's own 1:1 chat (channel "direct") none of this
//     applies: there it handles its own job directly.
//
// The room seats Abel, Dispatch Scout, Billing, and the Auditor.
// The router still names the intended bot for the other seats; the
// group handler answers those with "not in the room yet" instead of
// pretending the bot is there.

import { BOT_REGISTRY, GROUP_SEATS, GROUP_SEATS_PHASE_0, isBotSlug, type BotSlug } from "./registry";
import { MAINTENANCE_KEYWORD_PATTERNS, MAINTENANCE_MENTION_PATTERNS } from "./maintenance";

export interface GroupMessageInput {
  text: string;
  /** 'owner' for Sajacous; 'bot' for a bot speaking in the room. */
  senderKind: "owner" | "bot";
  /** Bot slug when senderKind is 'bot'. */
  senderSlug?: BotSlug;
  /** Bot slug of the message this one replies to, when it replies to one. */
  replyToBotSlug?: BotSlug;
  /**
   * The bot that explicitly routed / handed this message off, when
   * one did. This is an IN-PROCESS handoff (supervisor-first: the
   * coordinator, or another bot's code, calls the router with the
   * job) — never a Telegram message between bots, which Telegram
   * does not deliver. Abel is the coordinator, but any bot may hand
   * work to another in the team room; a handoff from Scout, Tracker,
   * or anyone else counts the same as one from Abel.
   */
  routedByBotSlug?: BotSlug;
  /**
   * "group" (default): the shared room — the Auditor routing rule
   * applies, and an unclear job defers to Abel. "direct": the target
   * bot's own 1:1 chat — it handles its own job directly, no
   * deferral.
   */
  channel?: "group" | "direct";
}

export interface GroupRoute {
  /** The bot this message is for. */
  target: BotSlug;
  /** How the route was decided. */
  via: "reply" | "mention" | "keyword" | "default" | "abel-route" | "bot-handoff" | "own-turn";
  /** Whether the target bot should answer out loud. */
  shouldAnswer: boolean;
  /** True when the target seat is wired into the room in this phase. */
  seated: boolean;
  /**
   * Set when the message looks like the target's job but was not
   * clearly routed to it: the target stays quiet and this bot — the
   * coordinator — decides. Only the Auditor defers this way today.
   */
  deferredToCoordinator?: BotSlug;
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
  { slug: "dispatch-scout", patterns: [/@?dispatchscoutbot\b/i, /\bdispatch scout\b/i, /\bscout\b/i, /\bdispatch\b/i] },
  { slug: "tracker", patterns: [/\btracker\b/i] },
  { slug: "compliance-watchdog", patterns: WATCHDOG_MENTION_PATTERNS },
  { slug: "maintenance", patterns: MAINTENANCE_MENTION_PATTERNS.map((entry) => entry.pattern) },
  { slug: "billing", patterns: [/\bbilling\b/i, /\binvoice\b/i] },
  // Auditor: ONLY its name counts as being called by name. "Check
  // this" / "verify" are job signals, not a name — they live in the
  // keyword routes below, where the Auditor routing rule defers them
  // to Abel unless Abel routed the message or the chat is direct.
  { slug: "auditor", patterns: [/\bauditor\b/i] },
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
  {
    // Scout finds loads — the bare word "load" alone is NOT a Scout
    // keyword: every Tracker sentence about a load in progress ("what's
    // the eta on this load?", "the load was refused") contains it, and
    // routing those to Scout stole Tracker's job. Load-seeking phrases
    // only.
    slug: "dispatch-scout",
    patterns: [/\bnew load\b/i, /\bnext load\b/i, /\bfind (me )?(a )?load\b/i, /\bload board\b/i, /\brate\b/i, /\bbroker\b/i, /\bdeadhead\b/i, /\bper mile\b/i, /\bshortlist\b/i],
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
    slug: "maintenance",
    patterns: MAINTENANCE_KEYWORD_PATTERNS.map((entry) => entry.pattern),
  },
  {
    // Check-call verbs and escalation words are Tracker's job — a
    // status sentence ("delivered at Dollar Tree", "the load was
    // refused") routes here, not to Scout. "detention pay" is Billing's
    // and sits above this entry, so it still wins for pay questions.
    slug: "tracker",
    patterns: [/\beta\b/i, /\bcheck.call\b/i, /\bcheck call\b/i, /\bshipper\b/i, /\breceiver\b/i, /\bpod\b/i, /\bbol\b/i, /\bpicked up\b/i, /\bdelivered\b/i, /\barrived\b/i, /\bdeparted\b/i, /\ben route\b/i, /\bdetention\b/i, /\brefused\b/i, /\breschedul(e|ing)\b/i, /\bundeliverable\b/i],
  },
  {
    slug: "auditor",
    patterns: [/\bdoes (that|this) add up\b/i, /\bmath\b/i, /\bwrong\b/i, /\bcheck (this|that|it)\b/i, /\bverify\b/i, /\badd up\b/i],
  },
];

export function routeGroupMessage(input: GroupMessageInput): GroupRoute {
  const text = input.text.trim();
  const channel = input.channel ?? "group";

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

  // A bot handed this job off: it goes where that bot sends it.
  // Abel is the coordinator (via "abel-route"); any other bot's
  // handoff counts the same (via "bot-handoff"). A handoff that
  // names the Auditor or its job is a clear route, not a guess —
  // the Auditor answers.
  if (input.routedByBotSlug && isBotSlug(input.routedByBotSlug)) {
    const auditorMention = MENTION_PATTERNS.find((entry) => entry.slug === "auditor")?.patterns.some((pattern) =>
      pattern.test(text),
    ) ?? false;
    const auditorKeyword = KEYWORD_ROUTES.find((entry) => entry.slug === "auditor")?.patterns.some((pattern) =>
      pattern.test(text),
    ) ?? false;
    if (auditorMention || auditorKeyword) {
      return {
        target: "auditor",
        via: input.routedByBotSlug === "abel" ? "abel-route" : "bot-handoff",
        shouldAnswer: true,
        seated: GROUP_SEATS_PHASE_0.includes("auditor"),
      };
    }
  }

  // A name mention goes to the named bot.
  for (const { slug, patterns } of MENTION_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return { target: slug, via: "mention", shouldAnswer: speakFor(slug, "mention"), seated: GROUP_SEATS.includes(slug) };
    }
  }

  // A job keyword goes to the bot whose job it is — except the
  // Auditor in the group, which stays quiet on a bare keyword alone.
  // A keyword with nothing checkable in it is not a clear route: it
  // could be the owner's job for someone else, and the Auditor must
  // never jump in on another bot's job. It defers to Abel, the
  // coordinator, who settles it in the room. But a keyword WITH
  // checkable numbers is a draft that has landed — the Auditor's own
  // turn (a draft has landed and needs checking) — so it answers.
  // In the Auditor's own 1:1 chat (direct) there is nobody else to
  // defer to, so it answers on the keyword alone.
  for (const { slug, patterns } of KEYWORD_ROUTES) {
    if (patterns.some((pattern) => pattern.test(text))) {

      if (slug === "auditor" && channel === "group") {
        if (/\$\s?[\d,]+|\b\d[\d,]*\s*(?:mi|miles)\b/i.test(text)) {
          return {
            target: "auditor",
            via: "own-turn",
            shouldAnswer: true,
            seated: GROUP_SEATS_PHASE_0.includes("auditor"),
          };
        }
        return {
          target: "auditor",
          via: "keyword",
          shouldAnswer: false,
          seated: GROUP_SEATS_PHASE_0.includes("auditor"),
          deferredToCoordinator: "abel",
        };
      }
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

/**
 * The one-line reply when a message routes to a seat not wired yet.
 * Abel never does a specialist's job himself (owner group-routing
 * rule 2026-11-19), so this promises no stand-in — the job waits for
 * its seat.
 */
export function unseatedReply(target: BotSlug): string {
  const name = BOT_REGISTRY[target].displayName;
  return `${name} isn't in the room yet — that seat comes in a later phase. Abel can take this one for now.`;
}
