// Compliance Watchdog — HOS / safety / compliance alerts ONLY
// (Phase 2 seat; plan docs/bot-team-build-plan.md; governing file
// docs/bots/compliance-watchdog/CLAUDE.md).
//
// The Watchdog watches deadlines and hours so nothing expires
// quietly. It reads, it flags, it posts red / amber alerts in the
// group and the app. That is the whole job:
//
// - It NEVER edits a duty log, clears a driver, or waives a test —
//   there is no write path to duty_logs or credentials here at all.
// - It NEVER calls anyone (registry: calls "never") and never calls
//   the owner — alerts go to the group / app, and what reaches the
//   owner is Abel's call, not this bot's.
// - It never files anything with FMCSA, an insurer, or any
//   regulator, and it never decides an out-of-service question —
//   it lays out the rule and the risk; the owner decides.
//
// Data, read-only, from the app's own records:
// - Deadlines: the `credentials` register (medical card, CDL,
//   annual inspection, registration / IRP, insurance) — the same
//   rows Abel's deadline list reads. Clearinghouse queries, the
//   drug-test pool, MVR and DVIR defects are NOT in that register,
//   so this bot does not claim to watch them; the checklist below
//   names only what it actually reads. Missing paper is a flag,
//   never a "probably fine".
// - Hours: the ONE server-side HOS read (services/api/hos-window:
//   loadHosWindow) — the same snapshot the Hours page, Abel, and
//   Smart Path state from. This module computes no hours of its
//   own; it classifies the engine's warnings.
//
// Alerts are flags under the propose-only guardrails: the gate is
// checked first (flag on app-actions), every raised alert is
// written to bot_audit_log, and the group post is the visible half.
// A scheduled sweep can call runWatchdogCheck the same way the
// group handler does — the sweep itself is the always-on VM's job
// (same design as Scout's scheduler), not built here.

import { createClient } from "@supabase/supabase-js";
import { daysBetween } from "@/lib/temporal";
import { formatHosMinutes, hosWarnings, loadHosWindow, type HosWindowSnapshot } from "@/services/api/hos-window";
import { checkBotAction } from "./guardrails";
import type { BotTeamStore } from "./store";

export type WatchdogSeverity = "red" | "amber";

export interface WatchdogAlert {
  severity: WatchdogSeverity;
  category: "deadline" | "hos" | "legality";
  /** What is due or wrong, in plain words. */
  subject: string;
  /** What is missing, or what happens if it is missed. */
  detail: string;
}

export interface CredentialFact {
  kind: string;
  label: string;
  /** YYYY-MM-DD. */
  expiresOn: string;
}

export interface LegalityVerdict {
  /** True only when the records were read AND nothing blocks. */
  legal: boolean;
  /** True when the records behind the verdict were actually read. */
  verified: boolean;
  /** Plain-words blockers; empty when legal. */
  reasons: string[];
}

export interface WatchdogReport {
  alerts: WatchdogAlert[];
  legality: LegalityVerdict;
  /** The group-ready alert block (no bot-name prefix; the caller adds it). */
  summary: string;
  checkedAt: string;
}

/** Credentials this bot tracks, by register kind, in checklist order. */
export const WATCHDOG_TRACKED_CREDENTIALS: { kind: string; name: string; requiredToRun: boolean }[] = [
  { kind: "medical_card", name: "Medical card", requiredToRun: true },
  { kind: "cdl", name: "CDL", requiredToRun: true },
  { kind: "annual_inspection", name: "Annual inspection", requiredToRun: false },
  { kind: "registration_irp", name: "Registration / IRP", requiredToRun: false },
  { kind: "insurance", name: "Insurance", requiredToRun: false },
];

/** Days out at which a deadline turns amber, unless memory says otherwise. */
export const DEFAULT_AMBER_DAYS = 30;

/** Cycle time left (minutes) at which the cycle turns amber. */
export const CYCLE_AMBER_LEFT_MINUTES = 5 * 60;

function dateLabel(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Deadline evaluation, pure. `today` is YYYY-MM-DD in the zone the
 * caller states dates in (the HOS carrier zone in production).
 * A renewed credential supersedes the old one: the latest expiry
 * on file for a kind is the one that counts.
 */
export function evaluateDeadlines(credentials: CredentialFact[], today: string, amberDays: number = DEFAULT_AMBER_DAYS): WatchdogAlert[] {
  const alerts: WatchdogAlert[] = [];
  const byKind = new Map<string, CredentialFact[]>();
  for (const credential of credentials) {
    const rows = byKind.get(credential.kind) ?? [];
    rows.push(credential);
    byKind.set(credential.kind, rows);
  }

  const expiryAlert = (name: string, expiresOn: string): WatchdogAlert | null => {
    const daysLeft = daysBetween(today, expiresOn);
    if (daysLeft < 0) {
      return {
        severity: "red",
        category: "deadline",
        subject: `${name} — expired ${-daysLeft} day${-daysLeft === 1 ? "" : "s"} ago (${dateLabel(expiresOn)})`,
        detail: "Expired paper is a block, not a warning: renew it before the truck runs.",
      };
    }
    if (daysLeft <= amberDays) {
      return {
        severity: "amber",
        category: "deadline",
        subject: `${name} — expires ${daysLeft === 0 ? "TODAY" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`} (${dateLabel(expiresOn)})`,
        detail: "Renew it now so it never turns red.",
      };
    }
    return null;
  };

  for (const tracked of WATCHDOG_TRACKED_CREDENTIALS) {
    const rows = byKind.get(tracked.kind) ?? [];
    if (rows.length === 0) {
      alerts.push({
        severity: tracked.requiredToRun ? "red" : "amber",
        category: "deadline",
        subject: `${tracked.name} — not on file`,
        detail: tracked.requiredToRun
          ? "Missing paper is a block: with no current record on file, I cannot show the driver is legal to run."
          : "Nothing on file to watch — if this exists on paper, file it so the date is tracked here.",
      });
      continue;
    }
    const latest = rows.reduce((a, b) => (a.expiresOn >= b.expiresOn ? a : b));
    const alert = expiryAlert(tracked.name, latest.expiresOn);
    if (alert) alerts.push(alert);
  }

  // Anything else in the register with a date still gets watched —
  // the owner filed it because it matters.
  for (const credential of credentials) {
    if (WATCHDOG_TRACKED_CREDENTIALS.some((tracked) => tracked.kind === credential.kind)) continue;
    const alert = expiryAlert(credential.label, credential.expiresOn);
    if (alert) alerts.push(alert);
  }

  return alerts;
}

/** Engine warnings that mean a limit is already reached — red, not amber. */
const RED_WARNING = /limit reached|used up|would violate/i;

/**
 * HOS evaluation, pure: classify the one engine's warnings and add
 * the forward-looking cycle alert. No hours are computed here that
 * the engine did not already state.
 */
export function evaluateHos(snapshot: HosWindowSnapshot): WatchdogAlert[] {
  const alerts: WatchdogAlert[] = [];
  if (snapshot.rows.length === 0) {
    alerts.push({
      severity: "amber",
      category: "hos",
      subject: "Hours — no duty logs on file",
      detail: "I cannot verify hours without logs. The ELD / official log is the legal record.",
    });
    return alerts;
  }
  for (const warning of hosWarnings(snapshot)) {
    alerts.push({
      severity: RED_WARNING.test(warning) ? "red" : "amber",
      category: "hos",
      subject: `Hours — ${warning}`,
      detail: "Flagged from the same HOS read every surface uses. I never edit a log; a correction is the owner's, in the app.",
    });
  }
  const cycleLeft = snapshot.cycle.cycleLimitMinutes - snapshot.cycle.onDutyMinutesInCycle;
  if (cycleLeft > 0 && cycleLeft <= CYCLE_AMBER_LEFT_MINUTES) {
    alerts.push({
      severity: "amber",
      category: "hos",
      subject: `Hours — ${formatHosMinutes(cycleLeft)} left on the ${snapshot.cycle.cycle} cycle`,
      detail: "Plan the restart or the roll-off now, before it is a red flag at the worst moment.",
    });
  }
  return alerts;
}

/**
 * The pre-booking verdict, pure: is the driver / truck legal to run
 * a load right now, on the records read? This states the rule and
 * the risk — it does not clear anyone (a human clears a driver) and
 * it never softens a block. Unread records are NOT a pass: the
 * verdict comes back unverified, and unverified never runs.
 */
export function checkLoadLegality(input: {
  credentials: CredentialFact[] | null;
  snapshot: HosWindowSnapshot | null;
  today: string;
}): LegalityVerdict {
  if (!input.credentials || !input.snapshot) {
    return {
      legal: false,
      verified: false,
      reasons: ["I could not read the records, so I cannot show the driver is legal to run. Unverified never runs."],
    };
  }
  const reasons: string[] = [];
  for (const tracked of WATCHDOG_TRACKED_CREDENTIALS) {
    if (!tracked.requiredToRun) continue;
    const rows = input.credentials.filter((credential) => credential.kind === tracked.kind);
    if (rows.length === 0) {
      reasons.push(`${tracked.name} is not on file.`);
      continue;
    }
    const latest = rows.reduce((a, b) => (a.expiresOn >= b.expiresOn ? a : b));
    if (daysBetween(input.today, latest.expiresOn) < 0) {
      reasons.push(`${tracked.name} expired ${dateLabel(latest.expiresOn)}.`);
    }
  }
  for (const warning of hosWarnings(input.snapshot)) {
    reasons.push(`Hours: ${warning}`);
  }
  const cycleLeft = input.snapshot.cycle.cycleLimitMinutes - input.snapshot.cycle.onDutyMinutesInCycle;
  if (input.snapshot.rows.length > 0 && cycleLeft <= 0) {
    reasons.push(`Hours: the ${input.snapshot.cycle.cycle} cycle is used up — a 34-hour restart or waiting for periods to roll off is required.`);
  }
  return { legal: reasons.length === 0, verified: true, reasons };
}

/**
 * The amber window out of the Watchdog's stored memories
 * (bot_team_memories). One accepted form — "amber: 45" or
 * "amber days: 45" — anything else is ignored, never guessed.
 * This is the corrections surface: the owner says it once, the
 * check honors it from then on.
 */
export function parseWatchdogPreferences(memories: { content: string }[]): { amberDays: number } {
  for (const memory of memories) {
    const match = memory.content.match(/amber(?:\s+days?)?\s*[:=]?\s*(\d{1,3})\b/i);
    if (match && match[1]) {
      const days = Number(match[1]);
      if (Number.isFinite(days) && days >= 1 && days <= 365) return { amberDays: days };
    }
  }
  return { amberDays: DEFAULT_AMBER_DAYS };
}

/** YYYY-MM-DD for `now` in an IANA zone — dates are stated in the zone, never UTC. */
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface WatchdogData {
  loadCredentials(): Promise<CredentialFact[]>;
  loadHosSnapshot(now: Date): Promise<HosWindowSnapshot>;
}

export interface WatchdogCheckDeps {
  store: BotTeamStore | null;
  data: WatchdogData | null;
  now?: () => Date;
}

function summaryFor(alerts: WatchdogAlert[], legality: LegalityVerdict, snapshot: HosWindowSnapshot | null): string {
  const lines: string[] = [];
  for (const alert of alerts) {
    lines.push(`${alert.severity === "red" ? "🔴" : "🟠"} ${alert.subject} ${alert.detail}`);
  }
  if (legality.verified) {
    lines.push(
      legality.legal
        ? "Legal to run: yes — no block on the records I read. The owner still decides."
        : `Legal to run: NO — ${legality.reasons.join(" ")}`,
    );
  } else {
    lines.push(`Legal to run: cannot verify — ${legality.reasons.join(" ")}`);
  }
  if (snapshot && snapshot.rows.length > 0) {
    const cycleLeft = Math.max(0, snapshot.cycle.cycleLimitMinutes - snapshot.cycle.onDutyMinutesInCycle);
    lines.push(`Hours: ${formatHosMinutes(cycleLeft)} left on the ${snapshot.cycle.cycle} cycle.`);
  }
  if (alerts.length === 0 && legality.verified && legality.legal) {
    lines.unshift("All clear — no deadline inside the watch window, no HOS warnings.");
  }
  return lines.join("\n");
}

/**
 * One full check: gate, memories, records, evaluation, audit. The
 * group handler and (later) the scheduler both call exactly this.
 * A failed read is loud and honest — the report says what could not
 * be read and clears no one.
 */
export async function runWatchdogCheck(deps: WatchdogCheckDeps): Promise<WatchdogReport> {
  const now = deps.now ? deps.now() : new Date();
  const checkedAt = now.toISOString();

  const gate = checkBotAction({ botSlug: "compliance-watchdog", actionKind: "flag", group: "app-actions" });
  if (!gate.allowed) {
    return {
      alerts: [],
      legality: { legal: false, verified: false, reasons: [gate.reason] },
      summary: gate.reason,
      checkedAt,
    };
  }

  let amberDays = DEFAULT_AMBER_DAYS;
  if (deps.store) {
    try {
      const memories = await deps.store.loadBotMemories("compliance-watchdog");
      amberDays = parseWatchdogPreferences(memories).amberDays;
    } catch (error) {
      console.error("[bot-team] watchdog memories failed — using the default amber window", error);
    }
  }

  if (!deps.data) {
    const legality: LegalityVerdict = {
      legal: false,
      verified: false,
      reasons: ["My data access is not configured on the server, so I read nothing. Unverified never runs."],
    };
    return { alerts: [], legality, summary: summaryFor([], legality, null), checkedAt };
  }

  let credentials: CredentialFact[] | null = null;
  let snapshot: HosWindowSnapshot | null = null;
  const readFailures: string[] = [];
  try {
    credentials = await deps.data.loadCredentials();
  } catch (error) {
    console.error("[bot-team] watchdog credential read failed", error);
    readFailures.push("the credential register");
  }
  try {
    snapshot = await deps.data.loadHosSnapshot(now);
  } catch (error) {
    console.error("[bot-team] watchdog HOS read failed", error);
    readFailures.push("the duty logs");
  }

  const alerts: WatchdogAlert[] = [];
  if (credentials && snapshot) {
    const today = todayInZone(now, snapshot.config.carrierTimeZone);
    alerts.push(...evaluateDeadlines(credentials, today, amberDays));
    alerts.push(...evaluateHos(snapshot));
    const legality = checkLoadLegality({ credentials, snapshot, today });
    const report: WatchdogReport = { alerts, legality, summary: summaryFor(alerts, legality, snapshot), checkedAt };
    await auditAlerts(deps.store, report);
    return report;
  }

  const legality: LegalityVerdict = {
    legal: false,
    verified: false,
    reasons: [`I could not read ${readFailures.join(" and ") || "the records"}, so I cannot show the driver is legal to run. Unverified never runs.`],
  };
  const partial = credentials ? evaluateDeadlines(credentials, todayInZone(now, "America/New_York"), amberDays) : snapshot ? evaluateHos(snapshot) : [];
  const report: WatchdogReport = { alerts: partial, legality, summary: summaryFor(partial, legality, snapshot), checkedAt };
  await auditAlerts(deps.store, report);
  return report;
}

async function auditAlerts(store: BotTeamStore | null, report: WatchdogReport): Promise<void> {
  if (!store) return;
  for (const alert of report.alerts) {
    try {
      await store.logAudit({
        botSlug: "compliance-watchdog",
        actor: "bot",
        action: "alert_raised",
        targetRef: alert.category,
        detail: { severity: alert.severity, subject: alert.subject, detail: alert.detail },
      });
    } catch (error) {
      console.error("[bot-team] watchdog alert audit failed", error);
    }
  }
  try {
    await store.logAudit({
      botSlug: "compliance-watchdog",
      actor: "bot",
      action: "watchdog_check",
      targetRef: null,
      detail: {
        alerts: report.alerts.length,
        red: report.alerts.filter((alert) => alert.severity === "red").length,
        amber: report.alerts.filter((alert) => alert.severity === "amber").length,
        legal: report.legality.legal,
        verified: report.legality.verified,
        checkedAt: report.checkedAt,
      },
    });
  } catch (error) {
    console.error("[bot-team] watchdog check audit failed", error);
  }
}

/**
 * Production data access: the service-role client scoped to the
 * single company (same pattern as services/bots/store.ts — the
 * webhook has no user session). Read-only queries only; there is
 * deliberately no write method on this object. Returns null when
 * the env is not configured, and the check says so honestly.
 */
export function createWatchdogData(companyId: string | null): WatchdogData | null {
  if (!companyId) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  const client = createClient(url, serviceRoleKey);
  return {
    async loadCredentials() {
      const { data, error } = await client
        .from("credentials")
        .select("kind, label, expires_on")
        .eq("company_id", companyId)
        .is("deleted_at", null);
      if (error) {
        throw new Error(`[bot-team] watchdog credentials read failed: ${error.message}`);
      }
      return (data ?? []).map((row) => {
        const record = row as { kind: string; label: string; expires_on: string };
        return { kind: record.kind, label: record.label, expiresOn: record.expires_on };
      });
    },
    async loadHosSnapshot(now: Date) {
      return loadHosWindow(client, companyId, now);
    },
  };
}
