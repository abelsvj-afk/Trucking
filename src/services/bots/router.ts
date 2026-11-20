// Group-chat routing (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// One private group, him + the bots — each bot messaging as itself
// under its own Telegram account + profile photo (owner, 2026-11-19:
// INDIVIDUAL FACES; the one-face model was rejected). What Telegram
// still blocks: bots "will not be able to see messages from other
// bots regardless of mode" (Bots FAQ, verified 2026-11-19), so a
// bot's account is a sender face, not a reader of other bots — the
// bots coordinate internally (Supabase / in-process calls) and each
// posts under its own name. Routing here decides which internal
// agent a message is FOR; the coordinator owns the final answer.
//
// Routing order: a reply to a bot's message goes to that bot; an
// in-process handoff from another bot goes where that bot sends it
// (routedByBotSlug — a code-level handoff, never a Telegram message
// between bots); a name mention goes to the named bot; a job keyword
// goes to the bot whose job it is; everything else goes to Abel. The
// router is pure — no database, no network — so the same message
// always routes the same way and the tests can prove it.
//
// AUDITOR ROUTING (owner, 2026-11-19 — team-room correction): the
// group chat is a team room, not a strict queue. Bots hand work off
// to each other INTERNALLY (in-process / Supabase — never by
// Telegram message, which Telegram does not deliver between bots);
// Abel is the boss for what needs the owner's attention, not the
// only one who talks. That corrects the earlier too-strict rule
// ("only Abel routes, only the named bot answers"). Reconciled for
// the Auditor:
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
// Phase 0 seats Abel, Dispatch Scout, and the Auditor in the room.
// The router still names the intended bot for the other seats; the
// group handler answers those with "not in the room yet" instead of
// pretending the bot is there.

import { GROUP_SEATS_PHASE_0, isBotSlug, type BotSlug } from "./registry";

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

const MENTION_PATTERNS: { slug: BotSlug; patterns: RegExp[] }[] = [
  { slug: "abel", patterns: [/\babe\b/i, /\babel\b/i] },
  { slug: "dispatch-scout", patterns: [/\bdispatch scout\b/i, /\bscout\b/i, /\bdispatch\b/i] },
  { slug: "tracker", patterns: [/\btracker\b/i] },
  { slug: "compliance-watchdog", patterns: [/\bwatchdog\b/i, /\bcompliance\b/i, /\bsafety\b/i] },
  { slug: "maintenance", patterns: [/\bmaintenance\b/i, /\bshop\b/i, /\brepair\b/i] },
  { slug: "billing", patterns: [/\bbilling\b/i, /\binvoice\b/i] },
  // Auditor: ONLY its name counts as being called by name. "Check
  // this" / "verify" are job signals, not a name — they live in the
  // keyword routes below, where the Auditor routing rule defers them
  // to Abel unless Abel routed the message or the chat is direct.
  { slug: "auditor", patterns: [/\bauditor\b/i] },
];

const KEYWORD_ROUTES: { slug: BotSlug; patterns: RegExp[] }[] = [
  {
    slug: "dispatch-scout",
    patterns: [/\bload\b/i, /\brate\b/i, /\bbroker\b/i, /\bdeadhead\b/i, /\bper mile\b/i, /\bshortlist\b/i, /\bpickup\b/i, /\bdelivery\b/i],
  },
  {
    slug: "compliance-watchdog",
    patterns: [/\bhours\b/i, /\bduty\b/i, /\blog\b/i, /\bhos\b/i, /\brest\b/i, /\bsleeper\b/i],
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
    patterns: [/\bdoes (that|this) add up\b/i, /\bmath\b/i, /\bwrong\b/i, /\bcheck (this|that|it)\b/i, /\bverify\b/i, /\badd up\b/i],
  },
];

export function routeGroupMessage(input: GroupMessageInput): GroupRoute {
  const text = input.text.trim();
  const channel = input.channel ?? "group";

  // A reply to a bot's message goes to that bot.
  if (input.replyToBotSlug && isBotSlug(input.replyToBotSlug)) {
    return {
      target: input.replyToBotSlug,
      via: "reply",
      shouldAnswer: true,
      seated: GROUP_SEATS_PHASE_0.includes(input.replyToBotSlug),
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
      return { target: slug, via: "mention", shouldAnswer: true, seated: GROUP_SEATS_PHASE_0.includes(slug) };
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
      return { target: slug, via: "keyword", shouldAnswer: true, seated: GROUP_SEATS_PHASE_0.includes(slug) };
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
