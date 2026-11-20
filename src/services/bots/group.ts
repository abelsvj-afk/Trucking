// Telegram group mode for the bot team (Phase 0 baseline).
// One private group, him + the bots — with EACH bot messaging as
// itself under its own Telegram account + profile photo (owner,
// 2026-11-19: INDIVIDUAL FACES; the one-face model was rejected).
// What Telegram still blocks: bots "will not be able to see messages
// from other bots regardless of mode" (Bots FAQ, verified
// 2026-11-19), so a bot's account is a sender face, not a reader of
// other bots — the bots coordinate internally (Supabase / in-process
// calls — see routedByBotSlug in router.ts, the supervisor-first
// handoff seam) and each posts under its own name. The "every bot
// hears every message" picture does not work as stated on Telegram.
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
import { auditLoadDraft, formatAuditReply, type LoadDraftInput } from "./auditor";
import { createBrowserRuntime, type BrowserRuntime } from "./browser-runtime";
import {
  parseCostPreferences,
  parseScanRequest,
  recordShortlistDecision,
  runScoutScan,
  type ScoutScanResult,
} from "./dispatch-scout";
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
   * Per-bot face (owner, 2026-11-19: INDIVIDUAL FACES — each bot
   * its own Telegram account + profile photo, messaging as itself;
   * the one-face model was rejected). When the caller wires a bot's
   * own token, its messages post under that account; when absent,
   * everything falls back to sendMessage (the coordinator's face).
   * A bot's account is a SENDER face only: Telegram delivers no
   * bot-to-bot messages, so no bot ever reads another bot's posts —
   * coordination stays internal (Supabase / in-process).
   */
  sendAsBot?: (botSlug: BotSlug, chatId: number, text: string) => Promise<number[]>;
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
  // Bots do not answer each other — and on Telegram they cannot even
  // see each other: the Bots FAQ ("Why doesn't my bot see messages
  // from other bots?", verified 2026-11-19) says bots "will not be
  // able to see messages from other bots regardless of mode", and
  // that privacy-off/admin bots receive "all messages except messages
  // sent by other bots". So there is no bot-to-bot handoff by
  // message in this room: each bot posts under its own account
  // (individual faces), and the bots coordinate internally
  // (Supabase / in-process calls, never by messaging each other).
  // A message from another bot is ignored, as before.
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

  // AUDITOR ROUTING (owner, 2026-11-19 — team-room correction): a
  // message that merely looks like an Auditor job — keyword only, no
  // name, no handoff, nothing checkable in it — does NOT wake the
  // Auditor. It stays quiet and the message goes to Abel, the
  // coordinator, with a routing hint. Abel settles it in the room
  // where he can — handing it to the Auditor by name, or answering
  // it himself — and only pulls the owner in when a decision or
  // approval is needed. Abel never answers a fact-check himself with
  // numbers he has not recomputed.
  let target = route.target;
  let routingHint: string | null = null;
  if (route.deferredToCoordinator) {
    routingHint =
      `ROUTING (you are the coordinator): this message looked like an Auditor job — "${text.slice(0, 200)}" — ` +
      `but it was not clearly routed to the Auditor, so the Auditor stayed quiet. Settle it in the room: ` +
      `if it needs a fact-check, hand it to the Auditor by name; if it is your job, answer it. ` +
      `Only pull the owner in when a decision or approval is needed. ` +
      `Do not answer a fact-check yourself with numbers you have not recomputed.`;
    target = route.deferredToCoordinator;
  }
  if (!route.shouldAnswer && !route.deferredToCoordinator) return "handled";

  // Dispatch Scout in this phase: a scan request walks the ranked
  // boards at human pace and posts a shortlist proposal; a forwarded
  // dispatch gets worked up into an auditor-checked proposal.
  if (target === "dispatch-scout") {
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

  // Auditor: a clear route only (called by name, routed by Abel or
  // handed off by any bot in-process, a reply to its own message,
  // or its own turn — a draft has landed with checkable numbers).
  // The check itself is code, not a model turn: the Auditor
  // recomputes the numbers and posts the flag, or one line when it
  // checks out. There is deliberately NO model call for the Auditor
  // in this phase — no per-bot tool gateway exists yet, so a model
  // turn would see Abel's full tool list, including write tools the
  // Auditor must never see. The Auditor's reasoning prompt
  // (services/bots/reasoning.ts) is built and tested, and plugs into
  // that turn when the gateway lands.
  if (target === "auditor") {
    await handleAuditorCheck(chat.id, text, deps);
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
    const instructions: { kind: string; content: string }[] = memories.map((row) => ({ kind: row.kind, content: row.content }));
    // A message deferred from the Auditor's seat arrives with a
    // routing hint, so Abel knows why he is seeing it.
    if (routingHint) instructions.push({ kind: "routing", content: routingHint });
    const reply = await deps.runChat({
      userText: text,
      history: [],
      instructions,
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

/**
 * The Auditor posts under its own face when one is wired
 * (deps.sendAsBot with the Auditor's own BotFather token); until
 * its token is configured it falls back to the coordinator's face
 * (sendMessage). The text is identical either way — the face is
 * presentation, never a change to the check.
 */
async function sendAuditorMessage(chatId: number, text: string, deps: GroupHandlerDeps): Promise<void> {
  if (deps.sendAsBot) {
    await deps.sendAsBot("auditor", chatId, text);
    return;
  }
  await deps.sendMessage(chatId, text);
}

/**
 * The Auditor's turn in the group: recompute, then flag or say
 * "checks out". Two ways in:
 * - The owner's message carries numbers (a draft pasted in the
 *   chat): parse them out in code and audit them.
 * - It carries no numbers ("check the latest draft"): re-audit the
 *   newest open load-draft proposal from its stored payload.
 * Nothing is ever written except the flag itself (a group-chat
 * message) and the audit-log entry — no proposal is created, no
 * record is changed, and the draft is never silently fixed.
 *
 * IDEMPOTENCY (chat-scoped, from the multi-agent research): Telegram
 * redelivers updates, and the Bot API has no idempotency key of its
 * own, so a redelivered check must not post the flag twice. Every
 * check carries a deterministic key (proposal id + payload hash, or
 * a hash of the free text); a check whose key is already in the
 * audit log is skipped silently — the first verdict stands. The
 * Auditor is the single writer of auditor_check entries, so one key
 * means one flag. A redelivery and an intentional repeat look the
 * same from here; the owner repeats a check by varying the text.
 */
async function handleAuditorCheck(chatId: number, text: string, deps: GroupHandlerDeps): Promise<void> {
  const store = deps.store;
  // The flag gate, in code: the Auditor may only flag on groups it
  // can read. If this ever says no, the check refuses out loud.
  const gate = checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "app-actions" });
  if (!gate.allowed) {
    await sendAuditorMessage(chatId, `Auditor: ${gate.reason}`, deps);
    return;
  }
  const numbers = parseAuditorCheckNumbers(text);
  const hasNumbers =
    numbers.payCents !== null || numbers.loadedMiles !== null || numbers.rateCentsPerLoadedMile !== null;
  try {
    if (hasNumbers) {
      const checkKey = auditorCheckKey({ kind: "text", text });
      if (store && (await store.hasAuditorCheck(checkKey))) {
        console.log("[bot-team] auditor check already posted for this message — skipping duplicate flag");
        return;
      }
      const audit = auditLoadDraft(numbers);
      await store?.logAudit({
        botSlug: "auditor",
        actor: "bot",
        action: "auditor_check",
        detail: { kind: "free-text", check_key: checkKey, passed: audit.passed, flags: audit.flags.map((f) => f.field) },
      });
      await sendAuditorMessage(chatId, `Auditor: ${formatAuditReply(audit)}`, deps);
      return;
    }
    if (!store) {
      await sendAuditorMessage(
        chatId,
        "Auditor: I can't check the drafts on file — the team database isn't configured on the server yet. Paste the numbers (pay, miles, rate) and I'll check those.",
        deps,
      );
      return;
    }
    const open = await store.listOpenProposals(5);
    const draft = open.find((proposal) => proposal.kind === "load-draft");
    if (!draft) {
      await sendAuditorMessage(
        chatId,
        "Auditor: nothing to check right now — forward a draft with pay, miles, and windows, or name the load and I'll check it against its source.",
        deps,
      );
      return;
    }
    const checkKey = auditorCheckKey({ kind: "proposal", proposalId: draft.id, payload: draft.payload });
    if (await store.hasAuditorCheck(checkKey)) {
      console.log("[bot-team] auditor check already posted for this draft — skipping duplicate flag");
      return;
    }
    const audit = auditLoadDraft(proposalPayloadToLoadDraft(draft.payload));
    await store.logAudit({
      botSlug: "auditor",
      actor: "bot",
      action: "auditor_check",
      targetRef: draft.id,
      detail: { kind: "proposal", check_key: checkKey, passed: audit.passed, flags: audit.flags.map((f) => f.field) },
    });
    await sendAuditorMessage(chatId, `Auditor — checking "${draft.title}": ${formatAuditReply(audit)}`, deps);
  } catch (err) {
    console.error("[bot-team] auditor check failed", err);
    await sendAuditorMessage(chatId, "Auditor: that check failed on my side — nothing was flagged and nothing was changed. Try again in a moment.", deps);
  }
}

/** Small deterministic hash (djb2, hex) for idempotency keys. Pure. */
function hashText(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * The idempotency key for one Auditor check. Free text: a hash of
 * the normalized message, so a redelivery of the same message is
 * the same check. A proposal: its id plus a hash of its payload, so
 * a re-check of the same draft is the same check, but an edited
 * draft is a new one.
 */
function auditorCheckKey(
  input: { kind: "text"; text: string } | { kind: "proposal"; proposalId: string; payload: Record<string, unknown> },
): string {
  if (input.kind === "text") {
    return `auditor-check:text:${hashText(input.text.trim().replace(/\s+/g, " ").toLowerCase())}`;
  }
  return `auditor-check:proposal:${input.proposalId}:${hashText(JSON.stringify(input.payload))}`;
}

/**
 * Numbers out of a check request, in code — the model never invents
 * them. Pay is the largest money figure; the rate is a figure per
 * mile ("$3.00/mi", "3.00 per mile"); loaded miles prefer an
 * explicit "loaded" qualifier, deadhead its own figure. Windows
 * cannot be read reliably out of free text, so they stay null and
 * the check says "cannot verify" for them — honestly, not silently.
 */
function parseAuditorCheckNumbers(text: string): LoadDraftInput {
  // Money only counts when it is marked as money ($, dollars, usd):
  // a bare "500" in "500 loaded miles" is miles, not pay. (The Scout
  // workup's looser parse takes the largest bare number as pay; this
  // path does not copy that — a check must not invent a pay figure
  // out of a mile count.)
  const moneyMatches = [
    ...text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g),
    ...text.matchAll(/([\d,]+(?:\.\d{2})?)\s*(?:dollars|usd)\b/gi),
  ].map((m) => Number(m[1]!.replace(/,/g, "")));
  const mileMatches = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:mi|miles)\b/gi)].map((m) =>
    Number(m[1]!.replace(/,/g, "")),
  );
  const rateMatch = /\$?\s?([\d,]+(?:\.\d+)?)\s*(?:\/|per)\s*(?:loaded\s*)?mi\b/i.exec(text);
  const loadedMatch = /([\d,]+(?:\.\d+)?)\s*loaded\s*(?:mi|miles)\b/i.exec(text);
  const deadheadMatch = /deadhead\s*(?:is\s*)?([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*deadhead/i.exec(text);
  const payCents = moneyMatches.length > 0 ? Math.round(Math.max(...moneyMatches) * 100) : null;
  const rateCentsPerLoadedMile = rateMatch ? Math.round(Number(rateMatch[1]!.replace(/,/g, "")) * 100) : null;
  const deadheadMiles = deadheadMatch
    ? Number((deadheadMatch[1] ?? deadheadMatch[2]!).replace(/,/g, ""))
    : null;
  const loadedMiles = loadedMatch
    ? Number(loadedMatch[1]!.replace(/,/g, ""))
    : mileMatches.length > 0
      ? Math.max(...mileMatches.filter((miles) => miles !== deadheadMiles))
      : null;
  return { rateCentsPerLoadedMile, payCents, loadedMiles, deadheadMiles };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A stored load-draft proposal payload back into a checkable draft. */
function proposalPayloadToLoadDraft(payload: Record<string, unknown>): LoadDraftInput {
  return {
    rateCentsPerLoadedMile: numberOrNull(payload.rateCentsPerLoadedMile),
    payCents: numberOrNull(payload.payCents),
    loadedMiles: numberOrNull(payload.loadedMiles),
    deadheadMiles: numberOrNull(payload.deadheadMiles),
    pickupWindowStart: stringOrNull(payload.pickupWindowStart),
    pickupWindowEnd: stringOrNull(payload.pickupWindowEnd),
    deliveryWindowStart: stringOrNull(payload.deliveryWindowStart),
    deliveryWindowEnd: stringOrNull(payload.deliveryWindowEnd),
  };
}

export type { BotSlug, ProposalRow };
export { GROUP_SEATS_PHASE_0 };
