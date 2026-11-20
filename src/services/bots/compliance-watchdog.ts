// Compliance Watchdog — the safety bot (Phase 2; plan
// docs/bot-team-build-plan.md). Governing file:
// docs/bots/compliance-watchdog/CLAUDE.md. This bot is the solo
// version of a big fleet's Safety department — separate from
// Operations on purpose, so it can say no to a load.
//
// WHAT IT DOES
// - Tracks every deadline: medical card, CDL, MVR, Clearinghouse
//   queries, drug-test pool, UCR / IRP / MCS-150, annual inspection,
//   DVIR defects. Keeps the deadline checklist current.
// - Reads HOS / ELD (duty logs) and flags problems; never changes a log.
// - Posts red / amber alerts in the group chat, with the deadline and
//   what is missing. Says plainly before a load is booked if the
//   driver or truck is not legal to run it. The owner decides next.
//
// HARD LIMITS (enforced in code here, not just in the MD file)
// - Never edits an HOS log. Never clears a driver. Never waives a test.
// - Never files anything with FMCSA, an insurer, or any regulator.
// - Never decides a crash call, a post-accident test, a
//   reasonable-suspicion referral, or whether a driver or truck is out
//   of service. Those are human decisions; the owner carries the
//   legal liability. This bot flags; it never decides.
// - Never moves money or touches pay. No outbound calls, ever.
// - Never uses Abel's tools or the owner's login. Its own identity,
//   its own scoped tools (registry.ts), its own memory.
//
// TEAM-ROOM SHAPE (owner, 2026-11-19; verified against Telegram's own
// Bots FAQ, core.telegram.org/bots/faq — "bots will not be able to see
// messages from other bots regardless of mode"):
// The owner rejected the one-face model: each bot gets its own
// Telegram account + profile photo, messaging as itself in the group
// (INDIVIDUAL FACES, owner 2026-11-19). The Telegram mechanic that
// blocks the literal version of that — six bots chatting with each
// other in the group — is the Bot API itself: a bot NEVER receives
// another bot's messages, whatever the privacy setting, so the bots
// cannot hear each other, hand off, or bounce info back and forth
// through Telegram. (Narrow exceptions exist under Bot-to-Bot
// Communication Mode; they need verification + loop control and are
// a shared-backend decision, not a Watchdog one.) What works, and
// what this bot is built for: each bot posts as itself (its own
// account, name, photo) and the bots coordinate through the shared
// Supabase store (group messages, proposals, audit log) — the owner
// SEES the team talking in the room; the bots themselves read the
// shared store, not each other's Telegram messages. Handoffs between
// bots are structured records (audit rows / proposals carrying
// validated state only), never raw transcripts.
// TODAY the shared backend still posts through the single token
// (TELEGRAM_BOT_TOKEN, @AbelExecutiveBot) with a per-bot name prefix
// ("Compliance Watchdog: ..."). Per-bot tokens + webhook routing are
// a shared-backend step; this bot is written token-agnostic — its
// identity (slug, display name, memories, scoped tools) is its own,
// and its group lines go through the one send path the webhook binds,
// so binding a per-bot token there changes no Watchdog code.
//
// SPEAK RULE (group chat is a team room; owner correction 2026-11-19
// of the earlier too-strict routing rule): Watchdog speaks when the
// job is its own — called by name, replied to, a compliance question
// in the room, or its own turn (a deadline near, a flag going red, a
// block on a load being considered). It stays quiet when the message
// is another bot's job; the router decides that, not the bot. A safety
// flag is a statement, not a negotiation. In Watchdog's own 1:1 chat
// (not wired yet) it handles its own job directly, with no routing.
// The group handler still ignores Telegram updates sent by other bot
// accounts — with one bot face there are no other bot accounts in the
// room, and that guard is what keeps the room from talking to itself.
//
// PATTERNS BORROWED (open-source multi-agent research, 2026-11-19;
// RESEARCH BAKED IN NOW, owner 2026-11-19 — the six patterns are
// applied in this build, immediately. No framework adopted: Mastra is
// the first-pick evaluation with a recommendation in the PR, not a
// silent dependency here — adopting it mid-build would re-platform
// the shared backend all five bot crews are building on):
// - Supervisor-first: Abel coordinates; the router (a pure function)
//   decides who answers. Watchdog never routes itself.
// - Handoff payload = validated state only (kind, ref, dates, reason).
// - Shared state/summaries, not transcripts: the model turn gets a
//   compact computed snapshot, never the raw group transcript.
// - Server-side enforcement (registry scopes + guardrails + RLS), not
//   prompts. Human-in-the-loop as a structural proposal (24h expiry,
//   decide-once), not a prompt. Single-writer ownership per record.
// - Idempotency: alert posts carry a fingerprint; a re-run sweep
//   skips alerts already posted (amber) — a red alert is never
//   skipped on a lookup failure. Bounded loops: the sweep is one
//   pass; a group turn is one model call.
//
// This module is pure where it can be (evaluation, alerts, legality,
// speak gate, refusals) and thin where it must touch the store
// (reminders, filing, handoffs, sweep). Pure parts are unit-tested
// with no database and no network.

import { todayEastern } from "@/lib/eastern-date";
import { checkBotAction, type BotActionKind, type GuardrailVerdict } from "./guardrails";
import { buildSharedReasoningText } from "./reasoning";
import { toolScopeFor, type BotSlug, type ToolGroup } from "./registry";
import type { BotTeamStore } from "./store";

export const WATCHDOG_SLUG: BotSlug = "compliance-watchdog";
export const WATCHDOG_DISPLAY_NAME = "Compliance Watchdog";

/**
 * The Watchdog's standing instructions for a model turn. The ten
 * reasoning forms come from the shared engine (reasoning.ts) — the
 * same brain Abel has — and are appended by
 * buildWatchdogInstructions, never copied here.
 */
export const WATCHDOG_JOB_PROMPT = [
  "You are the Compliance Watchdog, the safety bot. You watch deadlines and rules so nothing expires quietly.",
  "Your job: track medical card, CDL, MVR, Clearinghouse queries, drug-test pool, UCR / IRP / MCS-150, annual inspection, DVIR defects. Read HOS / ELD and flag problems — never change a log. Post red / amber alerts with the deadline and what is missing. Keep the deadline checklist current. File documents; never approve them. Before a load is booked, say plainly if the driver or truck is not legal to run it — the owner decides what happens next.",
  "Speak in alerts, not lectures: what is due, when, and what is missing. Red means act now; amber means act soon. Never soften a block. If the truck or driver is not legal to run, say so plainly and say why. Missing paper is a flag, not 'probably fine.'",
  "You never decide for the owner. You lay out the rule and the risk, and he decides. You never decide a crash call, a post-accident test, a reasonable-suspicion referral, or whether a driver or truck is out of service — flag it for the owner and stop there.",
  "You never edit an HOS log, never clear a driver, never waive a test, never file anything with FMCSA, an insurer, or any regulator, never move money, never sign anything, never make a call. If asked to do any of those, refuse plainly and say who decides it instead.",
  "Your numbers and dates come only from the COMPLIANCE SNAPSHOT block. If the snapshot does not have a date, say you do not have it on file — never estimate a deadline. A checklist with nothing on file is itself a gap: say so.",
  "In the group chat you are one voice in a team room. Answer when the job is yours; hand work to the bot whose job it is when it is not (name the bot and the handoff, do not do their job yourself). A safety flag is a statement, not a negotiation.",
  "Keep every answer as short as the answer allows. Plain language first.",
].join("\n");

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export const COMPLIANCE_DEADLINE_KINDS = [
  "medical_card",
  "cdl",
  "mvr",
  "clearinghouse_query",
  "drug_test_pool",
  "ucr",
  "irp",
  "mcs_150",
  "annual_inspection",
  "dvir_defect",
] as const;

export type ComplianceDeadlineKind = (typeof COMPLIANCE_DEADLINE_KINDS)[number];

/** Every tracked kind, so a missing record is a visible gap, not a silent one. */
export const REQUIRED_DEADLINE_KINDS: readonly ComplianceDeadlineKind[] = COMPLIANCE_DEADLINE_KINDS;

const DEADLINE_LABELS: Record<ComplianceDeadlineKind, string> = {
  medical_card: "Medical card",
  cdl: "CDL",
  mvr: "MVR",
  clearinghouse_query: "Clearinghouse query",
  drug_test_pool: "Drug-test pool",
  ucr: "UCR",
  irp: "IRP",
  mcs_150: "MCS-150",
  annual_inspection: "Annual inspection",
  dvir_defect: "DVIR defect",
};

/** What happens if the deadline is missed — the alert says it plainly. */
const DEADLINE_CONSEQUENCES: Record<ComplianceDeadlineKind, string> = {
  medical_card: "the driver cannot legally drive without a current medical card",
  cdl: "the driver cannot legally drive without a current CDL",
  mvr: "the driving record is unverified — a violation could be missed",
  clearinghouse_query: "the annual Clearinghouse query is overdue — running without it risks a violation",
  drug_test_pool: "the drug-test pool is not current — a random test cannot be run",
  ucr: "the UCR filing is not current — the carrier is not legal to operate",
  irp: "the IRP registration is not current — the truck is not legal to run",
  mcs_150: "the MCS-150 is not current — the carrier record is out of date",
  annual_inspection: "the truck cannot legally run past its annual inspection",
  dvir_defect: "the defect is open — it needs a repair decision before the truck runs",
};

export function deadlineLabel(kind: ComplianceDeadlineKind): string {
  return DEADLINE_LABELS[kind];
}

/** Amber when due within this many days. Red is overdue, due today, or missing. */
export const AMBER_DAYS = 30;

export type DeadlineSeverity = "red" | "amber" | "ok" | "unknown";

export interface ComplianceDeadlineInput {
  kind: ComplianceDeadlineKind;
  /** Driver or truck the deadline belongs to, e.g. "driver" or "truck 1". */
  subjectRef?: string | null;
  /** Calendar date (YYYY-MM-DD). Null = no date on file. */
  dueDate?: string | null;
  /** 'filed' = a document is on file; 'missing' = known missing; 'unknown' = no record. */
  status?: "filed" | "missing" | "unknown";
  source?: string | null;
  notes?: string | null;
}

export interface EvaluatedDeadline {
  kind: ComplianceDeadlineKind;
  label: string;
  subjectRef: string | null;
  dueDate: string | null;
  status: "filed" | "missing" | "unknown";
  severity: DeadlineSeverity;
  /** Days until due; negative = overdue; null = no date on file. */
  daysUntil: number | null;
  /** One plain line: what is due, when, what is missing. */
  message: string;
}

/** Days from the owner's today to a YYYY-MM-DD date, by calendar day.
 * "Today" is the Eastern day (src/lib/eastern-date.ts) — never the UTC
 * day: after 7 PM Eastern the UTC date is already tomorrow, and a card
 * due "today" would read as expired. The difference itself is calendar
 * math on date strings (UTC-midnight parses), which is exact. */
export function daysUntilDate(dueDate: string, now: Date = new Date()): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const today = Date.parse(`${todayEastern(now)}T00:00:00Z`);
  return Math.round((due - today) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-16" -> "Nov 16, 2026". Dates are calendar dates, never UTC stamps. */
export function formatDueDate(dueDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  if (!match) return dueDate;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

export function evaluateDeadline(input: ComplianceDeadlineInput, now: Date = new Date()): EvaluatedDeadline {
  const label = deadlineLabel(input.kind);
  const status = input.status ?? (input.dueDate ? "filed" : "unknown");
  const dueDate = input.dueDate ?? null;
  const daysUntil = dueDate ? daysUntilDate(dueDate, now) : null;

  let severity: DeadlineSeverity;
  let message: string;
  if (status === "missing") {
    severity = "red";
    message = `No ${label.toLowerCase()} on file — file it or confirm the date.`;
  } else if (dueDate === null || daysUntil === null) {
    severity = "unknown";
    message = `No due date on file for ${label.toLowerCase()} — file it or confirm the date.`;
  } else if (daysUntil < 0) {
    severity = "red";
    message = `${label} expired ${-daysUntil} day${-daysUntil === 1 ? "" : "s"} ago (was due ${formatDueDate(dueDate)}).`;
  } else if (daysUntil === 0) {
    severity = "red";
    message = `${label} is due today (${formatDueDate(dueDate)}).`;
  } else if (daysUntil <= AMBER_DAYS) {
    severity = "amber";
    message = `${label} due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${formatDueDate(dueDate)}).`;
  } else {
    severity = "ok";
    message = `${label} current until ${formatDueDate(dueDate)} (${daysUntil} days).`;
  }
  return { kind: input.kind, label, subjectRef: input.subjectRef ?? null, dueDate, status, severity, daysUntil, message };
}

export interface EvaluatedChecklist {
  evaluated: EvaluatedDeadline[];
  reds: EvaluatedDeadline[];
  ambers: EvaluatedDeadline[];
  oks: EvaluatedDeadline[];
  unknowns: EvaluatedDeadline[];
}

/**
 * Evaluate the whole checklist. Kinds with no row at all are evaluated
 * as missing (red) — a kind nobody filed is a gap, not a pass.
 */
export function evaluateChecklist(rows: ComplianceDeadlineInput[], now: Date = new Date()): EvaluatedChecklist {
  const byKind = new Map<ComplianceDeadlineKind, ComplianceDeadlineInput>();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, row);
  }
  const evaluated = REQUIRED_DEADLINE_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return evaluateDeadline(row ?? { kind, status: "missing" }, now);
  });
  return {
    evaluated,
    reds: evaluated.filter((d) => d.severity === "red"),
    ambers: evaluated.filter((d) => d.severity === "amber"),
    oks: evaluated.filter((d) => d.severity === "ok"),
    unknowns: evaluated.filter((d) => d.severity === "unknown"),
  };
}

/** One alert line: "RED — Medical card: expired 3 days ago... If missed, ...". */
export function formatComplianceAlert(deadline: EvaluatedDeadline): string {
  const level = deadline.severity === "red" ? "RED" : deadline.severity === "amber" ? "AMBER" : "OK";
  const subject = deadline.subjectRef ? ` (${deadline.subjectRef})` : "";
  const consequence =
    deadline.severity === "red" || deadline.severity === "amber"
      ? ` If missed, ${DEADLINE_CONSEQUENCES[deadline.kind]}.`
      : "";
  return `${level} — ${deadline.label}${subject}: ${deadline.message}${consequence}`;
}

/** Compact snapshot text for a model turn — summaries, never raw records. */
export function formatChecklistSnapshot(checklist: EvaluatedChecklist, now: Date = new Date()): string {
  const lines = [`COMPLIANCE SNAPSHOT (as of ${todayEastern(now)}):`];
  for (const d of checklist.evaluated) {
    lines.push(`- ${d.severity.toUpperCase()}: ${d.message}`);
  }
  if (checklist.reds.length === 0 && checklist.ambers.length === 0 && checklist.unknowns.length === 0) {
    lines.push("No red or amber deadlines. The checklist is current.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HOS (read only) and DVIR defects
// ---------------------------------------------------------------------------

export interface DutySegment {
  dutyStatus: "off_duty" | "sleeper" | "driving" | "on_duty";
  startedAt: string;
  location?: string | null;
}

export interface HosFlag {
  severity: "red" | "amber";
  message: string;
}

/**
 * The HOS snapshot for a model turn: the last duty segments as facts.
 * This module never computes an HOS violation from raw segments —
 * that is the HOS engine's job, and this bot is not the engine. It
 * flags only what code can see honestly: missing coverage.
 */
export function buildHosSnapshotText(segments: DutySegment[]): string {
  if (segments.length === 0) {
    return "HOS: no duty logs on file — hours cannot be verified from records.";
  }
  const lines = ["HOS — last duty segments (the paper-log helper, not an ELD):"];
  for (const segment of segments.slice(0, 6)) {
    const when = segment.startedAt.replace("T", " ").slice(0, 16);
    lines.push(`- ${segment.dutyStatus} since ${when}${segment.location ? ` (${segment.location})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Missing coverage is the one HOS flag code can make: no duty log in
 * the last `maxGapHours` hours means the log is incomplete and hours
 * cannot be verified. It is a flag, not a violation finding.
 */
export function flagMissingDutyCoverage(segments: DutySegment[], now: Date = new Date(), maxGapHours = 24): HosFlag | null {
  if (segments.length === 0) {
    return { severity: "red", message: "No duty logs on file at all — hours cannot be verified. Log the current duty status." };
  }
  const latest = segments.reduce((a, b) => (Date.parse(a.startedAt) > Date.parse(b.startedAt) ? a : b));
  const gapHours = (now.getTime() - Date.parse(latest.startedAt)) / 3_600_000;
  if (gapHours > maxGapHours) {
    return {
      severity: "amber",
      message: `No duty log in the last ${Math.floor(gapHours)} hours (last: ${latest.dutyStatus} ${latest.startedAt.slice(0, 10)}) — the log is incomplete; hours cannot be verified until it is caught up.`,
    };
  }
  return null;
}

export interface OpenDefect {
  id: string;
  description: string;
  source: string;
  createdAt: string;
}

/** Every open defect is red: it needs a repair decision before the truck runs. */
export function formatDefectAlert(defect: OpenDefect): string {
  return `RED — Open DVIR defect (${defect.source}, ${defect.createdAt.slice(0, 10)}): ${defect.description} If missed, ${DEADLINE_CONSEQUENCES.dvir_defect}.`;
}

// ---------------------------------------------------------------------------
// Load legality — the plain answer before a load is booked
// ---------------------------------------------------------------------------

export type LoadLegality = "clear" | "cannot-confirm" | "blocked";

export interface LoadLegalityVerdict {
  verdict: LoadLegality;
  /** Date-proven reds: the load must not be booked on this evidence. */
  blocks: string[];
  /** Gaps that stop Watchdog confirming legality (not proof of illegality). */
  unverified: string[];
  summary: string;
}

/**
 * The verdict before a load is booked. Only date-proven reds block.
 * A missing record or an open defect does NOT prove the truck is
 * illegal — it means Watchdog cannot confirm it is legal, and the
 * decision stays human. An out-of-service call is never made here.
 */
export function checkLoadLegality(input: {
  checklist: EvaluatedChecklist;
  defects: OpenDefect[];
  loadRef?: string | null;
}): LoadLegalityVerdict {
  const blocks: string[] = [];
  const unverified: string[] = [];

  for (const red of input.checklist.reds) {
    if (red.status === "missing") {
      unverified.push(`No ${red.label.toLowerCase()} on file.`);
    } else if (red.daysUntil !== null && red.daysUntil <= 0) {
      blocks.push(red.message);
    } else {
      unverified.push(red.message);
    }
  }
  for (const unknown of input.checklist.unknowns) {
    unverified.push(unknown.message);
  }
  for (const defect of input.defects) {
    unverified.push(`Open DVIR defect (${defect.source}): ${defect.description} — needs a repair decision.`);
  }

  const loadRef = input.loadRef ? ` for ${input.loadRef}` : "";
  let verdict: LoadLegality;
  let summary: string;
  if (blocks.length > 0) {
    verdict = "blocked";
    summary =
      `BLOCK — the driver or truck is not legal to run this load${loadRef}: ${blocks.join(" ")} ` +
      `The owner decides what happens next; Watchdog does not clear this.`;
  } else if (unverified.length > 0) {
    verdict = "cannot-confirm";
    summary =
      `Compliance Watchdog cannot confirm this load${loadRef} is legal to run: ${unverified.join(" ")} ` +
      `File the missing paper or get the repair decision, then ask again.`;
  } else {
    verdict = "clear";
    summary = `Compliance Watchdog: no blocks on file for this load${loadRef} — deadlines current, no open defects.`;
  }
  return { verdict, blocks, unverified, summary };
}

// ---------------------------------------------------------------------------
// Speak gate — when Watchdog talks in the team room, and when it stays quiet
// ---------------------------------------------------------------------------

/** Called by name: "watchdog", "compliance", "safety". */
export const WATCHDOG_MENTION_PATTERNS: RegExp[] = [/\bwatchdog\b/i, /\bcompliance\b/i, /\bsafety\b/i];

/**
 * Its job, in words. Strong patterns are unmistakably compliance
 * (medical card, CDL, drug test, Clearinghouse, a deadline, an
 * annual inspection, a DVIR defect, UCR / IRP / MCS-150, "legal to
 * run"). The HOS words (hours, duty, log, rest, sleeper) are its job
 * too — an hours question is an HOS question. When a word is genuinely
 * another bot's job in context ("what are the receiver's hours?"),
 * the turn hands it off in words to that bot instead of answering
 * outside its job.
 */
export const WATCHDOG_KEYWORD_PATTERNS: RegExp[] = [
  /\bmedical card\b/i,
  /\bmedical\b/i,
  /\bcdl\b/i,
  /\bdrug test\b/i,
  /\bclearinghouse\b/i,
  /\bmvr\b/i,
  /\bdeadline\b/i,
  /\bannual inspection\b/i,
  /\bdvir\b/i,
  /\bucr\b/i,
  /\birp\b/i,
  /\bmcs-150\b/i,
  /\blegal to run\b/i,
  /\bcan (i|we|he) run\b/i,
  /\bout of service\b/i,
  /\bsafety audit\b/i,
  /\bnew entrant\b/i,
  /\bhos\b/i,
  /\bhours\b/i,
  /\bduty\b/i,
  /\blog\b/i,
  /\brest\b/i,
  /\bsleeper\b/i,
];

export type SpeakVia = "reply" | "mention" | "keyword" | "default";

/**
 * The speak decision. Reply or mention = called by name, speak.
 * Keyword = the job is its own, speak. Default (no route to it) =
 * quiet — the message is another bot's job or Abel's, and the router
 * sends it there. This is the team-room rule, not a gag: Watchdog
 * speaks whenever the job is its own, and its own turn (a deadline
 * near, a flag red, a block on a load) speaks without being asked.
 */
export function shouldWatchdogSpeak(input: { text: string; via: SpeakVia }): boolean {
  if (input.via === "reply" || input.via === "mention") return true;
  if (input.via === "keyword") return WATCHDOG_KEYWORD_PATTERNS.some((pattern) => pattern.test(input.text));
  return false;
}

// ---------------------------------------------------------------------------
// Hard refusals, reminders, filing, handoffs
// ---------------------------------------------------------------------------

/**
 * The never-list, enforced even with an approved proposal. A proposal
 * does not make Watchdog do these — the governing file forbids them
 * outright, and the owner carries the legal liability for them.
 */
export const WATCHDOG_NEVER_ACTIONS = [
  "change_hos_log",
  "file_document",
  "call_outbound",
  "sign_document",
  "move_money",
  "pay",
  "delete_record",
  "change_permissions",
  "send_to_broker",
  "send_to_shipper",
] as const;

export type WatchdogNeverAction = (typeof WATCHDOG_NEVER_ACTIONS)[number];

const NEVER_REASONS: Record<WatchdogNeverAction, string> = {
  change_hos_log: "I never edit an HOS log — a log change is the owner's call, through the app's edit flow.",
  file_document: "I never file anything with FMCSA, an insurer, or any regulator — filing is the owner's decision, outside this bot.",
  call_outbound: "I never make calls — alerts only, in the group chat and the app.",
  sign_document: "I never sign anything.",
  move_money: "I never move money or touch pay.",
  pay: "I never move money or touch pay.",
  delete_record: "I never delete a record — deletions are the owner's, permanently gated.",
  change_permissions: "I never change permissions.",
  send_to_broker: "I never message a broker — that is Dispatch Scout's job, proposed first.",
  send_to_shipper: "I never message a shipper or receiver — that is Tracker's job, proposed first.",
};

/** Always denied, proposal or not. */
export function refuseWatchdogAction(actionKind: string): GuardrailVerdict {
  if ((WATCHDOG_NEVER_ACTIONS as readonly string[]).includes(actionKind)) {
    const reason = NEVER_REASONS[actionKind as WatchdogNeverAction];
    return { allowed: false, reason: `Compliance Watchdog never does that. ${reason}` };
  }
  return { allowed: true };
}

/**
 * The full gate for a Watchdog action: the never-list first, then the
 * shared propose-only guardrails.
 */
export function checkWatchdogAction(input: {
  actionKind: BotActionKind;
  group: ToolGroup;
  hasApprovedProposal?: boolean;
}): GuardrailVerdict {
  const never = refuseWatchdogAction(input.actionKind);
  if (!never.allowed) return never;
  return checkBotAction({ botSlug: WATCHDOG_SLUG, actionKind: input.actionKind, group: input.group, hasApprovedProposal: input.hasApprovedProposal });
}

/** Reminders go to the driver or the owner only — never to FMCSA, an insurer, or any regulator. */
export const REMINDER_RECIPIENTS = ["owner", "driver"] as const;
export type ReminderRecipient = (typeof REMINDER_RECIPIENTS)[number];

export interface ReminderResult {
  ok: boolean;
  reason?: string;
  proposalId?: string;
}

/**
 * Propose a reminder about a deadline. Draft only: the reminder is a
 * message-draft proposal the owner approves; sending is an
 * execute-class action and stays proposal-gated (Phase 0 has no
 * execution path — the approval is recorded, nothing is sent).
 */
export async function proposeReminder(input: {
  store: BotTeamStore;
  recipient: string;
  deadline: EvaluatedDeadline;
}): Promise<ReminderResult> {
  if (!(REMINDER_RECIPIENTS as readonly string[]).includes(input.recipient)) {
    return {
      ok: false,
      reason: `Compliance Watchdog sends reminders to the driver or the owner only — never to "${input.recipient}".`,
    };
  }
  const gate = checkWatchdogAction({ actionKind: "draft_message", group: "email" });
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  const title = `Reminder (${input.recipient}): ${input.deadline.label} — ${input.deadline.message}`;
  const proposal = await input.store.createProposal({
    botSlug: WATCHDOG_SLUG,
    kind: "message-draft",
    title,
    payload: {
      recipient: input.recipient,
      kind: input.deadline.kind,
      dueDate: input.deadline.dueDate,
      severity: input.deadline.severity,
      text: formatComplianceAlert(input.deadline),
    },
    sourceRef: "compliance-watchdog-reminder",
  });
  await input.store.logAudit({
    botSlug: WATCHDOG_SLUG,
    actor: "bot",
    action: "proposal_created",
    targetRef: proposal.id,
    detail: { kind: "message-draft", recipient: input.recipient, deadlineKind: input.deadline.kind },
  });
  return { ok: true, proposalId: proposal.id };
}

/**
 * File a document copy — an internal, reversible write. This is NOT
 * "file_document" (filing with a regulator, always refused): it
 * records the filed copy's deadline row (kind, due date, source) and
 * an audit row, so the checklist stays current. It never approves
 * the document — approval has no code path here at all.
 */
export async function fileDocumentCopy(input: {
  store: BotTeamStore;
  deadline: ComplianceDeadlineInput;
}): Promise<{ ok: boolean; reason?: string }> {
  if (toolScopeFor(WATCHDOG_SLUG, "documents") !== "read-write") {
    return { ok: false, reason: "Compliance Watchdog may not file documents — its documents scope is not read-write." };
  }
  await input.store.upsertComplianceDeadline({
    kind: input.deadline.kind,
    subjectRef: input.deadline.subjectRef ?? null,
    dueDate: input.deadline.dueDate ?? null,
    status: "filed",
    source: input.deadline.source ?? "filed-copy",
    notes: input.deadline.notes ?? null,
  });
  await input.store.logAudit({
    botSlug: WATCHDOG_SLUG,
    actor: "bot",
    action: "document_filed",
    targetRef: input.deadline.kind,
    detail: { kind: input.deadline.kind, dueDate: input.deadline.dueDate ?? null },
  });
  return { ok: true };
}

/**
 * Hand work to another bot — a structured record, not a chat message.
 * The payload is validated state only (kind, ref, reason, deadline),
 * never a transcript. The receiving bot reads it from the audit log;
 * the group post names the handoff so the owner sees it happen.
 * Targets are the other team seats; a handoff to a bot that is not
 * built yet is still recorded — the record waits for its reader.
 */
export async function recordHandoff(input: {
  store: BotTeamStore;
  to: BotSlug;
  reason: string;
  ref?: string | null;
  deadlineKind?: ComplianceDeadlineKind | null;
}): Promise<void> {
  await input.store.logAudit({
    botSlug: WATCHDOG_SLUG,
    actor: "bot",
    action: "handoff",
    targetRef: input.ref ?? null,
    detail: { to: input.to, reason: input.reason, deadlineKind: input.deadlineKind ?? null },
  });
}

// ---------------------------------------------------------------------------
// Model-turn instructions + the sweep
// ---------------------------------------------------------------------------

export interface WatchdogMemory {
  kind: string;
  content: string;
}

/**
 * The instruction blocks for a Watchdog model turn: its job, the ten
 * shared reasoning forms (the same brain Abel has), the computed
 * compliance snapshot, and its stored memories. The snapshot is
 * summaries, never raw records — and a missing snapshot is stated as
 * missing, never papered over.
 */
export function buildWatchdogInstructions(input: {
  memories: WatchdogMemory[];
  snapshotText: string | null;
}): { kind: string; content: string }[] {
  const blocks: { kind: string; content: string }[] = [
    { kind: "instruction", content: WATCHDOG_JOB_PROMPT },
    { kind: "instruction", content: buildSharedReasoningText() },
  ];
  blocks.push({
    kind: "instruction",
    content:
      input.snapshotText ??
      "COMPLIANCE SNAPSHOT: unavailable — the checklist is not loaded. Say so plainly, and never state a deadline you have not been given.",
  });
  for (const memory of input.memories) {
    blocks.push({ kind: memory.kind, content: memory.content });
  }
  return blocks;
}

export interface WatchdogSweepResult {
  checklist: EvaluatedChecklist;
  defects: OpenDefect[];
  segments: DutySegment[];
  hosFlag: HosFlag | null;
  /** Red and amber alert lines, in checklist order, defects last. */
  alerts: string[];
  counts: { red: number; amber: number; ok: number; unknown: number; defects: number };
  summary: string;
}

/** The full snapshot for a model turn: checklist + defects + HOS, as summaries. */
export function formatWatchdogSnapshot(sweep: WatchdogSweepResult, now: Date = new Date()): string {
  const parts = [formatChecklistSnapshot(sweep.checklist, now)];
  if (sweep.defects.length > 0) {
    parts.push(`OPEN DVIR DEFECTS (${sweep.defects.length}):\n` + sweep.defects.map((d) => `- ${d.description} (${d.source}, ${d.createdAt.slice(0, 10)})`).join("\n"));
  } else {
    parts.push("OPEN DVIR DEFECTS: none on file.");
  }
  parts.push(buildHosSnapshotText(sweep.segments));
  if (sweep.hosFlag) parts.push(`${sweep.hosFlag.severity === "red" ? "RED" : "AMBER"} — HOS: ${sweep.hosFlag.message}`);
  return parts.join("\n\n");
}

function alertFingerprint(alert: { kind: string; subjectRef: string | null; severity: string; dueDate: string | null }): string {
  return [alert.kind, alert.subjectRef ?? "", alert.severity, alert.dueDate ?? ""].join("|");
}

/**
 * A deadline row from the store, as a checklist input. Rows whose
 * kind is not one of the ten tracked kinds are skipped — the table's
 * check constraint should prevent them, but a bad row must never
 * crash the sweep or invent a deadline.
 */
function toDeadlineInput(row: {
  kind: string;
  subject_ref: string | null;
  due_date: string | null;
  status: "filed" | "missing" | "unknown";
  source: string | null;
  notes: string | null;
}): ComplianceDeadlineInput | null {
  if (!(COMPLIANCE_DEADLINE_KINDS as readonly string[]).includes(row.kind)) return null;
  return {
    kind: row.kind as ComplianceDeadlineKind,
    subjectRef: row.subject_ref,
    dueDate: row.due_date,
    status: row.status,
    source: row.source,
    notes: row.notes,
  };
}

/**
 * One sweep pass: load the checklist, open defects, and recent duty
 * logs; evaluate; return the alerts. Posting is the caller's job.
 * The sweep itself never writes to the app — it only reads — except
 * the audit rows the caller writes for posted alerts.
 */
export async function runWatchdogSweep(input: { store: BotTeamStore; now?: Date }): Promise<WatchdogSweepResult> {
  const now = input.now ?? new Date();
  const [deadlineRows, defectRows, segmentRows] = await Promise.all([
    input.store.listComplianceDeadlines(),
    input.store.listOpenDefects(),
    input.store.listRecentDutySegments(10),
  ]);
  const deadlines = deadlineRows.map(toDeadlineInput).filter((d): d is ComplianceDeadlineInput => d !== null);
  const defects: OpenDefect[] = defectRows.map((d) => ({ id: d.id, description: d.description, source: d.source, createdAt: d.created_at }));
  const checklist = evaluateChecklist(deadlines, now);
  const segments = segmentRows.map((s) => ({ dutyStatus: s.duty_status, startedAt: s.started_at, location: s.location }));
  const hosFlag = flagMissingDutyCoverage(segments, now);
  const alerts: string[] = [];
  for (const red of checklist.reds) alerts.push(formatComplianceAlert(red));
  for (const amber of checklist.ambers) alerts.push(formatComplianceAlert(amber));
  for (const defect of defects) {
    alerts.push(formatDefectAlert(defect));
  }
  if (hosFlag) alerts.push(`${hosFlag.severity === "red" ? "RED" : "AMBER"} — HOS: ${hosFlag.message}`);
  const counts = {
    red: checklist.reds.length + defects.length + (hosFlag?.severity === "red" ? 1 : 0),
    amber: checklist.ambers.length + (hosFlag?.severity === "amber" ? 1 : 0),
    ok: checklist.oks.length,
    unknown: checklist.unknowns.length,
    defects: defects.length,
  };
  const summary =
    alerts.length === 0
      ? "Compliance Watchdog: checklist current, no open defects, duty log covered."
      : `Compliance Watchdog: ${counts.red} red, ${counts.amber} amber, ${counts.defects} open defect${counts.defects === 1 ? "" : "s"}.`;
  return { checklist, defects, segments, hosFlag, alerts, counts, summary };
}

export { alertFingerprint };
