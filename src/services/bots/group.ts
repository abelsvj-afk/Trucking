// Telegram group mode for the bot team (Phase 0 baseline).
// One private group, him + the bots. Every bot hears every message;
// only the relevant one answers, the rest stay quiet.
//
// Seats wired so far: Abel and Dispatch Scout (Phase 0/1) and
// Compliance Watchdog (Phase 2, services/bots/compliance-watchdog.ts)
// — a message routed to the Watchdog runs its full deadline + HOS +
// legality check and the report posts under its own name.
//
// This handler runs BEFORE the 1:1 path (services/telegram/
// dispatch-bot.ts), which still serves only the owner's private chat
// and still ignores every group. The webhook route sends group and
// supergroup updates here; everything else goes to the 1:1 path
// untouched.
//
// Fail-closed, like the 1:1 bot:
// - No TELEGRAM_GROUP_CHAT_ID configured = groups ignored, as today.
// - A message from anyone but the owner (TELEGRAM_ALLOWED_CHAT_ID)
//   is ignored silently. The room has no third parties.
// - A message from another bot is logged and ignored — bots do not
//   answer each other unprompted, or the room would talk to itself.
// - No store configured = the room still answers, but nothing is
//   logged and proposals cannot be recorded; the reply says so.
//
// Proposals in the group: a draft posted here is a bot_proposals row
// (propose-only guardrails, services/bots/guardrails.ts). The owner
// answers in plain words — "yes" approves the newest open proposal,
// "no" drops it, "2 yes" answers the second one. There are no inline
// Yes/No buttons in the group in this phase: button taps arrive as
// callback queries the 1:1 path would ignore, so plain words are the
// honest channel until group callbacks are wired (Phase 1).
//
// Abel's group answers use runBotChat with context assembled in code:
// recent group history + the bot's stored memories. They do NOT yet
// carry the live company snapshot the 1:1 path loads — a group answer
// never states a live figure it has not loaded. That snapshot is a
// Phase 1 gap, listed in the PR.

import { randomUUID } from "node:crypto";
import { auditLoadDraft } from "./auditor";
import { createBrowserRuntime, type BrowserRuntime } from "./browser-runtime";
import {
  parseCostPreferences,
  parseScanRequest,
  recordShortlistDecision,
  runScoutScan,
  type ScoutScanResult,
} from "./dispatch-scout";
import { createWatchdogData, runWatchdogCheck, type WatchdogReport } from "./compliance-watchdog";
import { formatMoney } from "@/lib/money-format";
import { checkBotAction } from "./guardrails";
import { GROUP_SEATS_PHASE_0, type BotSlug } from "./registry";
import { routeGroupMessage, unseatedReply } from "./router";
import { capReached, estimateCallCostCents, modelForTier, monthlyCapCents, monthStartIso, SPEND_CAP_REACHED_TEXT } from "./spend";
import { type BotTeamStore, type ProposalRow } from "./store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";

export interface GroupHandlerDeps {
  botToken: string;
  /** Owner's Telegram chat id (TELEGRAM_ALLOWED_CHAT_ID). */
  allowedChatId: string | null;
  /** Allowlisted group chat id (TELEGRAM_GROUP_CHAT_ID). Null = groups ignored. */
  groupChatId: string | null;
  companyId: string | null;
  store: BotTeamStore | null;
  sendMessage: (chatId: number, text: string) => Promise<number[]>;
  /**
   * Abel's chat turn. Built lazily by the caller (the OpenAI provider
   * throws without a key); undefined = the group says AI is not
   * configured instead of failing.
   */
  runChat?: (input: {
    userText: string;
    history: { role: "user" | "assistant"; text: string }[];
    instructions: { kind: string; content: string }[];
  }) => Promise<string | null>;
  /**
   * The shared-browser runtime for board scans. Built from env when
   * absent (createBrowserRuntime); tests pass their own.
   */
  browserRuntime?: BrowserRuntime;
  /**
   * The Scout scan run. Defaults to runScoutScan; tests pass a stub
   * so a scan never waits on human-pace gaps in a test.
   */
  scoutScan?: (input: {
    origin: string;
    costPerMileCents: number;
    floorPerAllMileCents: number;
    dieselCentsPerGallon: number;
    mpg: number;
    equipment?: string | null;
    maxShortlist?: number;
    runId?: string;
  }, deps: { runtime: BrowserRuntime; store: BotTeamStore | null }) => Promise<ScoutScanResult>;
  /**
   * The Watchdog's full check (deadlines + HOS + legality).
   * Defaults to runWatchdogCheck over the company-scoped data;
   * tests pass a stub.
   */
  watchdogCheck?: (input: { store: BotTeamStore | null; companyId: string | null }) => Promise<WatchdogReport>;
}

export type GroupHandleResult = "handled" | "ignored" | "disabled";

function groupChatOf(update: TelegramUpdate): { id: number; type: string } | null {
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat;
  if (!chat || typeof chat.id !== "number") return null;
  return { id: chat.id, type: chat.type ?? "" };
}

function senderOf(update: TelegramUpdate): { id: number | null; isBot: boolean; text: string | null; messageId: number | null } {
  const message = update.message;
  const from = message?.from;
  return {
    id: typeof from?.id === "number" ? from.id : null,
    isBot: from?.is_bot === true,
    text: typeof message?.text === "string" ? message.text : null,
    messageId: typeof message?.message_id === "number" ? message.message_id : null,
  };
}

/** "yes", "no", "2 yes", "1 no" — the group decision grammar. */
function parseGroupDecision(text: string): { index: number; decision: "approved" | "denied" } | null {
  const match = text.trim().match(/^(?:(\d+)\s+)?(yes|no)\.?$/i);
  if (!match) return null;
  return { index: match[1] ? Number(match[1]) : 1, decision: match[2]!.toLowerCase() === "yes" ? "approved" : "denied" };
}

export async function handleBotTeamGroupUpdate(update: TelegramUpdate, deps: GroupHandlerDeps): Promise<GroupHandleResult> {
  const chat = groupChatOf(update);
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return "ignored";
  if (!deps.groupChatId) return "ignored";
  if (String(chat.id) !== deps.groupChatId) return "ignored";
  if (!deps.allowedChatId) return "disabled";

  const sender = senderOf(update);
  // Bots do not answer each other unprompted.
  if (sender.isBot) return "ignored";
  // The room has no third parties.
  if (sender.id === null || String(sender.id) !== deps.allowedChatId) return "ignored";

  const text = sender.text;
  const store = deps.store;

  // Log the owner's message first (best-effort: a logging failure is
  // loud in the console but never fails the reply).
  if (store && text !== null && sender.messageId !== null) {
    try {
      await store.ensureGroupRoom(chat.id);
      await store.recordGroupMessage({
        telegramChatId: chat.id,
        telegramMessageId: sender.messageId,
        senderKind: "owner",
        senderRef: String(sender.id),
        text: text.slice(0, 4000),
        routedToBotSlug: null,
      });
    } catch (err) {
      console.error("[bot-team] group message log failed", err);
    }
  }

  if (text === null || text.trim() === "") {
    await deps.sendMessage(chat.id, "Text only in the group for now — photos and files go to Abel 1:1.");
    return "handled";
  }

  const route = routeGroupMessage({ text, senderKind: "owner" });

  // A decision ("yes" / "no" / "2 yes") answers the newest open
  // proposal — the same grammar as the 1:1 waiting list.
  const decision = parseGroupDecision(text);
  if (decision && store) {
    try {
      const open = await store.listOpenProposals(5);
      const target = open[decision.index - 1];
      if (!target) {
        await deps.sendMessage(chat.id, "Nothing is waiting on a yes or no right now.");
        return "handled";
      }
      const decided = await store.decideProposal(target.id, decision.decision, "owner");
      // A denied shortlist writes its loads to the ledger as
      // skipped — that is the outcome the learning reads. An
      // approved shortlist writes nothing yet; the "booked" row
      // lands when the load is actually booked.
      if (target.kind === "load-shortlist" && decision.decision === "denied") {
        try {
          await recordShortlistDecision(store, target, "denied");
        } catch (err) {
          console.error("[bot-team] shortlist decision ledger write failed", err);
        }
      }
      await store.logAudit({
        botSlug: target.bot_slug,
        actor: "owner",
        action: `proposal_${decision.decision}`,
        targetRef: target.id,
        detail: { title: target.title, via: "group" },
      });
      await deps.sendMessage(
        chat.id,
        decision.decision === "approved"
          ? `Approved: ${target.title}. Recorded — nothing executes from here yet; that step comes in the next phase.`
          : `Dropped: ${target.title}.`,
      );
      void decided;
      return "handled";
    } catch (err) {
      console.error("[bot-team] group decision failed", err);
      await deps.sendMessage(chat.id, "I couldn't record that answer — the proposal is still waiting. Try again in a moment.");
      return "handled";
    }
  }

  if (!route.seated) {
    await deps.sendMessage(chat.id, unseatedReply(route.target));
    return "handled";
  }
  if (!route.shouldAnswer) return "handled";

  // Dispatch Scout in this phase: a scan request walks the ranked
  // boards at human pace and posts a shortlist proposal; a forwarded
  // dispatch gets worked up into an auditor-checked proposal.
  if (route.target === "dispatch-scout") {
    if (isScanRequest(text)) {
      await handleScoutScan(chat.id, text, deps);
      return "handled";
    }
    const looksLikeDispatch = /\b(pickup|delivery|rate|broker|load)\b/i.test(text) && /\d/.test(text);
    if (!looksLikeDispatch) {
      await deps.sendMessage(
        chat.id,
        "Dispatch Scout: say 'scout, scan from <city, ST>' and I'll check the boards. Or forward me a dispatch and I'll work it up.",
      );
      return "handled";
    }
    await handleScoutWorkup(chat.id, text, deps);
    return "handled";
  }

  // Compliance Watchdog: any message routed to it runs the full
  // check — the deadline register, the one HOS read, and the
  // pre-booking legality verdict — and the report posts as the
  // Watchdog itself. Alerts only: it never edits a log, never
  // calls anyone, and what reaches the owner beyond this room is
  // Abel's decision, not this bot's.
  if (route.target === "compliance-watchdog") {
    await handleWatchdogCheck(chat.id, deps);
    return "handled";
  }

  // Abel: group chat turn, with the spend cap in front of the model.
  if (!deps.runChat) {
    await deps.sendMessage(chat.id, "Abel: I can't answer that yet — the AI key isn't configured on the server. Nothing was sent anywhere.");
    return "handled";
  }
  if (store) {
    try {
      const spent = await store.spentThisMonthCents(monthStartIso());
      if (capReached(spent, monthlyCapCents())) {
        await deps.sendMessage(chat.id, `Abel: ${SPEND_CAP_REACHED_TEXT}`);
        return "handled";
      }
    } catch (err) {
      console.error("[bot-team] spend check failed — refusing the model call", err);
      await deps.sendMessage(chat.id, "Abel: I couldn't check the spending cap, so I'm not calling the model on this one. Try again in a moment.");
      return "handled";
    }
  }
  try {
    const memories = store ? await store.loadBotMemories("abel") : [];
    const reply = await deps.runChat({
      userText: text,
      history: [],
      instructions: memories.map((row) => ({ kind: row.kind, content: row.content })),
    });
    const answer = reply && reply.trim() !== "" ? reply.trim() : "I don't have an answer for that yet — say it another way?";
    if (store) {
      try {
        await store.recordSpend({
          botSlug: "abel",
          model: modelForTier("scan"),
          tier: "scan",
          estimatedCents: estimateCallCostCents({ tier: "scan", inputChars: text.length, outputChars: answer.length }),
        });
      } catch (err) {
        console.error("[bot-team] spend record failed", err);
      }
    }
    await deps.sendMessage(chat.id, `Abel: ${answer}`);
  } catch (err) {
    console.error("[bot-team] group Abel turn failed", err);
    await deps.sendMessage(chat.id, "Abel: that turn failed on my side — nothing was booked or sent. Try again in a moment.");
  }
  return "handled";
}

/** "scan the boards", "find loads", "shortlist" — a scan request, not a forwarded dispatch. */
function isScanRequest(text: string): boolean {
  return /\bscan\b/i.test(text) || /\bfind\b[^.]*\bloads?\b/i.test(text) || /\bshortlist\b/i.test(text);
}

/**
 * Run a board scan from the group. The scan takes a minute or more
 * (human-pace gaps between board reads), so this acks at once and
 * the scan posts its shortlist when it finishes — the webhook never
 * waits on it. Numbers are never invented: the cost inputs come from
 * the Scout's stored preferences, or from the message itself, and a
 * missing one stops the run with a plain-words ask.
 */
async function handleScoutScan(chatId: number, text: string, deps: GroupHandlerDeps): Promise<void> {
  const store = deps.store;
  const runtime = deps.browserRuntime ?? createBrowserRuntime();
  if (runtime.route === "not-configured") {
    await deps.sendMessage(chatId, "Dispatch Scout: I can't scan boards yet — the shared browser isn't set up on the server. No board was read.");
    return;
  }
  const { origin, equipment } = parseScanRequest(text);
  if (!origin) {
    await deps.sendMessage(chatId, "Dispatch Scout: where's the truck right now? Say 'scout, scan from Panama City, FL' and I'll check the boards.");
    return;
  }
  let memories: { content: string }[] = [];
  if (store) {
    try {
      memories = await store.loadBotMemories("dispatch-scout");
    } catch (error) {
      console.error("[bot-team] scout scan memories failed — asking for the numbers instead", error);
    }
  }
  // The message itself can carry the numbers; it wins over memory.
  const prefs = { ...parseCostPreferences(memories), ...parseCostPreferences([{ content: text }]) };
  const { costPerMileCents, floorPerAllMileCents, dieselCentsPerGallon, mpg } = prefs;
  const missing: string[] = [];
  if (costPerMileCents === undefined) missing.push("cost per mile");
  if (floorPerAllMileCents === undefined) missing.push("floor (lowest profit per all mile you'll run for)");
  if (dieselCentsPerGallon === undefined) missing.push("diesel price");
  if (mpg === undefined) missing.push("miles per gallon");
  if (missing.length > 0) {
    await deps.sendMessage(
      chatId,
      `Dispatch Scout: I need ${missing.join(", ")} before I can price loads — say them once and I'll remember them. Nothing was read yet.`,
    );
    return;
  }
  // Unreachable in practice — missing.length === 0 proves all four are
  // set — but the compiler needs the explicit check to narrow them.
  if (costPerMileCents === undefined || floorPerAllMileCents === undefined || dieselCentsPerGallon === undefined || mpg === undefined) {
    return;
  }
  const runId = randomUUID();
  const watch = runtime.watchUrl(runId);
  await deps.sendMessage(
    chatId,
    `Dispatch Scout: scanning TruLOS first, then Trucker Path, then JustTracking — I'll post the shortlist here.${watch ? ` Watch the browser live: ${watch}` : ""}`,
  );
  const run = deps.scoutScan ?? runScoutScan;
  void run(
    { origin, costPerMileCents, floorPerAllMileCents, dieselCentsPerGallon, mpg, equipment, runId },
    { runtime, store },
  )
    .then(async (result) => {
      await deps.sendMessage(chatId, result.summary);
    })
    .catch(async (error) => {
      console.error("[bot-team] scout scan failed", error);
      await deps.sendMessage(chatId, "Dispatch Scout: the scan failed on my side — nothing was booked or sent. Say 'scout, scan' to try again.");
    });
}

/**
 * Run one Watchdog check from the group and post the report as the
 * Watchdog. A failure is loud and clears no one — the fallback text
 * says the check read nothing, so a broken check can never look
 * like an all-clear.
 */
async function handleWatchdogCheck(chatId: number, deps: GroupHandlerDeps): Promise<void> {
  const run = deps.watchdogCheck ?? defaultWatchdogCheck;
  try {
    const report = await run({ store: deps.store, companyId: deps.companyId });
    await deps.sendMessage(chatId, `Compliance Watchdog:\n${report.summary}`);
  } catch (error) {
    console.error("[bot-team] watchdog check failed", error);
    await deps.sendMessage(
      chatId,
      "Compliance Watchdog: my check failed on my side — I read nothing, so I'm clearing no one. Try again in a moment.",
    );
  }
}

async function defaultWatchdogCheck(input: { store: BotTeamStore | null; companyId: string | null }): Promise<WatchdogReport> {
  return runWatchdogCheck({ store: input.store, data: createWatchdogData(input.companyId) });
}

/**
 * Work up a forwarded dispatch into a load-draft proposal: parse the
 * numbers out of the text, run the Auditor's recomputation, and post
 * the draft — with the Auditor's flags attached when it does not add
 * up. A failed check blocks the draft from looking clean; it never
 * silently fixes the numbers.
 */
async function handleScoutWorkup(chatId: number, text: string, deps: GroupHandlerDeps): Promise<void> {
  const store = deps.store;
  if (!store) {
    await deps.sendMessage(chatId, "Dispatch Scout: I can't record a draft — the team database isn't configured on the server yet.");
    return;
  }
  // The draft lives in the app's proposal store (app-actions scope),
  // never written straight onto loads — the Scout's loads scope is
  // read-only by design.
  const gate = checkBotAction({ botSlug: "dispatch-scout", actionKind: "draft_load", group: "app-actions" });
  if (!gate.allowed) {
    await deps.sendMessage(chatId, `Dispatch Scout: ${gate.reason}`);
    return;
  }
  // Numbers out of the text, in code — the model never invents them.
  // "$1,850" or "1850" near "pay"/"rate", miles near "mi"/"miles".
  const moneyMatches = [...text.matchAll(/\$?\s?([\d,]+(?:\.\d{2})?)\s*(?:dollars|usd)?/gi)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const mileMatches = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:mi|miles)\b/gi)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const payCents = moneyMatches.length > 0 ? Math.round(Math.max(...moneyMatches) * 100) : null;
  const loadedMiles = mileMatches.length > 0 ? Math.max(...mileMatches) : null;
  const draft = { rateCentsPerLoadedMile: null, payCents, loadedMiles, deadheadMiles: null };
  const audit = auditLoadDraft(draft);
  const title = `Load draft — ${payCents !== null ? formatMoney(payCents) : "no pay given"}${loadedMiles !== null ? `, ${loadedMiles} mi` : ""}`;
  try {
    const proposal = await store.createProposal({
      botSlug: "dispatch-scout",
      kind: "load-draft",
      title,
      payload: { ...draft, auditPassed: audit.passed, flags: audit.flags, sourceText: text.slice(0, 2000) },
      sourceRef: "telegram-group-forward",
    });
    await store.logAudit({
      botSlug: "dispatch-scout",
      actor: "bot",
      action: "proposal_created",
      targetRef: proposal.id,
      detail: { kind: "load-draft", auditPassed: audit.passed },
    });
    const lines = [
      `Dispatch Scout — draft ready, waiting on your yes:`,
      title,
      audit.passed ? "Auditor: checks out." : `Auditor: ${audit.flags.map((f) => `${f.field} — ${f.detail}`).join(" ")}`,
      `Reply Yes to approve it, No to drop it.`,
    ];
    await deps.sendMessage(chatId, lines.join("\n"));
  } catch (err) {
    console.error("[bot-team] scout workup failed", err);
    await deps.sendMessage(chatId, "Dispatch Scout: I couldn't save that draft — try forwarding it again in a moment.");
  }
}

export type { BotSlug, ProposalRow };
export { GROUP_SEATS_PHASE_0 };
