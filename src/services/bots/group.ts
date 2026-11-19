// Telegram group mode for the bot team (Phase 0 baseline).
// One private group, him + the bots. Every bot hears every message;
// only the relevant one answers, the rest stay quiet.
//
// TEAM-ROOM SHAPE (Telegram mechanics, verified 2026-11-19 against
// Telegram's own docs — Bot API 9.6, core.telegram.org/api/bots/
// bot-to-bot): each bot has its OWN Telegram account + profile photo
// and messages as itself in the group (owner decision 2026-11-19 —
// the research report's one-face model was rejected). By DEFAULT
// bots cannot see each other's messages at all. With Bot-to-Bot
// Communication Mode enabled (in @BotFather, at least one of the two
// bots), a bot receives another bot's message when it carries a
// command mention addressed to it (/command@TargetBot) or is a direct
// reply to one of its messages; with the Mode on plus admin / Privacy
// OFF, it receives ALL bot messages. The earlier Bots FAQ line —
// "bots will not be able to see messages from other bots regardless
// of mode" — was the pre-9.6 default. So the group IS the shared
// channel: the server hears every owner message and routes it to one
// bot's logic, AND bots hand work to each other in the room with
// addressed handoff lines (services/bots/handoff.ts) that the Mode
// delivers — the server-side relay posts the same lines and runs the
// target bot's logic in-process until the Mode and the tokens exist.
// The owner sees the team-room behaviour (each bot posting as
// itself, named handoffs, bots working things out without pulling
// him in); the plumbing is individual accounts + shared state.
// What blocks full individual-face operation today: only Abel's bot
// token exists — each other bot's token is provisioned by the owner
// in BotFather (account + profile photo + TELEGRAM_<BOT>_BOT_TOKEN
// Fly secret) and its webhook registered; until then that bot falls
// back to the shared token with a "Name: " text label
// (services/bots/sending.ts). Setup the owner must do in BotFather
// for the group to work at all: Privacy Mode OFF for each bot (or
// make it a group admin) — with privacy mode ON the bot only
// receives addressed commands and replies, and plain owner messages
// like "my tire is flat" never reach this handler — PLUS Bot-to-Bot
// Communication Mode ON for each bot, or bots never hear each other
// however they are addressed. Re-add the bot to the group after
// changing the setting.
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
// - A message from another bot is answered only when it explicitly
//   addresses a seated bot: a handoff line (services/bots/handoff.ts),
//   a reply to that bot's message, or a name mention. Unaddressed
//   bot chatter is ignored — that is the loop guard, and it is also
//   Telegram-enforced by default: without Bot-to-Bot Communication
//   Mode the message never arrives here at all. Only Maintenance has
//   a bot-to-bot handler so far; a handoff to Abel or Scout is
//   visible in the room but nobody answers it yet.
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
import { parseHandoff } from "./handoff";
import { handleMaintenanceBotHandoff, handleMaintenanceGroupMessage, type MaintenanceGroupDeps } from "./maintenance";
import { resolveBotSender, slugForBotUsername } from "./sending";
import { sendTelegramMessage } from "@/services/telegram/bot-api";
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
  replyTo: { username: string | null; text: string | null } | null;
} {
  const message = update.message;
  const from = message?.from;
  const replyTo = message?.reply_to_message;
  return {
    id: typeof from?.id === "number" ? from.id : null,
    isBot: from?.is_bot === true,
    username: typeof from?.username === "string" ? from.username : null,
    text: typeof message?.text === "string" ? message.text : null,
    messageId: typeof message?.message_id === "number" ? message.message_id : null,
    // A bot handing work off replies to the message it answers, so
    // the receiving bot can see who it answers and what it says.
    replyTo: replyTo
      ? {
          username: typeof replyTo.from?.username === "string" ? replyTo.from.username : null,
          text: typeof replyTo.text === "string" ? replyTo.text : null,
        }
      : null,
  };
}

/** "yes", "no", "2 yes", "1 no" — the group decision grammar. */
function parseGroupDecision(text: string): { index: number; decision: "approved" | "denied" } | null {
  const match = text.trim().match(/^(?:(\d+)\s+)?(yes|no)\.?$/i);
  if (!match) return null;
  return { index: match[1] ? Number(match[1]) : 1, decision: match[2]!.toLowerCase() === "yes" ? "approved" : "denied" };
}

/**
 * The Maintenance deps, built once for both doors (owner messages
 * and bot handoffs): individual face — Maintenance posts from its own
 * token when TELEGRAM_MAINTENANCE_BOT_TOKEN is configured; until the
 * owner provisions that token in BotFather, it falls back to the
 * shared bot token with a "Maintenance: " text label, so nothing is
 * lost. sendAsAbel is the group handler's own sender (Abel's
 * account): Abel's handoff line posts as Abel, never as Maintenance.
 */
function maintenanceDeps(deps: GroupHandlerDeps, chatId: number, store: BotTeamStore | null): MaintenanceGroupDeps {
  const botSender = resolveBotSender("maintenance", deps.botToken);
  return {
    chatId,
    store,
    sendMessage: botSender.asSelf
      ? (targetChatId, text) => sendTelegramMessage(botSender.token, targetChatId, text)
      : deps.sendMessage,
    runChat: deps.runChat,
    speakAsSelf: botSender.asSelf,
    sendAsAbel: deps.sendMessage,
  };
}

/** Log a handled room message, best-effort: a logging failure never fails the reply. */
async function logRoomMessage(
  store: BotTeamStore | null,
  chat: { id: number; type: string },
  messageId: number | null,
  senderKind: "owner" | "bot",
  senderRef: string,
  text: string,
  routedToBotSlug: BotSlug | null,
): Promise<void> {
  if (!store || messageId === null) return;
  try {
    await store.ensureGroupRoom(chat.id);
    await store.recordGroupMessage({
      telegramChatId: chat.id,
      telegramMessageId: messageId,
      senderKind,
      senderRef,
      text: text.slice(0, 4000),
      routedToBotSlug,
    });
  } catch (err) {
    console.error("[bot-team] group message log failed", err);
  }
}

/**
 * The bot-sender door. A bot message is answered only when the sender
 * is a bot this team knows (username → slug from the configured
 * TELEGRAM_<BOT>_BOT_USERNAME values) AND it explicitly addresses a
 * seated bot:
 * - a handoff line (/handoff@TargetBot ...) → the target bot's
 *   handoff handler (only Maintenance has one so far);
 * - a reply to that bot's message, or a name mention → the target
 *   bot's normal group handler, with senderKind "bot".
 * Everything else — unknown bot, unaddressed chatter, a handoff to a
 * seat with no handler yet — is ignored silently, except a malformed
 * handoff attempt (starts like one, doesn't parse), which is audit-
 * logged: a handoff that never runs must never be silent.
 */
async function handleBotSenderUpdate(
  sender: ReturnType<typeof senderOf>,
  deps: GroupHandlerDeps,
  chat: { id: number; type: string },
): Promise<GroupHandleResult> {
  const store = deps.store;
  const senderSlug = slugForBotUsername(sender.username);
  // Unknown bot — the room has no third parties, bot or not.
  if (!senderSlug) return "ignored";
  const text = sender.text;
  if (text === null || text.trim() === "") return "ignored";

  const messageRef = sender.messageId !== null ? String(sender.messageId) : null;

  // A handoff line addressed to a seated bot: the Bot-to-Bot Mode
  // delivery form (command mention) or the server-side relay's copy
  // of it. The sender is the message's author — a handoff can never
  // claim to be from a bot it is not.
  const handoff = parseHandoff(text, senderSlug, (username) => slugForBotUsername(username));
  if (handoff) {
    if (handoff.to !== "maintenance") {
      // Only Maintenance has a bot-to-bot handler so far. A handoff
      // to Abel or Scout is visible in the room but nobody answers
      // it yet — their crews wire the handler on their side.
      return "ignored";
    }
    await logRoomMessage(store, chat, sender.messageId, "bot", senderSlug, text, "maintenance");
    await handleMaintenanceBotHandoff({
      handoff,
      replyText: sender.replyTo?.text ?? null,
      messageRef,
      deps: maintenanceDeps(deps, chat.id, store),
    });
    return "handled";
  }
  // A malformed handoff attempt (starts like one, doesn't parse) is
  // logged, never half-run and never silent.
  if (text.trim().startsWith("/handoff")) {
    if (store) {
      try {
        await store.logAudit({
          botSlug: "maintenance",
          actor: "bot",
          action: "handoff_malformed",
          detail: { from: senderSlug, text: text.slice(0, 200) },
        });
      } catch (err) {
        console.error("[bot-team] malformed handoff audit failed", err);
      }
    }
    return "ignored";
  }

  // A reply to one of Maintenance's messages, or a name mention: the
  // bot is talking to Maintenance directly. Work it as a group
  // message from that bot. (While Maintenance posts through the
  // shared token, a reply to its labeled message looks like a reply
  // to Abel — the handoff line above is the reliable addressing
  // until Maintenance's own token exists.)
  const replyToSlug = slugForBotUsername(sender.replyTo?.username);
  const route = routeGroupMessage({
    text,
    senderKind: "bot",
    senderSlug,
    replyToBotSlug: replyToSlug ?? undefined,
  });
  if (route.target !== "maintenance" || !route.seated) return "ignored";
  await logRoomMessage(store, chat, sender.messageId, "bot", senderSlug, text, "maintenance");
  await handleMaintenanceGroupMessage({
    text,
    route,
    channel: "group",
    senderKind: "bot",
    senderSlug,
    messageRef,
    deps: maintenanceDeps(deps, chat.id, store),
  });
  return "handled";
}

export async function handleBotTeamGroupUpdate(update: TelegramUpdate, deps: GroupHandlerDeps): Promise<GroupHandleResult> {
  const chat = groupChatOf(update);
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return "ignored";
  if (!deps.groupChatId) return "ignored";
  if (String(chat.id) !== deps.groupChatId) return "ignored";
  if (!deps.allowedChatId) return "disabled";

  const sender = senderOf(update);
  // A bot speaking in the room: only a bot this team knows, only
  // when it explicitly addresses a seated bot — unprompted bot
  // chatter is ignored, or the room would talk to itself.
  if (sender.isBot) {
    return handleBotSenderUpdate(sender, deps, chat);
  }
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

  // Maintenance (Phase 2 seat, 2026-11-19): the whole Maintenance
  // decision lives in services/bots/maintenance.ts — it speaks only
  // on clear routing (called by name, a reply to its message, or
  // Abel routing it), stays quiet on a keyword-only match and lets
  // Abel route, and works the message (defect intake, work-order
  // draft, call plan, or a model turn carrying the shared reasoning).
  // Bot senders take a different door (handleBotSenderUpdate below):
  // a handoff line addressed to Maintenance, or a reply / mention
  // from a known bot. That door builds the same deps through
  // maintenanceDeps, so the two paths can never drift apart.
  if (route.target === "maintenance") {
    await handleMaintenanceGroupMessage({
      text,
      route,
      channel: "group",
      // Idempotency key for Maintenance's workups: a redelivered
      // update replays the already-filed summary instead of a second
      // proposal (Telegram's send API has no idempotency key). The
      // key is the UPDATE's message id (sender.messageId, from
      // senderOf above) — never the BotSender, which carries no
      // message id: using it here once made every message share the
      // key "undefined" and filed the second defect as a redelivery
      // of the first.
      messageRef: sender.messageId !== null ? String(sender.messageId) : null,
      deps: maintenanceDeps(deps, chat.id, store),
    });
    return "handled";
  }

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

export type { BotSlug, ProposalRow };
export { GROUP_SEATS_PHASE_0 };
