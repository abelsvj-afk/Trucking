// Bot-to-bot handoffs in the team room (Phase 2, 2026-11-19).
// The group chat IS the shared channel (owner model 2026-11-19):
// everything the owner posts lands for all the bots, and bots talk
// to each other in the room by name, hand work off, and report
// progress out loud — the owner can watch them figure things out
// without being pulled in. The handoff is the room-visible form of
// that: one addressed line, machine-readable, human-readable beside
// it.
//
// Telegram mechanics (verified 2026-11-19 against Telegram's own
// docs — Bot API 9.6, core.telegram.org/api/bots/bot-to-bot): by
// DEFAULT bots cannot see each other's messages at all. With
// Bot-to-Bot Communication Mode enabled (in @BotFather, at least one
// of the two bots), a bot receives another bot's message when it
// contains a command mention addressed to it (/command@TargetBot)
// or is a direct reply to one of its messages. With the Mode enabled
// AND the bot an admin in the group (or Group Privacy Mode off), it
// receives ALL messages from other bots. So the handoff line leads
// with a command mention — /handoff@TargetBot — the form the Mode
// delivers. Until the owner enables the Mode and provisions each
// bot's token + username, the same line is posted by the server-side
// relay (the server posts it in the room and runs the target bot's
// logic in-process); the text is identical either way, so the room
// the owner watches never changes shape.
//
// Handoff payload = validated state only (research pattern): job +
// token-safe key=value fields, never a transcript, never raw text.
// The human line beside it is for the owner watching, not the
// payload — the parser reads line 1 only.
//
// Loop suppression (telegram-ai-bridge pattern, generation-counted):
// every handoff carries a hop count; a handoff that has already
// passed through HANDOFF_MAX_HOPS bots is dropped, never relayed.
// The count travels in the args, so it survives the room.
//
// Pure functions only — no database, no network — so the format and
// the parse are unit-testable and the same line always parses the
// same way.

import { BOT_REGISTRY, type BotSlug } from "./registry";

/** A handoff that has passed through this many bots is dropped, never relayed. */
export const HANDOFF_MAX_HOPS = 3;

/**
 * Jobs one bot can hand another. "route" is Abel delegating the
 * owner's message (the text travels by reply, not in the payload);
 * "runnable" / "defect" / "work-order" / "location" are the work
 * itself; "progress" is a report back on work another bot asked for.
 */
export type HandoffJob = "route" | "runnable" | "defect" | "work-order" | "location" | "progress";

export const HANDOFF_JOBS: readonly HandoffJob[] = ["route", "runnable", "defect", "work-order", "location", "progress"];

export function isHandoffJob(value: string): value is HandoffJob {
  return (HANDOFF_JOBS as readonly string[]).includes(value);
}

export interface BotHandoff {
  to: BotSlug;
  from: BotSlug;
  job: HandoffJob;
  /** Validated state only: job fields, token-safe strings. Never a transcript, never raw text. */
  state: Record<string, string>;
  /** Generations so far: 0 at the origin, +1 per relay. */
  hops: number;
}

/** State values travel as whitespace-free tokens — spaces become hyphens. */
function tokenValue(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

function displayName(slug: BotSlug): string {
  return BOT_REGISTRY[slug].displayName;
}

/**
 * The plain-words line beside the machine line, so the owner
 * watching the room reads what is happening without decoding args.
 * Built from the validated state — nothing is invented here.
 */
export function handoffSummary(handoff: BotHandoff): string {
  const from = displayName(handoff.from);
  const to = displayName(handoff.to);
  const truck = handoff.state.truck ? `truck ${handoff.state.truck}` : "the truck";
  switch (handoff.job) {
    case "route":
      return `${from} → ${to}: routing this one to you${handoff.state.keywords ? ` (matched: ${handoff.state.keywords})` : ""}.`;
    case "runnable":
      return `${from} → ${to}: is ${truck} runnable?`;
    case "defect":
      return `${from} → ${to}: file this defect — ${handoff.state.defect ?? "defect"} on ${truck}.`;
    case "work-order":
      return `${from} → ${to}: draft a work order — ${handoff.state.problem ?? "as described"} on ${truck}.`;
    case "location":
      return `${from} → ${to}: where is ${truck}? I need the nearest shop for the breakdown.`;
    case "progress":
      if (handoff.state.about === "truck-down") {
        return `${from} → ${to}: truck ${handoff.state.truck ?? "(not named)"} reported down (${handoff.state.defect ?? "defect"}).`;
      }
      return `${from} → ${to}: progress on ${handoff.state.about ?? "the job"} — ${handoff.state.note ?? "see the room"}.`;
  }
}

/**
 * Just the machine line of a handoff: the command mention the
 * Bot-to-Bot Mode delivers, plus job + state + hop count. Callers
 * that already have their own human line (a truck-down notice, a
 * breakdown question) use this and write the human line themselves;
 * formatHandoff pairs it with the generated summary.
 */
export function handoffMachineLine(handoff: BotHandoff, toUsername: string | null): string {
  const args = [`job=${handoff.job}`];
  for (const [key, value] of Object.entries(handoff.state)) {
    args.push(`${tokenValue(key)}=${tokenValue(value)}`);
  }
  args.push(`hops=${handoff.hops}`);
  return toUsername
    ? `/handoff@${toUsername.replace(/^@/, "")} ${args.join(" ")}`
    : `${displayName(handoff.to)} — handoff: ${args.join(" ")}`;
}

/**
 * Format a handoff as the room-visible text. Line 1 is the machine
 * line: the command mention the Bot-to-Bot Mode delivers, plus
 * job + state + hop count as key=value args. Line 2 is the plain
 * human summary. When the target bot's username is not configured
 * yet (no token provisioned), the machine line falls back to a plain
 * addressed line — the server-side relay still delivers it to the
 * target's logic, and the room still shows who it is for.
 */
export function formatHandoff(handoff: BotHandoff, toUsername: string | null): string {
  return `${handoffMachineLine(handoff, toUsername)}\n${handoffSummary(handoff)}`;
}

/**
 * Parse a room message back into a handoff. Only the first line is
 * read; the human summary is display-only. The sender comes from the
 * message's author (Telegram `from`) — it is never in the line, so a
 * handoff can never claim to be from a bot it is not. Returns null
 * when the message is not a handoff (no command mention), the
 * addressee is unknown, or the job is not a known job — a malformed
 * handoff is never half-run.
 */
export function parseHandoff(
  text: string,
  from: BotSlug,
  resolveUsername: (username: string) => BotSlug | null,
): BotHandoff | null {
  const firstLine = text.split("\n")[0] ?? "";
  const command = /^\/handoff@([A-Za-z0-9_]+)\b/.exec(firstLine.trim());
  if (!command) return null;
  const to = resolveUsername(command[1]!);
  if (!to) return null;
  const state: Record<string, string> = {};
  let job: HandoffJob | null = null;
  let hops = 0;
  const tokens = firstLine.trim().split(/\s+/).slice(1);
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "job") {
      if (!isHandoffJob(value)) return null;
      job = value;
    } else if (key === "hops") {
      const parsed = Number(value);
      hops = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
    } else {
      state[key] = value;
    }
  }
  if (!job) return null;
  return { to, from, job, state, hops };
}

/** The loop guard: a handoff at the hop limit is dropped, never relayed. */
export function handoffAtHopLimit(handoff: BotHandoff): boolean {
  return handoff.hops >= HANDOFF_MAX_HOPS;
}

/** One more generation: the relay increments the count, never resets it. */
export function relayHandoff(handoff: BotHandoff, nextTo: BotSlug, nextJob: HandoffJob, nextState: Record<string, string>): BotHandoff {
  return { to: nextTo, from: handoff.to, job: nextJob, state: nextState, hops: handoff.hops + 1 };
}
