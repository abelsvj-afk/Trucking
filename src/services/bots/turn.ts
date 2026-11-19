// One bot's turn in the group chat — the shared brain, scoped.
// (Owner rule 2026-11-19: every bot gets the same reasoning,
// wisdom, and smartness Abel has. Open-source multi-agent
// research, same day: supervisor-first, handoff payload =
// validated state only, shared state/summaries not full
// transcripts, one model router + per-agent scoped tools,
// server-side enforcement, human-in-the-loop as a structural
// interrupt, single-writer per thread, bounded loops.)
//
// What a turn assembles, in code — the same pieces Abel's 1:1
// turn assembles (services/bot/agent-turn.ts loadBotContext +
// runAgentTurn), scoped to this bot:
//   system prompt: buildBotSystemPrompt (identity + scope line +
//     propose-only + the shared reasoning, all ten forms + all
//     five think-deeper forms, byte-identical for every bot)
//   context: NOW line + live company snapshot (closes the Phase 0
//     gap: a group answer never states a live figure it has not
//     loaded — when the snapshot fails, the turn proceeds WITHOUT
//     it and the prompt says so) + the bot's own memories
//     (facts/rules/preferences) + correction watch-outs + recent
//     load outcomes (Scout) + recent group history (summaries,
//     not the full transcript: the last 10 messages)
//   tools: scopedToolCatalog (reads only, inside the bot's
//     registry scope) + that bot's propose tools — the loop's
//     catalog IS this same filtered list, so find_more_tools can
//     never surface a tool the turn refused
//   gates: spend cap BEFORE the model call; checkBotAction +
//     the Auditor's recomputation on every staged draft;
//     isWriteAlreadyPending so a redelivered turn never stages
//     the same proposal twice; proposals persist to bot_proposals
//     and wait for the owner's yes — the loop stages (alwaysPropose)
//     and never executes, which is the structural interrupt:
//     the model cannot talk its way past it.
//
// A turn never books, pays, signs, files, or moves money. A turn
// never calls another bot on Telegram — handoffs are internal:
// the turn reports which bot its answer names (handoffTo), the
// group handler runs that bot's turn once with the handoff
// payload (objective + constraints + what was said, never the
// whole conversation), and that bot answers under its own name.
// One hop per incoming message, bounded — the second turn is
// terminal. (Telegram never delivers one bot's message to
// another bot, so a Telegram handoff cannot work at all.)

import { runAgentLoop, type AgentToolLogEntry } from "@/services/ai/agent-loop";
import type { BotChatTurn } from "@/services/ai/bot-chat";
import type { AiProvider } from "@/services/ai/provider";
import { selectToolsForTurn, TOOL_BUDGET } from "@/services/bot/tool-budget";
import type { BotBrainStore } from "@/services/bot/store";
import { formatClock, HOME_TIME_ZONE } from "@/lib/display-zone";
import { formatCompanySnapshot } from "@/services/telegram/context";
import { auditLoadDraft, type AuditFlag, type LoadDraftInput } from "./auditor";
import { checkBotAction, type DraftActionKind } from "./guardrails";
import { botMemoriesBlock, botWatchoutsBlock, recentOutcomesBlock } from "./outcomes";
import { buildBotSystemPrompt, botDisplayName } from "./reasoning";
import { botProposeTools, PROPOSE_TOOL_KINDS, scopedToolCatalog } from "./scoped-tools";
import {
  capReached,
  estimateCallCostCents,
  modelForTier,
  monthlyCapCents,
  monthStartIso,
  SPEND_CAP_REACHED_TEXT,
} from "./spend";
import { mentionedBotByName } from "./router";
import type { BotSlug } from "./registry";
import type { BotTeamStore, ProposalKind } from "./store";

export interface BotTurnHandoff {
  /** The bot handing the work over. */
  fromBot: BotSlug;
  /** The objective, in the owner's words. */
  objective: string;
  /** What the first bot said, so the next bot does not re-ask. */
  summary: string;
}

export interface BotTurnInput {
  slug: BotSlug;
  userText: string;
  /** Recent group messages, oldest first (the caller loads these). */
  history: BotChatTurn[];
  telegramChatId: number;
  /** One run id per incoming message — handoffs and audit rows share it. */
  runId: string;
  /** Set when this turn IS a handoff: the turn is terminal (no further handoff). */
  handoff?: BotTurnHandoff;
}

export interface BotTurnDeps {
  provider: AiProvider;
  teamStore: BotTeamStore | null;
  brainStore: BotBrainStore | null;
  onToolLog?: (entry: AgentToolLogEntry) => void;
}

export interface BotTurnResult {
  reply: string;
  proposalsCreated: number;
  toolLog: AgentToolLogEntry[];
  /** The bot this answer names, for the handler's one internal handoff. Null when terminal or none. */
  handoffTo: BotSlug | null;
}

/**
 * Per-bot context notes — a fact the model must not invent around.
 * Scout's is the honest one: live board scanning is not wired up
 * yet, so a board question gets a plain "not yet", never invented
 * loads. (Boards land with PR #97's rebase.)
 */
const BOT_CONTEXT_NOTES: Partial<Record<BotSlug, string>> = {
  "dispatch-scout":
    "LOAD BOARDS: live board scanning is not wired up yet — when the owner asks you to scan a board, say so plainly instead of inventing loads. " +
    "Work up forwarded dispatches from the text he gave you, with the numbers as stated.",
};

/** Which guardrail draft action each propose tool stages as. */
const PROPOSE_DRAFT_ACTIONS: Record<string, DraftActionKind> = {
  propose_load_draft: "draft_load",
  propose_shortlist: "draft_shortlist",
  propose_message: "draft_message",
  propose_status_update: "internal_note",
  propose_work_order: "draft_work_order",
  propose_invoice: "draft_invoice",
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function draftInputFromArgs(args: Record<string, unknown>): LoadDraftInput {
  return {
    rateCentsPerLoadedMile: asNumber(args.rate_cents_per_loaded_mile),
    payCents: asNumber(args.pay_cents),
    loadedMiles: asNumber(args.loaded_miles),
    deadheadMiles: asNumber(args.deadhead_miles),
    claimedPerLoadedMileCents: asNumber(args.claimed_per_loaded_mile_cents),
    claimedPerAllMilesCents: asNumber(args.claimed_per_all_miles_cents),
    pickupWindowStart: asString(args.pickup_window_start),
    pickupWindowEnd: asString(args.pickup_window_end),
    deliveryWindowStart: asString(args.delivery_window_start),
    deliveryWindowEnd: asString(args.delivery_window_end),
  };
}

function flagsText(flags: AuditFlag[]): string {
  if (flags.length === 0) return "";
  return ` — Auditor flags: ${flags.map((f) => `${f.field}: ${f.detail}`).join("; ")}`;
}

/**
 * Does a stored open proposal already hold these exact arguments?
 * The loop's model-execute guard: a redelivered turn never stages
 * the same proposal twice. Stored payloads carry the audit next to
 * the draft, so the comparison looks at the draft itself.
 */
function proposalMatchesStored(
  storedKind: ProposalKind,
  storedPayload: Record<string, unknown>,
  kind: ProposalKind,
  args: Record<string, unknown>,
): boolean {
  if (storedKind !== kind) return false;
  if (kind === "load-draft") {
    return JSON.stringify(storedPayload.draft ?? null) === JSON.stringify(args);
  }
  if (kind === "load-shortlist") {
    return JSON.stringify(storedPayload.loads ?? null) === JSON.stringify(args.loads ?? null);
  }
  return JSON.stringify(storedPayload) === JSON.stringify(args);
}

export async function runBotGroupTurn(deps: BotTurnDeps, input: BotTurnInput): Promise<BotTurnResult> {
  const { slug, userText } = input;
  const { teamStore, brainStore } = deps;
  const empty: BotTurnResult = { reply: "", proposalsCreated: 0, toolLog: [], handoffTo: null };

  // Spend cap BEFORE the model call (same gate as the 1:1 path).
  // A cap failure never calls the model — the reply says so.
  if (teamStore) {
    try {
      const spent = await teamStore.spentThisMonthCents(monthStartIso());
      if (capReached(spent, monthlyCapCents())) {
        return { ...empty, reply: SPEND_CAP_REACHED_TEXT };
      }
    } catch (err) {
      console.error("[bot-team] spend check failed — refusing the model call", err);
      return {
        ...empty,
        reply: "I couldn't check the spending cap, so I'm not calling the model on this one. Try again in a moment.",
      };
    }
  }

  // Context, assembled in code. A failed load degrades the block,
  // never the turn — and never an invented figure.
  const blocks: string[] = [`NOW (owner's clock, America/New_York): ${formatClock(new Date(), HOME_TIME_ZONE)}`];
  if (brainStore) {
    try {
      const snapshot = await brainStore.loadSnapshot();
      blocks.push(
        snapshot
          ? formatCompanySnapshot(snapshot)
          : "LIVE DATA: the company snapshot did not load — say any live figure is unavailable rather than estimating.",
      );
    } catch (err) {
      console.error("[bot-team] snapshot load failed — answering without live figures", err);
      blocks.push("LIVE DATA: the company snapshot did not load — say any live figure is unavailable rather than estimating.");
    }
  } else {
    blocks.push(
      "LIVE DATA: live tools are unavailable on this turn — answer from the context blocks and the conversation only; never invent a figure.",
    );
  }
  let memories: Awaited<ReturnType<BotTeamStore["loadBotMemories"]>> = [];
  if (teamStore) {
    try {
      memories = await teamStore.loadBotMemories(slug);
    } catch (err) {
      console.error("[bot-team] memories load failed — answering without them", err);
    }
  }
  const memoriesBlock = botMemoriesBlock(memories);
  if (memoriesBlock) blocks.push(memoriesBlock);
  const watchoutsBlock = botWatchoutsBlock(memories);
  if (watchoutsBlock) blocks.push(watchoutsBlock);
  if (slug === "dispatch-scout" && teamStore) {
    try {
      const outcomes = await teamStore.loadRecentLoadOutcomes(5);
      const outcomesBlock = recentOutcomesBlock(outcomes);
      if (outcomesBlock) blocks.push(outcomesBlock);
    } catch (err) {
      console.error("[bot-team] load outcomes load failed — answering without them", err);
    }
  }
  const note = BOT_CONTEXT_NOTES[slug];
  if (note) blocks.push(note);
  if (input.handoff) {
    blocks.push(
      `HANDOFF from ${botDisplayName(input.handoff.fromBot)} (run ${input.runId}): the owner asked — "${input.handoff.objective}". ` +
        `${botDisplayName(input.handoff.fromBot)} said: "${input.handoff.summary.slice(0, 2000)}". ` +
        "Answer from your own job and your own tools. Do not hand this off again.",
    );
  }
  if (!teamStore) {
    blocks.push(
      "PROPOSALS: the team database is not configured — you cannot record a proposal on this turn; say so plainly if asked to draft something.",
    );
  }

  // The catalog: reads inside this bot's scope + that bot's propose
  // tools (only when proposals can be recorded). The loop's catalog
  // IS this same list, so find_more_tools can never surface a tool
  // the turn refused.
  const catalog = [
    ...(brainStore ? scopedToolCatalog(brainStore, slug) : []),
    ...(teamStore ? botProposeTools(slug) : []),
  ];
  const selected = selectToolsForTurn(catalog, userText, TOOL_BUDGET);

  const output = await runAgentLoop({
    provider: deps.provider,
    system: buildBotSystemPrompt(slug),
    contextText: blocks.join("\n\n"),
    history: input.history,
    userText,
    tools: selected,
    toolCatalog: catalog,
    toolSpecLimit: TOOL_BUDGET,
    onToolLog: deps.onToolLog,
    isWriteAlreadyPending: teamStore
      ? async (toolName, args) => {
          try {
            const kind = PROPOSE_TOOL_KINDS[toolName];
            if (!kind) return false;
            const open = await teamStore.listOpenProposals(20);
            return open.some((row) => row.bot_slug === slug && proposalMatchesStored(row.kind, row.payload, kind, args));
          } catch {
            return false;
          }
        }
      : undefined,
  });

  // Persist what the loop staged: guardrail check + the Auditor's
  // recomputation in code, then the proposal row. A refused draft
  // is dropped with a reason in the reply suffix — never stored.
  // A staged draft that is ALREADY waiting as an open proposal is
  // not stored twice: the loop's isWriteAlreadyPending guard only
  // covers the execute path, and propose tools never execute in
  // the loop, so the turn dedupes at persistence time instead —
  // and tells him it is already waiting (pay-safety rule: never
  // ask him to approve the same thing twice).
  let reply = output.reply && output.reply.trim() !== "" ? output.reply.trim() : "I don't have an answer for that yet — say it another way?";
  const created: { title: string; flags: AuditFlag[] }[] = [];
  const alreadyWaiting: string[] = [];
  if (teamStore) {
    let openProposals: Awaited<ReturnType<BotTeamStore["listOpenProposals"]>> | null = null;
    const loadOpen = async () => {
      if (openProposals === null) {
        try {
          openProposals = await teamStore.listOpenProposals(20);
        } catch (err) {
          console.error("[bot-team] open proposals load failed — staging without dedupe", err);
          openProposals = [];
        }
      }
      return openProposals;
    };
    for (const proposal of output.proposals) {
      const kind = PROPOSE_TOOL_KINDS[proposal.tool];
      if (!kind) continue;
      const actionKind = PROPOSE_DRAFT_ACTIONS[proposal.tool];
      if (!actionKind) continue;
      const gate = checkBotAction({ botSlug: slug, actionKind, group: "app-actions" });
      if (!gate.allowed) {
        console.error("[bot-team] staged proposal refused by the guardrail", { slug, tool: proposal.tool, reason: gate.reason });
        continue;
      }
      const open = await loadOpen();
      if (open.some((row) => row.bot_slug === slug && proposalMatchesStored(row.kind, row.payload, kind, proposal.args))) {
        alreadyWaiting.push(proposal.summary);
        continue;
      }
      let payload: Record<string, unknown> = proposal.args;
      let flags: AuditFlag[] = [];
      if (kind === "load-draft") {
        const audit = auditLoadDraft(draftInputFromArgs(proposal.args));
        flags = audit.flags;
        payload = { draft: proposal.args, auditPassed: audit.passed, flags: audit.flags };
      } else if (kind === "load-shortlist") {
        const loads = Array.isArray(proposal.args.loads) ? (proposal.args.loads as Record<string, unknown>[]) : [];
        const perLoad = loads.map((load, index) => {
          const audit = auditLoadDraft(draftInputFromArgs(load));
          return { index, passed: audit.passed, flags: audit.flags };
        });
        flags = perLoad.flatMap((entry) => entry.flags);
        payload = { loads, audit: perLoad };
      }
      try {
        const row = await teamStore.createProposal({
          botSlug: slug,
          kind,
          title: proposal.summary,
          payload,
          sourceRef: `telegram-group:${input.runId}`,
        });
        await teamStore.logAudit({
          botSlug: slug,
          actor: "bot",
          action: "proposal_created",
          targetRef: row.id,
          detail: { kind, runId: input.runId, auditPassed: flags.length === 0 },
        });
        created.push({ title: proposal.summary, flags });
      } catch (err) {
        console.error("[bot-team] staged proposal could not be saved", err);
      }
    }
    try {
      await teamStore.recordSpend({
        botSlug: slug,
        model: modelForTier("scan"),
        tier: "scan",
        estimatedCents: estimateCallCostCents({ tier: "scan", inputChars: userText.length, outputChars: reply.length }),
      });
    } catch (err) {
      console.error("[bot-team] spend record failed", err);
    }
  }

  if (created.length > 0) {
    const lines = created.map((entry, index) => `${index + 1}. ${entry.title}${flagsText(entry.flags)}`);
    const instruction =
      created.length === 1
        ? 'Reply Yes to approve it, No to drop it.'
        : 'Reply "1 yes" to approve the first, "2 yes" for the second, or "no" to drop it.';
    reply = `${reply}\n\nWaiting on your yes:\n${lines.join("\n")}\n${instruction}`;
  }
  if (alreadyWaiting.length > 0) {
    reply = `${reply}\n\nAlready waiting on your yes:\n${alreadyWaiting.map((title, index) => `${index + 1}. ${title}`).join("\n")}`;
  }

  // Handoff: the answer names another bot by NAME (not a job word —
  // "I'll dispatch this" is not a handoff to Scout). One hop per
  // incoming message; a handoff turn is terminal.
  const handoffTo = input.handoff ? null : mentionedBotByName(reply, slug);

  return { reply, proposalsCreated: created.length, toolLog: output.toolLog, handoffTo };
}
