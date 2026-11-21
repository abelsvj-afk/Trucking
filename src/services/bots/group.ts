// Telegram group mode for the bot team (Phase 0 baseline, Phase 2 seats).
// One private group, him + the bots — with EACH bot messaging as
// itself under its own Telegram account + profile photo (owner,
// 2026-11-19: INDIVIDUAL FACES; the one-face model was rejected).
// Bot-to-bot delivery (verified against Telegram's own docs,
// 2026-11-19/20): by DEFAULT bots never receive each other's
// messages (Bots FAQ) — but Telegram's Bot-to-Bot Communication
// Mode (@BotFather /setbot2bot) is the opt-in exception: command
// mentions and direct replies between bots are delivered when at
// least one bot of the pair has the mode on, and ordinary bot
// messages too when the receiving bot also has Group Privacy
// disabled (or is an admin). With those owner-side settings per
// account, the group really is the shared channel the owner
// ordered: a bot posts in the room addressed to a teammate, and
// the teammate's account receives it. Until the mode is enabled,
// the same coordination runs in-process (routedByBotSlug in
// router.ts, the supervisor-first handoff seam) and each bot still
// posts under its own name.
// One webhook invocation per bot face in the multi-face
// deployment: every bot's webhook calls this handler with its
// own faceBotSlug, and the deterministic router decides once —
// only the face the message routes to acts (the face gate in
// the handler). Owner decisions ("yes"/"no") are Abel's job, so
// only Abel's face handles them. Without a faceBotSlug (the
// single-bot deployment today) the handler acts on every
// routed message.
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
// This handler runs BEFORE the 1:1 path (services/telegram/dispatch-bot.ts), which still serves only the
// owner's private chat and still ignores every group. The webhook route sends group and supergroup
// updates here; everything else goes to the 1:1 path untouched.
//
// Fail-closed, like the 1:1 bot:
// - No TELEGRAM_GROUP_CHAT_ID configured = groups ignored, as today.
// - A message from anyone but the owner (TELEGRAM_ALLOWED_CHAT_ID)
//   is ignored silently. The room has no third parties.
// - A message from another bot is handled in two bounded ways:
//   if it is addressed to Billing (named by name, or a direct reply
//   to one of Billing's logged messages — Bot API 9.6 Bot-to-Bot
//   Communication Mode + Group Privacy OFF (or admin) is what
//   delivers it; see services/bots/faces.ts), Billing's turn runs
//   (claim-once; Billing's own messages are ignored — loop guard).
//   Otherwise it is logged to the room and may run ONLY the
//   Auditor's deterministic check on a clear route — it never
//   decides a proposal and never starts a model turn, so the
//   room cannot talk itself into a loop (see handleBotGroupMessage).
//   Bots coordinate in the room AND through the shared tables.
//   A handoff line addressed to a seated bot, or a reply/mention from a known bot to Maintenance,
//   runs Maintenance's own handlers (handleBotSenderUpdate graft): Maintenance is the one seat with
//   a bot-to-bot handoff handler so far; a malformed handoff attempt is audit-logged, never silent.
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
// recent group history + the bot's stored memories. Since the shared
// reasoning build (2026-11-19) they also carry Abel's full reasoning
// layer via services/bots/reasoning.ts — the same forms as his 1:1
// turn. They do NOT yet carry the live company snapshot the 1:1 path
// loads — a group answer never states a live figure it has not
// loaded. That snapshot is a Phase 1 gap, listed in the PR. Tracker's group answers have the same shape (its own system prompt + its stored memories + any handoff queued for it), and the same gap.

import { randomUUID } from "node:crypto";
import { auditLoadDraft, formatAuditReply, type LoadDraftInput } from "./auditor";
import { createBrowserRuntime, type BrowserRuntime } from "./browser-runtime";
import {
  buildWatchdogInstructions,
  checkLoadLegality,
  formatWatchdogSnapshot,
  recordHandoff,
  runWatchdogSweep,
  WATCHDOG_DISPLAY_NAME,
  WATCHDOG_SLUG,
} from "./compliance-watchdog";
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
import { billingRoomContribution, buildRoomHandoff, createBillingDataStore, handleBillingGroupTurn, type BillingDataStore } from "./billing";
import { botFaceUsername, parseRoomSpeaker } from "./faces";
import type { AiProvider } from "@/services/ai/provider";
import type { AgentTool } from "@/services/ai/agent-loop";
import { runTeamTurn, understandMessage, type HandOff, type RoomLine } from "./team-turn";
import { buildBotMemoryContext, buildBotSystemPrompt } from "./reasoning";
import { botIdentity, GROUP_SEATS, GROUP_SEATS_PHASE_0, isBotSlug, type BotSlug } from "./registry";
import { botChainDepth, evaluateBotPickup, identifyTeamBot, MAX_BOT_CHAIN_DEPTH } from "./bot-channel";
import { routeGroupMessage, unseatedReply, type GroupRoute } from "./router";
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
import { reserveModelSpend } from "./spend-guard";
import { parseHandoff } from "./handoff";
import { handleMaintenanceBotHandoff, handleMaintenanceGroupMessage, type MaintenanceGroupDeps } from "./maintenance";
import { resolveBotSender, slugForBotUsername } from "./sending";
import { sendTelegramMessage } from "@/services/telegram/bot-api";
import { type BotTeamStore, type ProposalRow } from "./store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";

export interface GroupHandlerDeps {
  botToken: string;
  /**
   * The team's AI (owner 2026-11-21, docs/design/bot-team-conversation.md): with it, the owner's
   * messages are UNDERSTOOD (any wording, typos) and answered by the right bot as a real agent turn
   * with its tools; without it (no key, tests) the keyword router and today's handlers run as before.
   */
  teamProvider?: AiProvider;
  /** Every read tool on the server; each bot gets the ones its registry scope allows. */
  teamReadTools?: AgentTool[];
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
   * Per-bot sending (individual faces, owner 2026-11-19): when the
   * named bot has its OWN Telegram token configured, send as that
   * bot — its own account and face, no name prefix — and return
   * true. Return false when the bot has no token of its own; the
   * caller falls back to sendMessage with the bot's name prefixed.
   * Absent entirely = every bot speaks through the shared token.
   */
  sendMessageAs?: (botSlug: BotSlug, chatId: number, text: string) => Promise<boolean>;
  /**
   * Per-bot face (owner, 2026-11-19: INDIVIDUAL FACES — each bot
   * its own Telegram account + profile photo, messaging as itself;
   * the one-face model was rejected). When the caller wires a bot's
   * own token, its messages post under that account; when absent,
   * everything falls back to sendMessage (the coordinator's face).
   * Bot-to-bot delivery exists only through Bot-to-Bot
   * Communication Mode (see the handler notes below); coordination
   * also runs through the shared tables (Supabase / in-process).
   */
  sendAsBot?: (botSlug: BotSlug, chatId: number, text: string) => Promise<number[]>;
  /**
   * A private message to the owner (his 1:1 chat). Used to SAY why the
   * group is silent instead of staying silent (owner 2026-11-19:
   * "DispatchBot isn't working in the group" — every group message was
   * being dropped without a word). Optional: tests and callers without
   * it simply don't report.
   */
  notifyOwner?: (text: string) => Promise<void>;
  /**
   * Sends as Dispatch Scout's OWN Telegram bot (his token), so his
   * replies carry his own name and photo in the group — the owner's
   * individual-faces rule. Absent = Scout's token is not configured
   * on the server; his sends then fall back to sendMessage (Abel's
   * account) and the "Dispatch Scout:" text prefix keeps the
   * attribution honest.
   */
  scoutSendMessage?: (chatId: number, text: string) => Promise<number[]>;
  /**
   * Abel's chat turn. Built lazily by the caller (the OpenAI provider
   * throws without a key); undefined = the group says AI is not
   * configured instead of failing.
   */
  runChat?: (input: {
    userText: string;
    history: { role: "user" | "assistant"; text: string }[];
    instructions: { kind: string; content: string }[];
    /**
     * The answering bot's shared-brain context (services/bots/
     * reasoning.ts): its system prompt — identity, tool scope, every
     * reasoning form — plus its own memory context. The caller maps
     * it into the chat turn's system prompt.
     */
    systemContext?: string;
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

export type GroupHandleResult = "handled" | "ignored" | "disabled" | "unconfigured";

/** One setup notice per group per half hour — enough to see it, never a flood. */
const SETUP_NOTICE_EVERY_MS = 30 * 60_000;
const lastSetupNoticeAt = new Map<string, number>();

async function setupNotice(deps: GroupHandlerDeps, key: string, text: string, nowMs: number): Promise<void> {
  if (!deps.notifyOwner) return;
  const last = lastSetupNoticeAt.get(key);
  if (last !== undefined && nowMs - last < SETUP_NOTICE_EVERY_MS) return;
  lastSetupNoticeAt.set(key, nowMs);
  try {
    await deps.notifyOwner(text);
  } catch (err) {
    console.error("[bot-team] setup notice failed", err);
  }
}

/** Test seam: forget the notice throttle. */
export function resetGroupSetupNotices(): void {
  lastSetupNoticeAt.clear();
}

export { isMissingTableError } from "./spend-guard";

/**
 * Send one bot's line to the room: as the bot itself when it has its
 * own Telegram token (deps.sendMessageAs), otherwise through the
 * shared token with the bot's display name prefixed — the interim
 * shape until every seat has its own account (faces, 2026-11-19).
 */
async function sendAsBot(
  deps: GroupHandlerDeps,
  slug: BotSlug,
  displayName: string,
  chatId: number,
  text: string,
): Promise<void> {
  if (deps.sendMessageAs) {
    try {
      if (await deps.sendMessageAs(slug, chatId, text)) return;
    } catch (err) {
      console.error(`[bot-team] send-as-${slug} failed — falling back to the shared token`, err);
    }
  }
  await deps.sendMessage(chatId, `${displayName}: ${text}`);
}

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
  /** Team bot this message replies to, when it replies to a bot. */
  replyToBotSlug: BotSlug | null;
  /** The replied-to message's author username + text (Maintenance's bot door reads both). */
  replyTo: { username: string | null; text: string | null } | null;
} {
  const message = update.message;
  const from = message?.from;
  const replyFrom = message?.reply_to_message?.from;
  return {
    id: typeof from?.id === "number" ? from.id : null,
    isBot: from?.is_bot === true,
    username: typeof from?.username === "string" ? from.username : null,
    text: typeof message?.text === "string" ? message.text : null,
    messageId: typeof message?.message_id === "number" ? message.message_id : null,
    replyToMessageId: typeof message?.reply_to_message?.message_id === "number" ? message.reply_to_message.message_id : null,
    replyToBotSlug:
      replyFrom?.is_bot === true ? identifyTeamBot(typeof replyFrom?.username === "string" ? replyFrom.username : null) : null,
    replyTo: replyFrom
      ? {
          username: typeof replyFrom.username === "string" ? replyFrom.username : null,
          text: typeof message?.reply_to_message?.text === "string" ? message.reply_to_message.text : null,
        }
      : null,
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
): Promise<"claimed" | "duplicate" | "unavailable"> {
  try {
    await store.ensureGroupRoom(input.telegramChatId);
    await store.recordGroupMessage(input);
    return "claimed";
  } catch (err) {
    if (isDuplicateKeyError(err)) return "duplicate";
    // BT-003: the claim is what stops every bot's webhook acting on the same message.
    // No claim = no side-effecting turn (fail closed), never "answer anyway".
    console.error("[bot-team] group message claim failed — not acting on it", err);
    return "unavailable";
  }
}

/** Said once when an owner message could not be claimed (BT-003). */
const CLAIM_UNAVAILABLE_TEXT =
  "Abel: I couldn't log that message, so I didn't act on it — nothing was booked, drafted or sent. Send it again in a moment.";

/** Scout speaks as himself when his own bot is wired; else via Abel's account. */
function sendAsScout(deps: GroupHandlerDeps, chatId: number, text: string): Promise<number[]> {
  return (deps.scoutSendMessage ?? deps.sendMessage)(chatId, text);
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
  if (!deps.allowedChatId) return "disabled";
  const store = deps.store;
  const sender = senderOf(update);
  // Who is speaking? The owner, or a team bot identified by its own
  // Telegram username (bots/bot-channel.ts — the group is the shared
  // channel, and bots pick up what is addressed to them there). The
  // room has no third parties: an unknown human and an unlisted bot
  // are both ignored.
  // Registry usernames first; the env-configured TELEGRAM_<BOT>_BOT_USERNAME
  // values (sending.ts) are the fallback — they are how each face's
  // account is configured in deployment, and Maintenance's bot door
  // was built on them.
  let fromBotSlug = sender.isBot ? (identifyTeamBot(sender.username) ?? slugForBotUsername(sender.username)) : null;
  if (!sender.isBot && (sender.id === null || String(sender.id) !== deps.allowedChatId)) return "ignored";
  const fromOwner = sender.id !== null && !sender.isBot && String(sender.id) === deps.allowedChatId;
  const nowMs = Date.now();

  // Telegram upgraded the group to a supergroup: it now has a NEW id, and
  // the configured one stops matching. Say so with the new id.
  const migrateTo = (update.message as { migrate_to_chat_id?: unknown } | undefined)?.migrate_to_chat_id;
  if (typeof migrateTo === "number") {
    await setupNotice(
      deps,
      `migrate:${chat.id}`,
      `Heads up: Telegram upgraded the bot group to a supergroup, which gives it a NEW chat id: ${migrateTo}. ` +
        `Until TELEGRAM_GROUP_CHAT_ID is set to ${migrateTo} on the server (a Fly secret — King can set it), the bots can't answer in the group.`,
      nowMs,
    );
    return "unconfigured";
  }

  // Not configured for this group: only the OWNER talking in it gets told
  // why (privately) - a stranger's group never triggers anything.
  if (!deps.groupChatId || String(chat.id) !== deps.groupChatId) {
    if (fromOwner) {
      await setupNotice(
        deps,
        `unconfigured:${chat.id}`,
        (deps.groupChatId
          ? `I saw your message in a group (chat id ${chat.id}), but the server is set up for a different group (${deps.groupChatId}), so I stayed quiet there.`
          : `I saw your message in a group (chat id ${chat.id}), but the server isn't set up for a bot group yet, so I stayed quiet there.`) +
          ` To turn the group on, set the Fly secret TELEGRAM_GROUP_CHAT_ID to ${chat.id} (King can do it), then send a message in the group again.` +
          ` Also turn OFF the bot's privacy mode, or it only hears messages that @mention it: in Telegram open @BotFather, choose /setprivacy,` +
          ` pick this bot, choose Disable — then remove the bot from the group and add it back.`,
        nowMs,
      );
      return "unconfigured";
    }
    return "ignored";
  }


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


  // Bot-to-bot in this room (mechanics verified against Telegram's
  // own docs, 2026-11-19/20): by DEFAULT bots never receive each
  // other's messages — the Bots FAQ states the default ("bots will
  // not be able to see messages from other bots regardless of
  // mode", and privacy-off/admin bots receive "all messages except
  // messages sent by other bots"). The opt-in exception is
  // Bot-to-Bot Communication Mode (@BotFather, /setbot2bot;
  // core.telegram.org/bots/features#bot-to-bot-communication):
  // with the mode on for at least one bot of a pair, a bot receives
  // another bot's group message when it is a command mention
  // addressed to it or a direct reply to its message; with the mode
  // on AND Group Privacy disabled (or admin rights), it also
  // receives the other bots' ordinary group messages. So a bot
  // message CAN reach this handler — through whichever team bot
  // account's webhook Telegram delivered it to — once the owner
  // enables the mode per account. What a bot message may do here
  // is bounded on purpose (Telegram's own warning: bot-message
  // handling must terminate): it is logged to the room, and it may
  // trigger ONLY the Auditor's deterministic check on a clear
  // route. It never decides a proposal, never starts a model turn,
  // and never chains — the Auditor's flags are terminal, and a
  // repeated check is absorbed by its idempotency key.
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
  // BT-006: the Telegram ACCOUNT decides who spoke. A "Name:" prefix counts only where the
  // account is a relay: no username at all (shared-account fallback), or Abel's coordinator
  // account speaking for a teammate that has no account of its own yet (owner 2026-11-20:
  // every bot gets its own account; until then its lines go out from Abel's, prefixed).
  // BT-005: a handoff to Billing is decided below, after the same dedup, claim and chain
  // cap as every other bot message - never in a branch of its own.
  let billingHandoff = false;
  if (sender.isBot) {
    const botText = sender.text;
    if (botText === null) return "ignored";
    const speaker = parseRoomSpeaker(botText);
    if (fromBotSlug === null) {
      // A bot WITH an account that is not a listed teammate: the room has no third parties.
      if (sender.username) return "ignored";
      // No username: a teammate through the shared webhook — prefix or not, it is logged.
      if (speaker === null) return handleBotGroupMessage(chat.id, sender, deps);
      fromBotSlug = speaker;
    } else if (fromBotSlug === "abel" && speaker !== null && speaker !== "abel" && botFaceUsername(speaker) === null) {
      fromBotSlug = speaker;
    }
    if (fromBotSlug !== "billing") {
      billingHandoff = /\bbilling\b/i.test(botText);
      if (!billingHandoff && sender.replyToMessageId !== null && store) {
        try {
          const repliedTo = await store.findGroupMessage(chat.id, sender.replyToMessageId);
          billingHandoff = repliedTo?.senderRef === "billing";
        } catch (err) {
          console.error("[bot-team] reply attribution failed", err);
        }
      }
    }
  }

  // The room has no third parties.
  if (!sender.isBot && (sender.id === null || String(sender.id) !== deps.allowedChatId)) return "ignored";

  const text = sender.text;

  // Bot-to-bot safeguards (Telegram's loop-prevention requirement):
  // a redelivered bot message is dropped by message id, and the
  // chain depth counts consecutive bot messages at the head of the
  // room log — a human post resets it. If the log cannot be read, a
  // bot message is answered nowhere: fail closed for bots, never
  // for the owner.
  let chainDepth = 0;
  if (fromBotSlug && !store) return "ignored"; // BT-003: no room log = no bot turn
  if (fromBotSlug && store && sender.messageId !== null) {
    try {
      const recent = await store.listRecentGroupMessages(25);
      if (recent.some((row) => row.sender_kind === "bot" && row.telegram_message_id === sender.messageId)) {
        return "ignored";
      }
      chainDepth = botChainDepth(recent);
    } catch (err) {
      console.error("[bot-team] bot-channel log check failed — not answering a bot message", err);
      return "ignored";
    }
    // BT-005: the chain cap applies to EVERY bot message here, before any bot door
    // (Billing's handoff, Maintenance's door, the shared flow): bots stop answering
    // bots at the cap until a human speaks.
    if (chainDepth >= MAX_BOT_CHAIN_DEPTH) return "handled";
  }

  if (text === null || text.trim() === "") {
    // Service messages (a bot added, the title changed, a pin) carry no text and are not the
    // owner talking: silent. A real photo / file / voice note gets one short line, once an hour.
    const m = update.message as { photo?: unknown; document?: unknown; voice?: unknown; video?: unknown; audio?: unknown } | undefined;
    const isMedia = Boolean(m && (m.photo || m.document || m.voice || m.video || m.audio));
    if (!fromBotSlug && isMedia && mediaNoticeDue(chat.id, Date.now())) {
      await deps.sendMessage(chat.id, "Abel: I can't open photos or files in here yet — send them to me 1:1 and I'll take care of them.");
    }
    return "handled";
  }

  // Claim a bot's message (BT-003): one claim across every bot's webhook; a claim that
  // can't be made means no bot turn. The owner's message is claimed later — after the
  // face gate, so in the multi-face deployment only the acting face claims it.
  if (fromBotSlug && sender.messageId !== null && store) {
    const claim = await claimRoomMessage(store, {
      telegramChatId: chat.id,
      telegramMessageId: sender.messageId,
      senderKind: "bot",
      senderRef: fromBotSlug,
      text: text.slice(0, 4000),
      routedToBotSlug: billingHandoff ? "billing" : null,
    });
    if (claim !== "claimed") return "ignored";
  }

  if (billingHandoff && fromBotSlug) {
    const billingRoute = { target: "billing" as const, via: "mention" as const, shouldAnswer: true, seated: true };
    const verdict = evaluateBotPickup({ senderSlug: fromBotSlug, route: billingRoute, chainDepth });
    if (!verdict.pickup) return "handled";
    const billingData = deps.billingData ?? (deps.companyId ? createBillingDataStore(deps.companyId) : null);
    const handoff = await buildRoomHandoff(fromBotSlug, text, billingData);
    await handleBillingGroupTurn(chat.id, text, billingRoute, { store, billingData, sendMessage, runChat: deps.runChat }, { fromBot: fromBotSlug, handoff });
    return "handled";
  }

  // Maintenance's bot door (its crew's handler, grafted): a handoff
  // line addressed to Maintenance, a malformed handoff attempt
  // (audit-logged, never silent), or a bot message routed to
  // Maintenance by reply/mention runs through handleBotSenderUpdate,
  // which logs and works it under Maintenance's own rules. Every
  // other bot message continues through the shared flow below.
  if (fromBotSlug) {
    const handoff = parseHandoff(text, fromBotSlug, (username) => slugForBotUsername(username));
    const doorRoute = routeGroupMessage({
      text,
      senderKind: "bot",
      senderSlug: fromBotSlug,
      replyToBotSlug: sender.replyToBotSlug ?? undefined,
    });
    if ((handoff && handoff.to === "maintenance") || text.trim().startsWith("/handoff") || (doorRoute.target === "maintenance" && doorRoute.seated)) {
      return handleBotSenderUpdate(sender, deps, chat);
    }
  }

  // A reply to a bot's message goes to that bot. senderOf reads the
  // replied-to sender from the update itself; when that is missing,
  // fall back to the group-message log (Tracker's lookup).
  let replyToBotSlug = sender.replyToBotSlug ?? undefined;
  if (!replyToBotSlug && sender.replyToMessageId !== null && store) {
    try {
      const senderRef = await store.getGroupMessageSender(chat.id, sender.replyToMessageId);
      if (senderRef === "tracker" || senderRef === "abel" || senderRef === "dispatch-scout") {
        replyToBotSlug = senderRef;
      }
    } catch (err) {
      console.error("[bot-team] reply-to lookup failed — routing by text instead", err);
    }
  }

  const route = routeGroupMessage({
    text,
    senderKind: fromBotSlug ? "bot" : "owner",
    senderSlug: fromBotSlug ?? undefined,
    replyToBotSlug,
  });

  // A bot's message is answered only when the bot-channel verdict
  // says pick it up: addressed to a seated bot, not the sender
  // itself, under the chain cap. Heard-and-logged is a complete
  // outcome for the rest — the room saw it; nobody needed to answer.
  if (fromBotSlug) {
    const verdict = evaluateBotPickup({ senderSlug: fromBotSlug, route, chainDepth });
    if (!verdict.pickup) return "handled";
  }

  // The face gate (multi-face deployment only; absent faceBotSlug
  // means the single-bot deployment, which acts on every message).
  // The router decides once, deterministically — only the face the
  // message routes to acts, so one message gets one answer however
  // many webhooks fired for it. Owner decisions are Abel's job, so
  // only Abel's face handles them.
  if (deps.faceBotSlug) {
    const gatedDecision = fromBotSlug ? null : parseGroupDecision(text);
    if (gatedDecision) {
      if (deps.faceBotSlug !== "abel") return "handled";
    } else if (route.target !== deps.faceBotSlug) {
      return "handled";
    }
  }

  // Claim the owner's message: with one webhook per bot face, the
  // same message is delivered to every webhook — the first claim
  // wins, the rest stand down, so the room answers once. A logging
  // failure that is NOT a duplicate still answers (today's
  // single-webhook behavior), loudly.
  // BT-003: duplicate = another webhook has it; unavailable (no store, or a non-duplicate
  // error) = nothing runs, and the owner is told once (by the acting face, or by Abel's
  // webhook in the single-gate deployment).
  if (text !== null && sender.messageId !== null && !fromBotSlug) {
    const claim = store
      ? await claimRoomMessage(store, {
          telegramChatId: chat.id,
          telegramMessageId: sender.messageId,
          senderKind: "owner",
          senderRef: String(sender.id),
          text: text.slice(0, 4000),
          routedToBotSlug: null,
        })
      : "unavailable";
    if (claim === "duplicate") return "ignored";
    if (claim === "unavailable") {
      const says = deps.faceBotSlug ? true : (deps.receivingBot ?? "abel") === "abel";
      if (says) await deps.sendMessage(chat.id, CLAIM_UNAVAILABLE_TEXT);
      return "ignored";
    }
  }

  // A decision ("yes" / "no" / "2 yes") answers the newest open
  // proposal — the same grammar as the 1:1 waiting list. Only the
  // owner decides: a bot's "yes" in the room is conversation, never
  // an approval.
  const decision = fromBotSlug ? null : parseGroupDecision(text);
  if (decision && store) {
    try {
      const open = await store.listOpenProposals(5);
      const target = open[decision.index - 1];
      if (!target) {
        // Nothing waiting: "yes" / "ok" is just conversation — let the team answer it. Without the
        // team's AI there is no one to converse, so say it like a person (never silence).
        if (deps.teamProvider) return handleOwnerTurn(chat.id, text, deps, sendMessage);
        await sendMessage(chat.id, "Abel: 👍 Nothing's waiting on an answer from you right now.");
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

  // The team understands the owner (any wording, any spelling) and the right bot answers.
  if (!fromBotSlug && deps.teamProvider) {
    return handleOwnerTurn(chat.id, text, deps, sendMessage);
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
  if (target === "dispatch-scout") {
    if (isScanRequest(text)) {
      await handleScoutScan(chat.id, text, deps);
      return "handled";
    }
    const looksLikeDispatch = /\b(pickup|delivery|rate|broker|load)\b/i.test(text) && /\d/.test(text);
    if (!looksLikeDispatch) {
      await sendAsScout(
        deps,
        chat.id,
        "Dispatch Scout: Where's the truck right now, and where do you want to head? I'll check the boards. Or forward me a dispatch and I'll look it over.",
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

  // Compliance Watchdog: its own turn, with the same spend-cap
  // discipline as Abel. Its job prompt, the ten shared reasoning
  // forms, the computed compliance snapshot, and its stored memories.
  if (route.target === "compliance-watchdog") {
    await handleWatchdogTurn(chat.id, text, deps);
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
  // Spend cap (audit F-023/F-024): fail closed, reserved atomically before the call.
  const spend = await reserveModelSpend(store, "abel", text.length);
  if (!spend.ok) {
    await deps.sendMessage(chat.id, `Abel: ${spend.message}`);
    return "handled";
  }
  try {
    const memories = store ? await store.loadBotMemories("abel") : [];
    // Shared brain (2026-11-19): Abel's group turn carries the same
    // full reasoning layer as his 1:1 turn — his system prompt from
    // the shared builder, plus his own memory context (watch-outs
    // from his corrections first). Standing rules travel as
    // instructions, the channel the chat prompt already honors on
    // every reply; the rest of his memory renders in the context
    // block, so nothing is assembled twice.
    const systemPrompt = buildBotSystemPrompt("abel");
    const memoryContext = buildBotMemoryContext(memories.filter((row) => row.kind !== "rule"));
    const instructions: { kind: string; content: string }[] = memories
      .filter((row) => row.kind === "rule")
      .map((row) => ({ kind: row.kind, content: row.content }));
    // A message deferred from the Auditor's seat arrives with a
    // routing hint, so Abel knows why he is seeing it.
    if (routingHint) instructions.push({ kind: "routing", content: routingHint });
    const reply = await deps.runChat({
      userText: text,
      history: [],
      instructions,
      systemContext: [systemPrompt, memoryContext].filter((part) => part && part.trim() !== "").join("\n\n"),
    });
    const answer = reply && reply.trim() !== "" ? reply.trim() : "I don't have an answer for that yet — say it another way?";
    await spend.settle(answer.length);
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
    await sendAsScout(deps, chatId, "Dispatch Scout: I can't scan boards yet — the shared browser isn't set up on the server. No board was read.");
    return;
  }
  const { origin, equipment } = parseScanRequest(text);
  if (!origin) {
    await sendAsScout(deps, chatId, "Dispatch Scout: Where's the truck right now? Give me a city or state and I'll check the boards.");
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
    await sendAsScout(
      deps,
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
  await sendAsScout(
    deps,
    chatId,
    `Dispatch Scout: scanning TruLOS first, then Trucker Path, then JustTracking — I'll post the shortlist here.${watch ? ` Watch the browser live: ${watch}` : ""}`,
  );
  const run = deps.scoutScan ?? runScoutScan;
  void run(
    { origin, costPerMileCents, floorPerAllMileCents, dieselCentsPerGallon, mpg, equipment, runId },
    { runtime, store },
  )
    .then(async (result) => {
      await sendAsScout(deps, chatId, result.summary);
    })
    .catch(async (error) => {
      console.error("[bot-team] scout scan failed", error);
      await sendAsScout(deps, chatId, "Dispatch Scout: The scan failed on my side — nothing was booked or sent. Ask me again in a minute.");
    });
}

/**
 * Compliance Watchdog turn. One model call, spend-capped like Abel's.
 * The snapshot is computed in code (deadline checklist, open defects,
 * duty segments) — summaries, never raw records. A snapshot that
 * fails to load is stated as missing in the instructions; the turn
 * never invents a deadline. No store = no spend-cap check = no model
 * call (audit F-023): the turn says why instead.
 */
async function handleWatchdogTurn(chatId: number, text: string, deps: GroupHandlerDeps): Promise<void> {
  const store = deps.store;
  if (!deps.runChat) {
    await sendAsBot(deps, WATCHDOG_SLUG, WATCHDOG_DISPLAY_NAME, chatId, "I can't answer that yet — the AI key isn't configured on the server. Nothing was sent anywhere.");
    return;
  }
  // Spend cap (audit F-023/F-024): fail closed, reserved atomically before the call.
  const spend = await reserveModelSpend(store, WATCHDOG_SLUG, text.length);
  if (!spend.ok) {
    await sendAsBot(deps, WATCHDOG_SLUG, WATCHDOG_DISPLAY_NAME, chatId, spend.message);
    return;
  }
  let snapshot: string | null = null;
  if (store) {
    try {
      const sweep = await runWatchdogSweep({ store });
      snapshot = formatWatchdogSnapshot(sweep);
    } catch (err) {
      console.error("[bot-team] watchdog snapshot failed — answering without it", err);
      snapshot = null;
    }
  }
  // Handoffs the team left for Watchdog (structured records behind
  // the in-room asks): summaries in the turn's instructions, newest
  // first. A failed read never fails the turn — it just answers
  // without them, like a missing snapshot.
  let handoffs: { fromBot: string; reason: string; ref: string | null; deadlineKind: string | null }[] = [];
  if (store) {
    try {
      const rows = await store.listHandoffsFor({
        to: WATCHDOG_SLUG,
        sinceIso: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        limit: 5,
      });
      handoffs = rows
        .map((row) => ({
          fromBot: row.bot_slug,
          reason: typeof row.detail?.reason === "string" ? row.detail.reason : "",
          ref: row.target_ref,
          deadlineKind: typeof row.detail?.deadlineKind === "string" ? row.detail.deadlineKind : null,
        }))
        .filter((h) => h.reason !== "");
    } catch (err) {
      console.error("[bot-team] watchdog handoff read failed — answering without them", err);
    }
  }
  try {
    const memories = store ? await store.loadBotMemories(WATCHDOG_SLUG) : [];
    const reply = await deps.runChat({
      userText: text,
      history: [],
      instructions: buildWatchdogInstructions({ memories, snapshotText: snapshot, handoffs }),
    });
    const answer = reply && reply.trim() !== "" ? reply.trim() : "I don't have an answer for that yet — say it another way?";
    await spend.settle(answer.length);
    await sendAsBot(deps, WATCHDOG_SLUG, WATCHDOG_DISPLAY_NAME, chatId, answer);
  } catch (err) {
    console.error("[bot-team] group Watchdog turn failed", err);
    await sendAsBot(deps, WATCHDOG_SLUG, WATCHDOG_DISPLAY_NAME, chatId, "that turn failed on my side — nothing was booked or sent. Try again in a moment.");
  }
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
    await sendAsScout(deps, chatId, "Dispatch Scout: I can't record a draft — the team database isn't configured on the server yet.");
    return;
  }
  // The draft lives in the app's proposal store (app-actions scope),
  // never written straight onto loads — the Scout's loads scope is
  // read-only by design.
  const gate = checkBotAction({ botSlug: "dispatch-scout", actionKind: "draft_load", group: "app-actions" });
  if (!gate.allowed) {
    await sendAsScout(deps, chatId, `Dispatch Scout: ${gate.reason}`);
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
    // Watchdog's own turn on a load being considered: the legality
    // check runs in code against the checklist and open defects. A
    // block is posted with the draft (and handed to Scout as a
    // structured audit record); a cannot-confirm is posted too. A
    // clear checklist posts nothing — Watchdog stays quiet when
    // there is nothing to flag. A failed check never fails the
    // draft post; the draft goes out without the verdict, loudly
    // logged.
    const watchdogLines: string[] = [];
    try {
      const sweep = await runWatchdogSweep({ store });
      const verdict = checkLoadLegality({ checklist: sweep.checklist, defects: sweep.defects, loadRef: title });
      if (verdict.verdict !== "clear") {
        watchdogLines.push("", verdict.summary);
        if (verdict.verdict === "blocked") {
          await recordHandoff({
            store,
            to: "dispatch-scout",
            reason: "load blocked by compliance — do not book until the owner decides",
            ref: proposal.id,
          });
        }
      }
    } catch (err) {
      console.error("[bot-team] watchdog legality check failed — draft posted without it", err);
    }
    const lines = [
      `Dispatch Scout — draft ready, waiting on your yes:`,
      title,
      audit.passed ? "Auditor: checks out." : `Auditor: ${audit.flags.map((f) => `${f.field} — ${f.detail}`).join(" ")}`,
      `Reply Yes to approve it, No to drop it.`,
      ...watchdogLines,
    ];
    await sendAsScout(deps, chatId, lines.join("\n"));
  } catch (err) {
    console.error("[bot-team] scout workup failed", err);
    await sendAsScout(deps, chatId, "Dispatch Scout: I couldn't save that draft — try forwarding it again in a moment.");
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
 * Team bot usernames (@BotFather handles) this handler can
 * attribute a bot message to. Only Dispatch Scout's is known
 * today (the owner created @DispatchScoutBot, 2026-11-19); a bot
 * whose username is not listed still gets picked up on a clear
 * Auditor mention — it just arrives unattributed. Never guess a
 * handle: an unlisted bot is a stranger's until the owner says
 * otherwise.
 */
const TEAM_BOT_USERNAMES: Record<string, BotSlug> = {
  dispatchscoutbot: "dispatch-scout",
};

/**
 * A message from another bot in the room (delivered by Telegram
 * once Bot-to-Bot Communication Mode is on — see the note at the
 * handler's entry). The group chat is the team's shared channel:
 * the message is logged to the room like any other, so it is part
 * of the record the owner reads and of Abel's later context. Then
 * exactly one thing may act on it: the Auditor, when the message
 * clearly routes to it (its name, or a known teammate handing it
 * the job). That check is deterministic and terminal — its flag
 * asks for evidence but starts no new bot turn from this update,
 * and the check key absorbs repeats. A bot message never decides
 * a proposal (only the owner's yes/no does), never starts Abel's
 * model turn (a bot cannot talk the coordinator into a loop), and
 * never runs a Scout workup. A bot never picks up its OWN message.
 */
async function handleBotGroupMessage(
  chatId: number,
  sender: { id: number | null; username: string | null; text: string | null; messageId: number | null },
  deps: GroupHandlerDeps,
): Promise<GroupHandleResult> {
  const text = sender.text;
  if (text === null || text.trim() === "") return "ignored";
  const store = deps.store;
  const senderSlug = sender.username ? TEAM_BOT_USERNAMES[sender.username.toLowerCase()] : undefined;
  if (store && sender.messageId !== null) {
    try {
      await store.ensureGroupRoom(chatId);
      await store.recordGroupMessage({
        telegramChatId: chatId,
        telegramMessageId: sender.messageId,
        senderKind: "bot",
        senderRef: sender.username ?? (sender.id !== null ? String(sender.id) : "unknown"),
        text: text.slice(0, 4000),
        routedToBotSlug: null,
      });
    } catch (err) {
      console.error("[bot-team] bot group message log failed", err);
    }
  }
  const route = routeGroupMessage({
    text,
    senderKind: "bot",
    ...(senderSlug ? { routedByBotSlug: senderSlug } : {}),
  });
  if (route.target === "auditor" && route.shouldAnswer && route.seated && senderSlug !== "auditor") {
    await handleAuditorCheck(chatId, text, deps);
  }
  return "handled";
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
    const errors = audit.flags.filter((flag) => flag.severity === "error");
    const unverifiable = audit.flags.filter((flag) => flag.severity === "unverifiable");
    await store.logAudit({
      botSlug: "auditor",
      actor: "bot",
      action: "auditor_check",
      targetRef: draft.id,
      detail: {
        kind: "proposal",
        check_key: checkKey,
        passed: audit.passed,
        flags: audit.flags.map((f) => f.field),
        addressed_to: draft.bot_slug,
        missing: unverifiable.map((f) => f.field),
      },
    });
    // Team room (owner, 2026-11-19): the verdict is spoken TO the
    // bot that made the draft, by name, in the room where the
    // owner reads it too. A flag names the gap on the author's own
    // work; a check that cannot finish ASKS the author for the
    // missing source instead of failing silently — the ask is part
    // of this one idempotent message, so a redelivery never nags
    // twice, and a re-check happens when the source lands as a new
    // draft or new numbers. A clean check is reported out loud in
    // one line — progress the room can see, not silence.
    const authorName = botIdentity(draft.bot_slug).displayName;
    let message: string;
    if (errors.length > 0) {
      message = `${authorName} — flag on your draft "${draft.title}": ${formatAuditReply(audit)}`;
    } else if (unverifiable.length > 0) {
      message =
        `${authorName} — I can't finish checking "${draft.title}" without: ` +
        `${unverifiable.map((flag) => `${flag.field} — ${flag.detail}`).join(" ")} ` +
        `Post the source and I'll re-run it.`;
    } else {
      message = `${authorName} — your draft "${draft.title}" checks out.`;
    }
    await sendAuditorMessage(chatId, message, deps);
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
  // The spend cap (audit F-023/F-024): fail-closed, reserved
  // atomically BEFORE the call, settled to the real estimate after.
  const spend = await reserveModelSpend(store, "tracker", text.length);
  if (!spend.ok) {
    await postTracker(chatId, spend.message, null, deps);
    return;
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
    await spend.settle(answer.length);
    await postTracker(chatId, answer, null, deps);
  } catch (err) {
    console.error("[bot-team] group Tracker turn failed", err);
    await postTracker(chatId, "that turn failed on my side — nothing was booked or sent. Try again in a moment.", null, deps);
  }
}
export type { BotSlug, ProposalRow };
export { GROUP_SEATS };


// ---- the team turn (owner 2026-11-21, docs/design/bot-team-conversation.md) -------------------------

const lastMediaNotice = new Map<number, number>();
const MEDIA_NOTICE_EVERY_MS = 60 * 60_000;
/** One "send it 1:1" line per hour per chat — never a line per photo. */
function mediaNoticeDue(chatId: number, nowMs: number): boolean {
  const last = lastMediaNotice.get(chatId);
  if (last !== undefined && nowMs - last < MEDIA_NOTICE_EVERY_MS) return false;
  lastMediaNotice.set(chatId, nowMs);
  return true;
}

/** The room conversation (oldest first) for the understanding step and every bot's turn. */
async function roomHistory(store: BotTeamStore | null, limit = 20): Promise<RoomLine[]> {
  if (!store) return [];
  try {
    const rows = await store.listRecentGroupMessages(limit);
    return [...rows].reverse().map((r) => ({
      who: r.sender_kind === "owner" ? "Sajacous (owner)" : (isBotSlug(r.sender_ref) ? botIdentity(r.sender_ref).displayName : r.sender_ref),
      text: (parseRoomSpeaker(r.text) ? r.text.replace(/^\s*[A-Za-z ]+:\s*/, "") : r.text).slice(0, 500),
    }));
  } catch (err) {
    console.error("[bot-team] room history read failed — answering without it", err);
    return [];
  }
}

/** Bots whose own handler carries domain logic; any other bot (including every future one) gets the generic team turn. */
const SPECIALISED = new Set<BotSlug>(["billing", "maintenance", "compliance-watchdog", "tracker", "auditor"]);
const MAX_HANDOFF_DEPTH = 2;

async function handleOwnerTurn(
  chatId: number,
  text: string,
  deps: GroupHandlerDeps,
  sendMessage: (chatId: number, text: string) => Promise<number[]>,
): Promise<GroupHandleResult> {
  const provider = deps.teamProvider;
  if (!provider) return "handled";
  const store = deps.store;
  const history = await roomHistory(store);
  const spend = await reserveModelSpend(store, "abel", text.length + 2_000);
  if (!spend.ok) {
    await sendMessage(chatId, `Abel: ${spend.message}`);
    return "handled";
  }
  const understood = await understandMessage(provider, { text, history });
  await spend.settle(400);
  // The model couldn't say: the keyword router decides, never a guess.
  const target: BotSlug = understood?.to ?? routeGroupMessage({ text, senderKind: "owner" }).target;
  await runBotTurn(target, chatId, text, understood?.ask, history, deps, sendMessage, 0);
  return "handled";
}

async function runBotTurn(
  slug: BotSlug,
  chatId: number,
  text: string,
  ask: string | undefined,
  history: RoomLine[],
  deps: GroupHandlerDeps,
  sendMessage: (chatId: number, text: string) => Promise<number[]>,
  depth: number,
): Promise<void> {
  const route: GroupRoute = { target: slug, via: depth === 0 ? "mention" : "bot-handoff", shouldAnswer: true, seated: true };
  if (SPECIALISED.has(slug)) {
    if (slug === "billing") {
      await handleBillingGroupTurn(chatId, text, route, { store: deps.store, billingData: deps.billingData ?? createBillingDataStore(deps.companyId), sendMessage, runChat: deps.runChat });
    } else if (slug === "maintenance") {
      await handleMaintenanceGroupMessage({ text, route, channel: "group", messageRef: null, deps: maintenanceDeps(deps, chatId, deps.store) });
    } else if (slug === "compliance-watchdog") {
      await handleWatchdogTurn(chatId, text, deps);
    } else if (slug === "tracker") {
      await handleTrackerTurn(chatId, text, null, deps);
    } else {
      await handleAuditorCheck(chatId, text, deps);
    }
    return;
  }
  const provider = deps.teamProvider!;
  const spend = await reserveModelSpend(deps.store, slug, text.length + 6_000);
  if (!spend.ok) {
    await sendMessage(chatId, `${botIdentity(slug).displayName}: ${spend.message}`);
    return;
  }
  const jobTools = slug === "dispatch-scout" ? scoutJobTools(chatId, deps, sendMessage) : [];
  let result: { reply: string; handoffs: HandOff[] };
  try {
    result = await runTeamTurn({ slug, provider, text, ask, history, readTools: deps.teamReadTools ?? [], jobTools });
  } catch (err) {
    console.error(`[bot-team] ${slug} turn failed`, err);
    result = { reply: "Something went wrong on my side — nothing was booked or sent. Try me again in a minute.", handoffs: [] };
  }
  await spend.settle(result.reply.length);
  const name = botIdentity(slug).displayName;
  // The "Name:" label only matters while a bot speaks through Abel's account; group-senders drops it
  // when the bot has its own account, so the owner never sees "Abel: Abel:".
  await sendMessage(chatId, `${name}: ${result.reply}`);
  if (depth >= MAX_HANDOFF_DEPTH) return;
  for (const h of result.handoffs) {
    const toName = botIdentity(h.to).displayName;
    await sendMessage(chatId, `${name}: ${toName}, ${h.ask}`);
    await runBotTurn(h.to, chatId, h.ask, h.ask, [...history, { who: name, text: `${toName}, ${h.ask}` }], deps, sendMessage, depth + 1);
  }
}

/** Scout's job tools: the board scan and the dispatch workup, called with what the owner said (any wording). */
function scoutJobTools(chatId: number, deps: GroupHandlerDeps, sendMessage: (chatId: number, text: string) => Promise<number[]>): AgentTool[] {
  return [
    {
      name: "scan_load_boards",
      description:
        "Scan the load boards for loads from where the truck is. origin = city and/or state he is in or leaving from (as he said it, e.g. 'Oklahoma City, OK' or 'Oklahoma'); " +
        "destination = where he wants to go, if he said; equipment if he said. The scan runs at human pace and posts its shortlist in the chat when done.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string" },
          destination: { type: "string" },
          equipment: { type: "string" },
        },
        required: ["origin"],
      },
      access: "read",
      async run(args) {
        const origin = typeof args.origin === "string" ? args.origin.trim() : "";
        if (!origin) return "Ask him where the truck is.";
        const destination = typeof args.destination === "string" && args.destination.trim() ? ` to ${args.destination.trim()}` : "";
        const equipment = typeof args.equipment === "string" && args.equipment.trim() ? ` ${args.equipment.trim()}` : "";
        await handleScoutScan(chatId, `scan from ${origin}${destination}${equipment}`, { ...deps, sendMessage });
        return `Scan started from ${origin}${destination}. Tell him you're on it; the shortlist posts when it's done.`;
      },
    },
    {
      name: "work_up_dispatch",
      description: "He forwarded or pasted a dispatch / load offer: price it against his costs and post a proposal for his yes. text = the dispatch as he sent it.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      access: "read",
      async run(args) {
        const body = typeof args.text === "string" ? args.text : "";
        if (!body.trim()) return "Ask him to paste the dispatch.";
        await handleScoutWorkup(chatId, body, { ...deps, sendMessage });
        return "Worked up and posted for his yes.";
      },
    },
  ];
}
