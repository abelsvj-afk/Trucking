// Telegram group mode for the bot team (Phase 0 baseline).
// One private group, him + the bots. Every bot hears the OWNER's
// messages; only the relevant one answers, the rest stay quiet.
// Each bot has its own Telegram account and profile photo and
// messages as itself (individual faces, owner rule 2026-11-19).
//
// The Telegram mechanic that bounds this room (Bots FAQ, verified
// 2026-11-19): bots never see messages from other bots,
// regardless of mode — so a bot hears the owner, never another
// bot. Handoffs therefore travel inside the app: when a bot's
// answer names another bot, the handler runs that bot's turn once
// (one hop per incoming message, bounded) and that bot answers
// under its own name. The owner sees the team-room behavior; the
// plumbing underneath is the shared backend, not Telegram.
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
// - A message from another bot is logged and ignored — Telegram
//   never delivers one bot's message to another bot, so no bot
//   message should ever arrive here at all; the guard stays
//   because a human could forward one.
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
// A denied load draft teaches the bot that staged it: its Auditor
// flags become correction memories (services/bots/outcomes.ts),
// and a second correction of the same field becomes a watch-out
// read into every later turn — Abel's corrections-learning,
// shared.
//
// Every seated bot answers through the shared turn
// (services/bots/turn.ts): the same reasoning, the same memory
// and learning shape, its own scoped tools and its own identity.
// The turn carries the live company snapshot — a group answer
// never states a live figure it has not loaded.

import { randomUUID } from "node:crypto";
import { auditLoadDraft } from "./auditor";
import { formatMoney } from "@/lib/money-format";
import { checkBotAction } from "./guardrails";
import { recordBotCorrection } from "./outcomes";
import { botDisplayName } from "./reasoning";
import { GROUP_SEATS_PHASE_0, type BotSlug } from "./registry";
import { routeGroupMessage, unseatedReply } from "./router";
import { type BotTeamStore, type ProposalRow } from "./store";
import type { BotTurnInput, BotTurnResult } from "./turn";
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
   * Post as a named bot under its own Telegram account (individual
   * faces). When absent — no per-bot tokens are configured yet —
   * bot replies go through sendMessage with the bot's name first.
   * Wiring the tokens is a Phase 1 step; the fallback keeps the
   * room working today.
   */
  sendAsBot?: (slug: BotSlug, chatId: number, text: string) => Promise<number[]>;
  /**
   * One bot's shared turn. Built lazily by the caller (the OpenAI
   * provider throws without a key); undefined = the group says AI
   * is not configured instead of failing.
   */
  runBotTurn?: (input: BotTurnInput) => Promise<BotTurnResult>;
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

  // Recent group history FIRST, so it does not include this message
  // (the turn gets userText separately). Best-effort: a failed load
  // means the turn answers without history, never no answer.
  const history = await loadGroupHistory(store, chat.id);

  // Log the owner's message (best-effort: a logging failure is
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
  // proposal — the same grammar as the 1:1 waiting list. A denial
  // of a load draft teaches the bot that staged it: the Auditor's
  // flags become correction memories (a second correction of the
  // same field becomes a watch-out).
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
      await store.logAudit({
        botSlug: target.bot_slug,
        actor: "owner",
        action: `proposal_${decision.decision}`,
        targetRef: target.id,
        detail: { title: target.title, via: "group" },
      });
      if (decision.decision === "denied") {
        for (const flag of deniedFlagsOf(target)) {
          try {
            await recordBotCorrection(store, {
              botSlug: target.bot_slug,
              field: flag.field,
              detail: flag.detail,
              sourceRef: target.id,
            });
          } catch (err) {
            console.error("[bot-team] correction record failed", err);
          }
        }
      }
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

  // Dispatch Scout: a forwarded dispatch gets worked up into an
  // auditor-checked proposal, in code (numbers out of the text,
  // never invented). Anything else goes to the shared turn, which
  // carries the boards-not-live note — a board question gets a
  // plain "not yet", never invented loads.
  if (route.target === "dispatch-scout") {
    const looksLikeDispatch = /\b(pickup|delivery|rate|broker|load)\b/i.test(text) && /\d/.test(text);
    if (looksLikeDispatch) {
      await handleScoutWorkup(chat.id, text, deps);
      return "handled";
    }
  }

  // Every seated bot answers through the shared turn.
  if (!deps.runBotTurn) {
    await deps.sendMessage(
      chat.id,
      `${botDisplayName(route.target)}: I can't answer that yet — the AI key isn't configured on the server. Nothing was sent anywhere.`,
    );
    return "handled";
  }
  const runId = randomUUID();
  try {
    const result = await deps.runBotTurn({
      slug: route.target,
      userText: text,
      history,
      telegramChatId: chat.id,
      runId,
    });
    await postBotReply(chat.id, route.target, result.reply, deps);
    // One internal handoff: the answer names another bot, so that
    // bot takes the work and answers under its own name. One hop —
    // the handoff turn is terminal, so the room cannot talk to
    // itself. (A Telegram handoff cannot work at all: bots never
    // see each other's messages.)
    if (result.handoffTo && result.handoffTo !== route.target) {
      try {
        const handoff = await deps.runBotTurn({
          slug: result.handoffTo,
          userText: text,
          history,
          telegramChatId: chat.id,
          runId,
          handoff: { fromBot: route.target, objective: text, summary: result.reply },
        });
        await postBotReply(chat.id, result.handoffTo, handoff.reply, deps);
      } catch (err) {
        console.error("[bot-team] group handoff turn failed", err);
      }
    }
  } catch (err) {
    console.error("[bot-team] group turn failed", err);
    await deps.sendMessage(
      chat.id,
      `${botDisplayName(route.target)}: that turn failed on my side — nothing was booked or sent. Try again in a moment.`,
    );
  }
  return "handled";
}

/** Recent group messages as turn history, oldest first. */
async function loadGroupHistory(
  store: BotTeamStore | null,
  telegramChatId: number,
): Promise<{ role: "user" | "assistant"; text: string }[]> {
  if (!store) return [];
  try {
    const rows = await store.loadRecentGroupMessages(telegramChatId, 10);
    return rows.map((row) => ({
      role: row.sender_kind === "bot" ? ("assistant" as const) : ("user" as const),
      text: row.text,
    }));
  } catch (err) {
    console.error("[bot-team] group history load failed", err);
    return [];
  }
}

/**
 * Post one bot's reply and log it as a group message, so later
 * turns see it. With per-bot tokens configured (sendAsBot) the
 * bot posts under its own account; without them the fallback
 * posts through the group's bot with the bot's name first.
 */
async function postBotReply(chatId: number, slug: BotSlug, reply: string, deps: GroupHandlerDeps): Promise<void> {
  let messageIds: number[] = [];
  try {
    messageIds = deps.sendAsBot
      ? await deps.sendAsBot(slug, chatId, reply)
      : await deps.sendMessage(chatId, `${botDisplayName(slug)}: ${reply}`);
  } catch (err) {
    console.error("[bot-team] bot reply send failed", err);
    return;
  }
  const store = deps.store;
  if (!store) return;
  try {
    await store.recordGroupMessage({
      telegramChatId: chatId,
      telegramMessageId: messageIds[0] ?? 0,
      senderKind: "bot",
      senderRef: slug,
      text: reply.slice(0, 4000),
      routedToBotSlug: slug,
    });
  } catch (err) {
    console.error("[bot-team] bot reply log failed", err);
  }
}

/**
 * The Auditor flags carried by a denied proposal, for the
 * corrections-learning record. Load drafts carry `flags`; shortlists
 * carry per-load `audit` entries. Anything else carries none.
 */
function deniedFlagsOf(target: ProposalRow): { field: string; detail: string }[] {
  const payload = target.payload ?? {};
  const readFlags = (value: unknown): { field: string; detail: string }[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const flag = entry as { field?: unknown; detail?: unknown };
      return typeof flag.field === "string" && typeof flag.detail === "string"
        ? [{ field: flag.field, detail: flag.detail }]
        : [];
    });
  };
  if (target.kind === "load-draft") return readFlags(payload.flags);
  if (target.kind === "load-shortlist") {
    const audit = Array.isArray(payload.audit) ? payload.audit : [];
    return audit.flatMap((entry) =>
      entry && typeof entry === "object" ? readFlags((entry as { flags?: unknown }).flags) : [],
    );
  }
  return [];
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
