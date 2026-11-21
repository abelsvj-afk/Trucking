// The bot team talks like a team (design: docs/design/bot-team-conversation.md, owner 2026-11-21:
// "there shouldn't be a specific way I have to phrase things … even if I spell something horribly
// wrong"; "they need to know who that work goes to … and talk to each other"; "make sure every bot,
// even ones not in the group or built yet, can respond and talk like humans").
//
// Three pieces, shared by EVERY bot — a bot added to the registry later gets all of it with no code:
//  1. TEAM_ROSTER: each bot's name, nicknames and job (from the registry), plus Malik, the phone voice.
//  2. understandMessage: one cheap model call reads the owner's message WITH the recent room
//     conversation and the roster, and says who it is for and what is asked — typos, loose wording,
//     no keywords needed. Strict JSON, validated in code; any failure falls back to the old router.
//  3. runTeamTurn: a real agent turn for any bot — its own system prompt, the room history, the read
//     tools its scope allows, and the team tools (hand_off; a bot's own job tools). Writes stay
//     proposals (the agent loop), and a reply that promises work no tool or teammate did is replaced
//     by an honest one.

import { runAgentLoop, type AgentTool } from "@/services/ai/agent-loop";
import type { AiProvider } from "@/services/ai/provider";
import { buildBotSystemPrompt } from "./reasoning";
import { BOT_REGISTRY, BOT_SLUGS, isBotSlug, type BotSlug, type ToolGroup } from "./registry";

// ---- 1. the roster --------------------------------------------------------------------------------

/** What each bot is called besides its display name (lower case). Typos are the model's job, not this list's. */
const NICKNAMES: Record<BotSlug, string[]> = {
  abel: ["abe"],
  "dispatch-scout": ["scout", "dispatch", "dispatcher", "load finder"],
  tracker: ["tracking", "check calls"],
  "compliance-watchdog": ["watchdog", "compliance", "hos", "hours"],
  maintenance: ["maint", "mechanic", "shop"],
  billing: ["invoices", "money"],
  auditor: ["audit", "checker"],
};

/** One line per bot's job, in plain words (the registry's seat is a title; this says what to send it). */
const JOBS: Record<BotSlug, string> = {
  abel: "the coordinator and the owner's day-to-day assistant: hours, pay, loads on file, his records, anything general, and who should do what",
  "dispatch-scout": "finds loads: scans the load boards from a city or state (to a destination if given), prices them against his costs, works up a forwarded dispatch",
  tracker: "loads in progress: check calls, ETA, pickup and delivery status, BOL and POD paperwork, detention",
  "compliance-watchdog": "hours of service, deadlines and compliance: registration, insurance, inspections, medical card",
  maintenance: "the truck and trailer: repairs, service schedules, defects, shop visits, estimates",
  billing: "money owed to him: invoices, broker payments, short pays, factoring",
  auditor: "double-checks numbers and drafts other bots made before they go out",
};

export interface RosterEntry {
  slug: BotSlug;
  name: string;
  nicknames: string[];
  job: string;
}

export const TEAM_ROSTER: RosterEntry[] = BOT_SLUGS.map((slug) => ({
  slug,
  name: BOT_REGISTRY[slug].displayName,
  nicknames: NICKNAMES[slug] ?? [],
  job: JOBS[slug] ?? BOT_REGISTRY[slug].seat,
}));

/** The roster as the model reads it. Malik is listed so "is Malik live?" means something. */
export function rosterText(): string {
  return [
    ...TEAM_ROSTER.map((r) => `- ${r.name} (${r.slug}${r.nicknames.length ? `; also called ${r.nicknames.join(", ")}` : ""}): ${r.job}.`),
    "- Malik: the phone voice on the company number. He answers calls and takes messages; he is not in this chat — Abel can tell the owner about his calls.",
  ].join("\n");
}

// ---- how every bot talks --------------------------------------------------------------------------

export const TEAM_STYLE = [
  "You are texting in a group chat with the owner (a truck driver, often on the road) and your teammates.",
  "Talk like a real person on a dispatch team: short, plain, friendly, no jargon, no command syntax.",
  "Never tell him how to phrase things, never show templates like 'say X <city>', never ask him to use brackets or keywords.",
  "Understand typos and loose wording; if something is truly unclear, ask ONE short question.",
  "Don't start your message with your own name — the chat already shows who is talking.",
  "Never promise to do something later ('I'll check', 'I'll let you know') unless you just started it with a tool or handed it to a teammate.",
  "If the job is a teammate's, hand it off with hand_off and say so in a few words. If no one on the team can do it yet, say that plainly.",
  "You may start read-only work on your own when it clearly helps (a scan, a check); anything that changes records or contacts someone outside is only ever proposed for his yes.",
].join("\n");

// ---- 2. understand --------------------------------------------------------------------------------

export interface RoomLine {
  who: string;
  text: string;
}

export interface Understanding {
  to: BotSlug;
  /** The request in one plain line, details filled in ("loads from Oklahoma to Florida"). */
  ask: string;
  smallTalk: boolean;
}

function historyText(history: RoomLine[]): string {
  return history.length === 0 ? "(no earlier messages)" : history.map((h) => `${h.who}: ${h.text}`).join("\n");
}

/** Pull the first JSON object out of a model reply (it may wrap it in prose or a code fence). */
function firstJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Validates the model's answer; anything off returns null and the caller falls back. */
export function parseUnderstanding(raw: string): Understanding | null {
  const j = firstJson(raw) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return null;
  const to = typeof j.to === "string" ? j.to.trim().toLowerCase() : "";
  if (!isBotSlug(to)) return null;
  const ask = typeof j.ask === "string" ? j.ask.trim().slice(0, 400) : "";
  return { to, ask, smallTalk: j.small_talk === true };
}

export async function understandMessage(provider: AiProvider, input: { text: string; history: RoomLine[] }): Promise<Understanding | null> {
  const system = [
    "You route messages in a trucking team's group chat to the right bot. The team:",
    rosterText(),
    "",
    "Read the owner's newest message in the context of the conversation. Spelling and grammar may be bad — work out what he means.",
    "Pick the ONE bot whose job it is. A bot named or nicknamed in the message, or the bot he is replying to or clearly talking with, wins.",
    "Anything general, chit-chat, about Malik, or about who should do something goes to abel.",
    'Answer with JSON only: {"to": "<slug>", "ask": "<what he wants, one line, with any places/dates/amounts filled in>", "small_talk": true|false}',
  ].join("\n");
  const user = `Conversation so far:\n${historyText(input.history)}\n\nOwner's newest message: ${input.text}`;
  try {
    return parseUnderstanding(await provider.complete({ system, user }));
  } catch (err) {
    console.error("[bot-team] understanding failed — falling back to the keyword router", err);
    return null;
  }
}

// ---- 3. the turn ----------------------------------------------------------------------------------

/** Which group a read tool belongs to, so a bot only gets the reads its registry scope allows. */
export function toolGroupOf(name: string): ToolGroup {
  if (/(^|_)(call|calls)(_|$)|malik/.test(name)) return "calls";
  if (/email|thread|exchange|inbox/.test(name)) return "email";
  if (/document|paperwork|packet/.test(name)) return "documents";
  if (/hos|duty|plan|clock|inspection|credential|checklist/.test(name)) return "hos";
  if (/pay|money|expense|fuel|cash|receivable|ifta|tax|settlement|invoice|credit|income|game|fund|wrap/.test(name)) return "money";
  if (/route|home|way|position|location/.test(name)) return "maps";
  if (/load|lane|broker|customer|facilit|delivery|recommend|calendar|due|offer|driver|truck|trailer|maintenance/.test(name)) return "loads";
  return "app-actions";
}

/** The read tools a bot may use: Abel all; every other bot only the groups its scope opens. */
export function readToolsFor(slug: BotSlug, all: AgentTool[]): AgentTool[] {
  const reads = all.filter((t) => t.access === "read");
  if (slug === "abel") return reads;
  const scope = BOT_REGISTRY[slug].toolScope;
  return reads.filter((t) => {
    const s = scope[toolGroupOf(t.name)];
    return s !== "none" && s !== "never";
  });
}

export interface HandOff {
  to: BotSlug;
  ask: string;
}

/** The team tool every bot has: hand work to a teammate in the room. Collected, then posted by the caller. */
export function handOffTool(from: BotSlug, handoffs: HandOff[]): AgentTool {
  return {
    name: "hand_off",
    description:
      "Give this job to the teammate whose job it is (see the team list). Use it when the owner's request, or part of it, is a teammate's work. " +
      "The teammate gets it in the chat by name and takes it from there. ask = what they should do, one line, with the details.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: `The teammate's slug: ${BOT_SLUGS.filter((s) => s !== from).join(", ")}.` },
        ask: { type: "string", description: "What they should do, one line, with places, dates, amounts." },
      },
      required: ["to", "ask"],
    },
    access: "read",
    async run(args) {
      const to = typeof args.to === "string" ? args.to.trim().toLowerCase() : "";
      const ask = typeof args.ask === "string" ? args.ask.trim().slice(0, 400) : "";
      if (!isBotSlug(to) || to === from) return "That isn't a teammate - pick one from the team list.";
      if (!ask) return "Say what they should do.";
      if (!handoffs.some((h) => h.to === to)) handoffs.push({ to, ask });
      return `Handed to ${BOT_REGISTRY[to].displayName}. Tell the owner in a few words; they'll answer in the chat.`;
    },
  };
}

const EMPTY_PROMISE = /\b(i'?ll|i will|let me|i'?m going to|gonna)\b[^.!?\n]{0,40}\b(check|look|find|search|get back|let you know|pull|scan|see)\b/i;

/** True when a reply promises later work that nothing this turn started. */
export function isEmptyPromise(reply: string, toolsCalled: number, handoffs: number): boolean {
  return toolsCalled === 0 && handoffs === 0 && EMPTY_PROMISE.test(reply);
}

/** A leading "Name:" the model added despite being told not to. */
export function stripOwnName(slug: BotSlug, reply: string): string {
  const names = [BOT_REGISTRY[slug].displayName, ...(NICKNAMES[slug] ?? [])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return reply.replace(new RegExp(`^\\s*(${names.join("|")})\\s*:\\s*`, "i"), "").trim();
}

export interface TeamTurnInput {
  slug: BotSlug;
  provider: AiProvider;
  text: string;
  /** What the understanding step made of it, when it ran. */
  ask?: string;
  history: RoomLine[];
  /** Every read tool available on the server (the caller builds them); filtered here by the bot's scope. */
  readTools: AgentTool[];
  /** This bot's own job tools (e.g. Scout's board scan). */
  jobTools?: AgentTool[];
  /** Extra context for this bot (its memories, a snapshot), plain text. */
  context?: string;
}

export interface TeamTurnResult {
  reply: string;
  handoffs: HandOff[];
  toolsCalled: number;
}

export async function runTeamTurn(input: TeamTurnInput): Promise<TeamTurnResult> {
  const handoffs: HandOff[] = [];
  const tools = [...readToolsFor(input.slug, input.readTools), ...(input.jobTools ?? []), handOffTool(input.slug, handoffs)];
  const system = [buildBotSystemPrompt(input.slug) ?? `You are ${BOT_REGISTRY[input.slug].displayName}.`, TEAM_STYLE, "Your team:", rosterText()].join("\n\n");
  const contextText = [
    `The group chat so far:\n${historyText(input.history)}`,
    input.ask ? `What he is asking (as understood): ${input.ask}` : "",
    input.context ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await runAgentLoop({ provider: input.provider, system, contextText, history: [], userText: input.text, tools, maxSteps: 4 });
  const toolsCalled = out.toolLog.filter((t) => t.tool !== "hand_off").length;
  let reply = stripOwnName(input.slug, out.reply ?? "");
  if (isEmptyPromise(reply, toolsCalled, handoffs.length)) {
    reply = "I can't do that from here yet, and I don't want to promise something I can't follow through on. Ask Abel and he'll point it to whoever can.";
  }
  if (!reply) reply = handoffs.length ? "On it — passing this along." : "Got it.";
  return { reply, handoffs, toolsCalled };
}
