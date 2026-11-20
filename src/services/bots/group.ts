// Telegram group mode for the bot team (Phase 0 baseline).
// One private group, him + the bots. Every bot hears every message;
// only the relevant one answers, the rest stay quiet.
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
// - A message from another bot is handled ONLY when it is
//   addressed to Billing (named by name, or a direct reply to one
//   of Billing's logged messages) — Bot API 9.6 Bot-to-Bot
//   Communication Mode + Group Privacy OFF (or admin) is what
//   delivers it (see services/bots/faces.ts). Anything else from
//   another bot is ignored, and Billing's own messages are ignored
//   (loop guard). Bots coordinate in the room AND through the
//   shared tables.
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
import { formatMoney } from "@/lib/money-format";
import { checkBotAction } from "./guardrails";
import { billingRoomContribution, buildRoomHandoff, createBillingDataStore, handleBillingGroupTurn, type BillingDataStore } from "./billing";
import { parseRoomSpeaker } from "./faces";
import { GROUP_SEATS, type BotSlug } from "./registry";
import { routeGroupMessage, unseatedReply, type GroupRoute } from "./router";
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
   * Billing's invoice data (loads + load_invoices reads). Built by
   * the caller from the company id; null = Billing answers from
   * proposals/memories only and says the invoice data is unavailable.
   * The webhook passes createBillingDataStore(companyId); tests pass
   * a fake. Optional so older callers keep compiling.
   */
  billingData?: BillingDataStore | null;
  /**
   * Which bot face received this update (the webhook's ?bot=
   * parameter; default "abel"). Every bot's webhook receives every
   * owner message, so the handler claims each update once (room-log
   * unique key) and only the claiming webhook answers.
   */
  receivingBot?: BotSlug;
  /**
   * True once Billing has its own Telegram webhook live. Until then
   * the Abel→Billing fan-out below is the bridge: Abel's reply
   * naming Billing also runs Billing's turn in-process. Once the
   * webhook is live, Telegram delivers Abel's post to Billing
   * directly and the fan-out stays off — otherwise Billing would
   * answer twice.
   */
  billingSeparateWebhookLive?: boolean;
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

function senderOf(update: TelegramUpdate): {
  id: number | null;
  isBot: boolean;
  text: string | null;
  messageId: number | null;
  replyToMessageId: number | null;
} {
  const message = update.message;
  const from = message?.from;
  return {
    id: typeof from?.id === "number" ? from.id : null,
    isBot: from?.is_bot === true,
    text: typeof message?.text === "string" ? message.text : null,
    messageId: typeof message?.message_id === "number" ? message.message_id : null,
    replyToMessageId: typeof message?.reply_to_message?.message_id === "number" ? message.reply_to_message.message_id : null,
  };
}

/** Postgres unique-key violation, surfaced by Supabase as code 23505 or in the message. */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /duplicate key value/i.test(message);
}

/**
 * Claim one incoming room message. The room-log insert IS the claim
 * (Postgres job claiming): with one webhook per bot face, the same
 * group message is delivered to every bot's webhook — the first
 * claim wins, the rest see the duplicate key and stand down, so the
 * room answers once. Returns false when another webhook already
 * claimed it. A non-duplicate store failure logs loudly and returns
 * true (today's single-webhook behavior: answer without a log)
 * rather than dropping the message.
 */
async function claimRoomMessage(
  store: BotTeamStore,
  input: {
    telegramChatId: number;
    telegramMessageId: number;
    senderKind: "owner" | "bot";
    senderRef: string;
    text: string;
    routedToBotSlug?: BotSlug | null;
  },
): Promise<boolean> {
  try {
    await store.ensureGroupRoom(input.telegramChatId);
    await store.recordGroupMessage(input);
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    console.error("[bot-team] group message log failed", err);
    return true;
  }
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

  const store = deps.store;
  const sender = senderOf(update);

  // Send wrapper: every bot speech is logged in the room record
  // (bot_group_messages) under the speaker's name, best-effort.
  // The log is what makes reply attribution work — a reply to a
  // message Billing sent is addressed to Billing even when the
  // reply text never names it — and what makes the claim below
  // dedupe across webhooks. Unprefixed system replies are not
  // bot speech and are not logged.
  const sendMessage = async (chatId: number, text: string): Promise<number[]> => {
    const ids = await deps.sendMessage(chatId, text);
    const speaker = parseRoomSpeaker(text);
    if (store && speaker) {
      for (const messageId of ids) {
        try {
          await store.recordGroupMessage({
            telegramChatId: chatId,
            telegramMessageId: messageId,
            senderKind: "bot",
            senderRef: speaker,
            text: text.slice(0, 4000),
            routedToBotSlug: null,
          });
        } catch (err) {
          console.error("[bot-team] bot message log failed", err);
        }
      }
    }
    return ids;
  };

  // Bot-to-bot delivery (Bot API 9.6, core.telegram.org/api/bots/
  // bot-to-bot — verified 2026-11-19): with Bot-to-Bot
  // Communication Mode ON in @BotFather and Group Privacy OFF (or
  // admin), a bot receives other bots' group messages — command
  // mentions addressed to it, direct replies to its messages, and
  // (mode + admin / privacy-off) all of them. Delivery itself is
  // the proof the settings are on: Telegram never delivers a bot
  // message unless the conditions hold. So a bot message that
  // reaches this webhook IS addressed here, and the branch below
  // only has to decide whether it is addressed to BILLING:
  // named by name in the text, or a direct reply to one of
  // Billing's logged messages. Anything else is another bot's
  // business and stays quiet. Billing's own messages are ignored
  // (loop guard). The claim below makes the turn run exactly once
  // even though the same message is delivered to every bot's
  // webhook.
  if (sender.isBot) {
    const botText = sender.text;
    const speaker = botText !== null ? parseRoomSpeaker(botText) : null;
    if (botText === null || speaker === null || speaker === "billing") return "ignored";
    let addressedToBilling = /\bbilling\b/i.test(botText);
    if (!addressedToBilling && sender.replyToMessageId !== null && store) {
      try {
        const repliedTo = await store.findGroupMessage(chat.id, sender.replyToMessageId);
        addressedToBilling = repliedTo?.senderRef === "billing";
      } catch (err) {
        console.error("[bot-team] reply attribution failed", err);
      }
    }
    if (!addressedToBilling) return "ignored";
    if (store && sender.messageId !== null) {
      const claimed = await claimRoomMessage(store, {
        telegramChatId: chat.id,
        telegramMessageId: sender.messageId,
        senderKind: "bot",
        senderRef: speaker,
        text: botText.slice(0, 4000),
        routedToBotSlug: "billing",
      });
      if (!claimed) return "ignored";
    }
    const handoff = await buildRoomHandoff(speaker, botText, deps.billingData ?? (deps.companyId ? createBillingDataStore(deps.companyId) : null));
    await handleBillingGroupTurn(
      chat.id,
      botText,
      { target: "billing", via: "mention", shouldAnswer: true, seated: true },
      { store, billingData: deps.billingData ?? (deps.companyId ? createBillingDataStore(deps.companyId) : null), sendMessage, runChat: deps.runChat },
      { fromBot: speaker, handoff },
    );
    return "handled";
  }
  // The room has no third parties.
  if (sender.id === null || String(sender.id) !== deps.allowedChatId) return "ignored";

  const text = sender.text;

  // Claim the owner's message first: with one webhook per bot face,
  // the same message is delivered to every webhook, and the first
  // claim wins — the rest stand down, so the room answers once.
  // A logging failure that is NOT a duplicate still answers (today's
  // single-webhook behavior), loudly.
  if (store && text !== null && sender.messageId !== null) {
    const claimed = await claimRoomMessage(store, {
      telegramChatId: chat.id,
      telegramMessageId: sender.messageId,
      senderKind: "owner",
      senderRef: String(sender.id),
      text: text.slice(0, 4000),
      routedToBotSlug: null,
    });
    if (!claimed) return "ignored";
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
    // Team room: a delivery / POD notice that lands on a seat not
    // in the room yet (Tracker) is still Billing's cue — the invoice
    // can now be drafted. One short note, only when the records name
    // exactly one load waiting on an invoice. When Tracker seats,
    // this check moves to the tracker branch.
    try {
      const note = await billingRoomContribution(text, deps.billingData ?? createBillingDataStore(deps.companyId));
      if (note) await sendMessage(chat.id, note);
    } catch (err) {
      console.error("[bot-team] billing room contribution failed", err);
    }
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
      await sendMessage(
        chat.id,
        "Dispatch Scout: say 'scout, scan from <city, ST>' and I'll check the boards. Or forward me a dispatch and I'll work it up.",
      );
      return "handled";
    }
    await handleScoutWorkup(chat.id, text, { ...deps, sendMessage });
    return "handled";
  }

  // Billing in this phase: seated since Phase 2. Its turn lives in
  // services/bots/billing.ts — money facts from the records in code,
  // drafts as proposals, and its own instructions (never Abel's).
  // When the job is not clearly Billing's, billingShouldSpeak keeps
  // it quiet and Abel routes the message instead.
  if (route.target === "billing") {
    await handleBillingGroupTurn(chat.id, text, route, {
      store,
      billingData: deps.billingData ?? createBillingDataStore(deps.companyId),
      sendMessage,
      runChat: deps.runChat,
    });
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
    await sendMessage(chat.id, `Abel: ${answer}`);
    // Abel→Billing fan-out — the owner's model: when Abel needs
    // Billing, Abel posts in the room addressed to Billing, and
    // Billing picks it up there. Until Billing has its own webhook
    // live, Telegram cannot deliver Abel's post to Billing (there
    // is no Billing account yet), so the handler runs Billing's turn
    // in-process, once, from Abel's posted text as a validated
    // handoff. Once Billing's own webhook is live
    // (billingSeparateWebhookLive), Telegram delivers the post to
    // Billing's webhook and the bot branch above handles it — the
    // fan-out stays off, so Billing never answers twice. Billing's
    // own branch never fans out further: depth is bounded at two
    // bot turns per owner update by construction.
    if (!deps.billingSeparateWebhookLive && /\bbilling\b/i.test(answer)) {
      try {
        const billingData = deps.billingData ?? createBillingDataStore(deps.companyId);
        const handoff = await buildRoomHandoff("abel", answer, billingData);
        await handleBillingGroupTurn(
          chat.id,
          answer,
          { target: "billing", via: "mention", shouldAnswer: true, seated: true } satisfies GroupRoute,
          { store, billingData, sendMessage, runChat: deps.runChat },
          { fromBot: "abel", handoff },
        );
      } catch (err) {
        console.error("[bot-team] Abel→Billing fan-out failed", err);
      }
    }
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

export type { BotSlug, ProposalRow };
export { GROUP_SEATS };
