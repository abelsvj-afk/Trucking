// Telegram group mode for the bot team (Phase 0 baseline; Tracker
// joins in Phase 2). One private group, him + the bots. Every bot
// hears every message; a bot speaks when it has something to add, the
// rest stay quiet.
//
// The group chat is a TEAM ROOM and the SHARED CHANNEL (owner rule
// 2026-11-19): everything the owner posts there lands for all the
// bots, and when Abel needs Tracker, Abel posts the message in the
// group chat too, addressed to Tracker, and Tracker picks it up
// there. The messages live in the room where everyone can see them —
// the group is the channel, not a database-only relay the owner
// never sees. The bots talk to each other and to the owner, hand work
// off, and report progress out loud; they only pull the owner in when
// a decision or approval actually needs him. Abel is the boss for
// what needs the owner's attention — not the only one who talks.
//
// The Telegram mechanics (verified 2026-11-19 against Telegram's own
// docs, core.telegram.org/api/bots/bot-to-bot and /bots/faq):
// each bot is its own BotFather bot with its own profile photo
// (individual faces — services/bots/faces.ts), Bot-to-Bot
// Communication Mode enabled for every bot in @BotFather, and Group
// Privacy Mode disabled (or group admin) so each bot receives the
// owner's ordinary group messages. With the mode on, a bot receives
// another bot's message when it is mentioned by command
// (/command@TargetBot) or is a direct reply to one of its messages
// (at least one of the two bots needs the mode on); a bot with the
// mode on that is an admin or has privacy disabled also receives
// other bots' messages without a mention or reply. Without the mode,
// the default applies and bots do not see each other's messages at
// all — the handoff queue (bot_handoffs) is the fallback, and the
// room post is still visible to the owner. Loop guards are in code:
// a bot answers another bot ONLY when addressed by name or in reply,
// never its own chatter, never unprompted.
//
// One webhook invocation per bot face: every bot's webhook calls this
// handler with its own faceBotSlug, and the deterministic router
// decides once — only the face the message routes to acts (the face
// gate below). Owner decisions ("yes"/"no") are Abel's job, so only
// Abel's face handles them. Without a faceBotSlug (the single-bot
// deployment today) the handler behaves exactly as before: it acts
// on every routed message.
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
//   is ignored silently. The room has no third parties — a bot sender
//   is trusted only when its username is one of the team's faces
//   (services/bots/faces.ts).
// - A message from another bot is routed like any other message, but
//   a bot only ever answers when addressed by name or in reply —
//   never unprompted bot chatter, never its own messages, or the room
//   would talk to itself.
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
// Phase 1 gap, listed in the PR. Tracker's group answers have the same
// shape (its own system prompt + its stored memories + any handoff
// queued for it), and the same gap.

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
import { slugForUsername } from "./faces";
import { checkBotAction } from "./guardrails";
import { GROUP_SEATS_PHASE_2, type BotSlug } from "./registry";
import { routeGroupMessage, unseatedReply } from "./router";
import { capReached, estimateCallCostCents, modelForTier, monthlyCapCents, monthStartIso, SPEND_CAP_REACHED_TEXT } from "./spend";
import { type BotTeamStore, type ProposalRow } from "./store";
import {
  buildHandoffPayload,
  checkTrackerAction,
  composeHandoff,
  decideTrackerSpeech,
  detectEscalation,
  detectHandoffNeed,
  detentionStatus,
  DETENTION_FREE_MINUTES,
  formatCheckCall,
  nextHandoffDepth,
  parseCheckCall,
  parseDocReceipt,
  podPacketStatus,
  trackerSystemPrompt,
} from "./tracker";
import type { DetentionStop } from "@/services/bot/detention";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";

export interface GroupHandlerDeps {
  botToken: string;
  /** Owner's Telegram chat id (TELEGRAM_ALLOWED_CHAT_ID). */
  allowedChatId: string | null;
  /** Allowlisted group chat id (TELEGRAM_GROUP_CHAT_ID). Null = groups ignored. */
  groupChatId: string | null;
  companyId: string | null;
  store: BotTeamStore | null;
  /**
   * Which bot face's webhook fired this invocation. Absent in the
   * single-bot deployment (today): the handler acts on every routed
   * message. Present in the multi-face deployment: only the face the
   * message routes to acts (the face gate), and only Abel's face
   * handles owner decisions.
   */
  faceBotSlug?: BotSlug;
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
  username: string | null;
  text: string | null;
  messageId: number | null;
  replyToMessageId: number | null;
} {
  const message = update.message;
  const from = message?.from;
  const replyTo = message?.reply_to_message?.message_id;
  return {
    id: typeof from?.id === "number" ? from.id : null,
    isBot: from?.is_bot === true,
    username: typeof from?.username === "string" ? from.username : null,
    text: typeof message?.text === "string" ? message.text : null,
    messageId: typeof message?.message_id === "number" ? message.message_id : null,
    replyToMessageId: typeof replyTo === "number" ? replyTo : null,
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
  // The room has no third parties. A human sender must be the owner.
  // A bot sender must be one of the team's faces (services/bots/
  // faces.ts) — an unknown bot is ignored fail-closed. Bot-to-bot
  // delivery itself is a Telegram setting (Bot-to-Bot Communication
  // Mode + Privacy OFF); the code only decides who a delivered
  // message may come from.
  let senderBotSlug: BotSlug | null = null;
  if (sender.isBot) {
    senderBotSlug = slugForUsername(sender.username);
    if (senderBotSlug === null) return "ignored";
  } else if (sender.id === null || String(sender.id) !== deps.allowedChatId) {
    return "ignored";
  }

  const text = sender.text;
  const store = deps.store;

  if (text === null || text.trim() === "") {
    await deps.sendMessage(chat.id, "Text only in the group for now — photos and files go to Abel 1:1.");
    return "handled";
  }

  // A reply to a bot's message goes to that bot. The replied-to
  // message's sender comes from the group-message log (best-effort:
  // an unlogged reply routes by mention/keyword instead).
  let replyToBotSlug: BotSlug | undefined;
  if (sender.replyToMessageId !== null && store) {
    try {
      const senderRef = await store.getGroupMessageSender(chat.id, sender.replyToMessageId);
      if (senderRef === "tracker" || senderRef === "abel" || senderRef === "dispatch-scout") {
        replyToBotSlug = senderRef;
      }
    } catch (err) {
      console.error("[bot-team] reply-to lookup failed — routing by text instead", err);
    }
  }
  const route = routeGroupMessage({ text, senderKind: sender.isBot ? "bot" : "owner", senderSlug: senderBotSlug ?? undefined, replyToBotSlug });

  // The face gate (multi-face deployment only; absent faceBotSlug
  // means the single-bot deployment, which acts on every message).
  // The router decides once, deterministically — only the face the
  // message routes to acts, so one message gets one answer however
  // many webhooks fired for it. Owner decisions are Abel's job, so
  // only Abel's face handles them.
  const decision = parseGroupDecision(text);
  if (deps.faceBotSlug) {
    if (decision) {
      if (deps.faceBotSlug !== "abel") return "handled";
    } else if (route.target !== deps.faceBotSlug) {
      return "handled";
    }
  }

  // Log the message (the acting face only — the face gate above
  // already picked it — with the route attached, so a reply to it
  // resolves). Best-effort: a logging failure is loud in the console
  // but never fails the reply.
  if (store && sender.messageId !== null) {
    try {
      await store.ensureGroupRoom(chat.id);
      await store.recordGroupMessage({
        telegramChatId: chat.id,
        telegramMessageId: sender.messageId,
        senderKind: sender.isBot ? "bot" : "owner",
        senderRef: sender.isBot ? (senderBotSlug ?? "unknown-bot") : String(sender.id),
        text: text.slice(0, 4000),
        routedToBotSlug: route.target,
      });
    } catch (err) {
      console.error("[bot-team] group message log failed", err);
    }
  }

  // A decision ("yes" / "no" / "2 yes") answers the newest open
  // proposal — the same grammar as the 1:1 waiting list. Owner-only:
  // a bot saying "yes" never decides a proposal.
  if (decision && store && !sender.isBot) {
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

  // Tracker (Phase 2): the team-room seat. It speaks when it has
  // something to add — its job, a reply, a handoff, its own turn — and
  // stays quiet when it has nothing to add (decideTrackerSpeech is the
  // authority). A Tracker message with nothing to add falls through to
  // Abel below, who routes it.
  if (route.target === "tracker") {
    const speech = decideTrackerSpeech({ context: "group", via: route.via, senderKind: sender.isBot ? "bot" : "owner" });
    if (speech.speak) {
      await handleTrackerTurn(chat.id, text, sender.messageId, deps);
      return "handled";
    }
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
 * Post a Tracker line in the room and log it as a bot message, so a
 * reply to it routes back to Tracker and the room is reconstructable.
 * The send is the promise; the log is best-effort (a logging failure
 * is loud in the console but never fails the reply).
 */
async function postTracker(chatId: number, line: string, routedTo: BotSlug | null, deps: GroupHandlerDeps): Promise<void> {
  const text = `Tracker: ${line}`;
  let sentIds: number[] = [];
  try {
    sentIds = await deps.sendMessage(chatId, text);
  } catch (err) {
    console.error("[bot-team] tracker send failed", err);
    return;
  }
  const store = deps.store;
  const sentId = sentIds[0];
  if (store && typeof sentId === "number") {
    try {
      await store.recordGroupMessage({
        telegramChatId: chatId,
        telegramMessageId: sentId,
        senderKind: "bot",
        senderRef: "tracker",
        text: text.slice(0, 4000),
        routedToBotSlug: routedTo,
      });
    } catch (err) {
      console.error("[bot-team] tracker message log failed", err);
    }
  }
}

/**
 * Tracker's group turn. Structured work is done in code, not by the
 * model — a check call is parsed, logged, and confirmed in one line;
 * an escalation is flagged at once and stops; a handoff is posted in
 * the open AND recorded as a row the target bot can claim. Anything
 * else goes to the model with Tracker's system prompt (the shared ten
 * reasoning forms, verbatim), its stored memories, and any handoff a
 * teammate queued for it.
 *
 * Order matters: escalation first (it stops everything), then the
 * structured work (check call + paperwork can both land in one
 * message), then handoffs, then the model turn.
 */
async function handleTrackerTurn(chatId: number, text: string, messageId: number | null, deps: GroupHandlerDeps): Promise<void> {
  const store = deps.store;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const audit = async (action: string, targetRef: string | null, detail: Record<string, unknown>): Promise<void> => {
    if (!store) return;
    try {
      await store.logAudit({ botSlug: "tracker", actor: "bot", action, targetRef, detail });
    } catch (err) {
      console.error("[bot-team] tracker audit failed", err);
    }
  };

  // Escalation: flag the owner at once and stop. No model turn, no
  // smoothing over.
  const escalation = detectEscalation(text);
  if (escalation) {
    await audit("escalation_flagged", null, { kind: escalation.kind, reason: escalation.reason, sourceText: text.slice(0, 500) });
    await postTracker(chatId, `flagging this for Sajacous — ${escalation.reason}. I'm not acting on it until he says so.`, "abel", deps);
    return;
  }

  // Structured work: a check call and/or a paperwork receipt, in one
  // reply. Both are reversible internal writes — automatic under the
  // guardrails, and logged.
  const lines: string[] = [];
  let didStructuredWork = false;
  const call = parseCheckCall(text);
  if (call) {
    const gate = checkTrackerAction({ actionKind: "log_check_call", group: "loads" });
    if (!gate.allowed) {
      await postTracker(chatId, `I can't log that on my own — ${gate.reason}`, null, deps);
      return;
    }
    if (store) {
      try {
        await store.recordCheckCall({ kind: call.kind, place: call.place, note: text.slice(0, 500), eventAt: nowIso });
      } catch (err) {
        console.error("[bot-team] tracker check-call record failed", err);
        lines.push("(couldn't save the check call — the team database didn't take it)");
      }
      // Detention side-effects: arriving starts the clock, leaving ends
      // it and reports the total. Same 2-hour free-time rule as Abel.
      try {
        if (call.kind === "arrived") {
          const clock = await store.startDetentionClock({
            stopLabel: call.place ?? "stop",
            arrivedAt: nowIso,
            freeMinutes: DETENTION_FREE_MINUTES,
          });
          const stop: DetentionStop = {
            id: clock.id,
            label: clock.stop_label,
            arrivedAt: clock.arrived_at,
            departedAt: null,
            appointmentAt: clock.appointment_at,
          };
          lines.push(detentionStatus(stop, nowMs).line);
        } else if (call.kind === "departed") {
          const open = await store.getOpenDetentionClock();
          if (open) {
            const ended = await store.endDetentionClock(open.id, nowIso);
            const stop: DetentionStop = {
              id: ended.id,
              label: ended.stop_label,
              arrivedAt: ended.arrived_at,
              departedAt: ended.ended_at,
              appointmentAt: ended.appointment_at,
            };
            lines.push(detentionStatus(stop, nowMs).line);
          }
        }
      } catch (err) {
        console.error("[bot-team] tracker detention clock failed", err);
      }
    }
    lines.unshift(formatCheckCall(call, nowMs));
    didStructuredWork = true;
    await audit("check_call_logged", null, { kind: call.kind, place: call.place });
  }
  const docs = parseDocReceipt(text);
  if (docs) {
    if (store) {
      try {
        const current = await store.getDocPacket(null);
        const merged = {
          bolReceived: (current?.bol_received ?? false) || docs.bol,
          podReceived: (current?.pod_received ?? false) || docs.pod,
        };
        await store.setDocPacket({ loadRef: null, ...merged });
        lines.push(podPacketStatus(merged).line);
      } catch (err) {
        console.error("[bot-team] tracker doc packet failed", err);
        lines.push("(couldn't file the paperwork — the team database didn't take it)");
      }
    } else {
      lines.push(podPacketStatus({ bolReceived: docs.bol, podReceived: docs.pod }).line);
    }
    didStructuredWork = true;
    await audit("doc_packet_updated", null, { bol: docs.bol, pod: docs.pod });
  }
  if (didStructuredWork) {
    if (!store) lines.push("I couldn't save it — the team database isn't configured on the server yet.");
    await postTracker(chatId, lines.join("\n"), null, deps);
    return;
  }

  // Handoff: Tracker cannot finish its own job until another bot does
  // something. Posted in the open AND recorded as a row the target bot
  // can claim — the room post is the visible face, the row is the work.
  const handoff = detectHandoffNeed(text);
  if (handoff) {
    const depth = nextHandoffDepth(null);
    if (depth === null) {
      await postTracker(chatId, "this has bounced between bots too many times — flagging it for Sajacous instead.", "abel", deps);
      return;
    }
    if (store) {
      try {
        const row = await store.recordHandoff({
          fromBot: "tracker",
          toBot: handoff.to,
          title: `Tracker needs ${handoff.to}: ${handoff.what.slice(0, 120)}`,
          payload: buildHandoffPayload(handoff, null),
          depth,
          idempotencyKey:
            messageId !== null ? `group:${chatId}:${messageId}:${handoff.to}` : `tracker-handoff-${randomUUID()}`,
        });
        await audit("handoff_created", row.id, { to: handoff.to, depth });
      } catch (err) {
        console.error("[bot-team] tracker handoff record failed", err);
      }
    }
    await postTracker(chatId, composeHandoff(handoff), handoff.to, deps);
    return;
  }

  // Model turn: Tracker's system prompt (shared ten reasoning forms,
  // verbatim) + its stored memories + any handoff a teammate queued
  // for it, claimed first so only Tracker works it.
  if (!deps.runChat) {
    await postTracker(chatId, "I can't answer that yet — the AI key isn't configured on the server. Nothing was sent anywhere.", null, deps);
    return;
  }
  if (store) {
    try {
      const spent = await store.spentThisMonthCents(monthStartIso());
      if (capReached(spent, monthlyCapCents())) {
        await postTracker(chatId, SPEND_CAP_REACHED_TEXT, null, deps);
        return;
      }
    } catch (err) {
      console.error("[bot-team] spend check failed — refusing the model call", err);
      await postTracker(chatId, "I couldn't check the spending cap, so I'm not calling the model on this one. Try again in a moment.", null, deps);
      return;
    }
  }
  const instructions: { kind: string; content: string }[] = [{ kind: "tracker-system", content: trackerSystemPrompt() }];
  if (store) {
    try {
      const memories = await store.loadBotMemories("tracker");
      for (const row of memories) instructions.push({ kind: row.kind, content: row.content });
    } catch (err) {
      console.error("[bot-team] tracker memories failed — answering without them", err);
    }
    try {
      const queued = await store.listOpenHandoffs("tracker", 1);
      const first = queued[0];
      if (first) {
        const claimed = await store.claimHandoff(first.id, "tracker");
        if (claimed.status === "claimed" && claimed.claimed_by === "tracker") {
          const payload = claimed.payload as { objective?: unknown; then?: unknown };
          const objective = typeof payload.objective === "string" ? payload.objective : claimed.title;
          const then = typeof payload.then === "string" ? payload.then : "";
          instructions.push({
            kind: "handoff",
            content: `A teammate handed you work before this message: ${claimed.from_bot} needs ${objective}. ${then} Answer that work first, in this turn, then the owner's message.`,
          });
        }
      }
    } catch (err) {
      console.error("[bot-team] tracker handoff pickup failed — answering the message only", err);
    }
  }
  try {
    const reply = await deps.runChat({ userText: text, history: [], instructions });
    const answer = reply && reply.trim() !== "" ? reply.trim() : "I don't have an answer for that yet — say it another way?";
    if (store) {
      try {
        await store.recordSpend({
          botSlug: "tracker",
          model: modelForTier("scan"),
          tier: "scan",
          estimatedCents: estimateCallCostCents({ tier: "scan", inputChars: text.length, outputChars: answer.length }),
        });
      } catch (err) {
        console.error("[bot-team] spend record failed", err);
      }
    }
    await postTracker(chatId, answer, null, deps);
  } catch (err) {
    console.error("[bot-team] group Tracker turn failed", err);
    await postTracker(chatId, "that turn failed on my side — nothing was booked or sent. Try again in a moment.", null, deps);
  }
}

export type { BotSlug, ProposalRow };
export { GROUP_SEATS_PHASE_2 };
