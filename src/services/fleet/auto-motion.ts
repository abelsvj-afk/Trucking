// The ONE place the automatic switch to Driving is performed (docs/design/driver-hud-round2.md
// Block A; extended to work with the app closed). Two callers feed it a DETECTION time:
//   - the open app (POST /api/v1/duty-logs/auto-motion, from sustained on-screen GPS);
//   - the Telegram Live Location handler / any server-side position ingest (the phone keeps
//     reporting with the screen off).
// Both get the same rules (lib/auto-motion-rules.ts): it only ADDS a Driving row from the
// detection time forward, never edits or deletes anything, stands down for a manual choice,
// is idempotent per detection, and respects the auto_duty_switch kill switch.
//
// The stop side lives here too (ELD stopped vehicle, App. A §4.4.1.2):
// applyAutoStopSwitch adds ONE On Duty row backdated to the stop start
// (the last movement time) when the truck has been stopped 6 minutes
// and the 5-minute prompt went unanswered. Never Off Duty/Sleeper,
// never a silent rewrite of in-motion time, original row untouched,
// trail entry recorded. Same kill switch, same idempotency.

import type { SupabaseClient } from "@supabase/supabase-js";
import { judgeAutoMotion, judgeAutoRest, judgeAutoStop, REST_ASK_SILENCE_MS } from "@/lib/auto-motion-rules";
import { SUSTAIN_MS } from "@/lib/sustained-motion";
import { formatClock, HOME_TIME_ZONE } from "@/lib/display-zone";
import { AUTO_DUTY_SWITCH_CAPABILITY, DEFAULT_ON_CAPABILITIES } from "@/lib/live-motion";
import { buildSegments, findShortClockAnchor } from "@/lib/hos";
import { stopCorrectionConfirmation } from "@/lib/stopped-vehicle";
import { recordDutyLogEdit } from "@/services/duty-log-edits";
import type { DutyLog } from "@/types/entities";

export interface AutoMotionResult {
  switched: boolean;
  reason?: string;
  startedAt?: string;
  deduplicated?: boolean;
}

/** The auto_duty_switch kill switch: default ON (the owner ordered the automatic switch); an explicit off row, or the global AI switch, stops it. Unverifiable = off (fails closed). */
export async function isAutoSwitchEnabled(client: SupabaseClient, companyId: string): Promise<boolean> {
  const [globalRow, switchRow] = await Promise.all([
    client.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    client.from("ai_capability_settings").select("enabled").eq("company_id", companyId).eq("capability", AUTO_DUTY_SWITCH_CAPABILITY).maybeSingle(),
  ]);
  if (globalRow.error || switchRow.error) return false;
  if ((globalRow.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled === true) return false;
  const explicit = (switchRow.data as { enabled: boolean } | null)?.enabled;
  return explicit ?? DEFAULT_ON_CAPABILITIES.has(AUTO_DUTY_SWITCH_CAPABILITY);
}

/**
 * When the motion run began: the detection time minus the sustain window (both callers stamp detection as
 * motion start + SUSTAIN_MS - lib/auto-switch.ts, services/telegram/live-location.ts). Clamped to just after
 * the latest row so the Driving row can never start before an entry already in the log.
 */
export function motionStartIso(detectedAtIso: string, latestStartedAtIso: string | null): string {
  const start = Date.parse(detectedAtIso) - SUSTAIN_MS;
  const floor = latestStartedAtIso ? Date.parse(latestStartedAtIso) + 1_000 : -Infinity;
  return new Date(Math.max(start, floor)).toISOString();
}

export async function applyAutoMotionSwitch(opts: {
  client: SupabaseClient;
  companyId: string;
  detectedAtIso: string;
  submissionId: string;
  nowMs: number;
  /** "app" = the open app saw it; "position feed" = a server-side position source (works with the app closed). */
  origin: "app" | "position feed";
  /**
   * The zone the switch is announced in — the truck's zone at the
   * fix that detected the motion (lib/display-zone). Defaults to home
   * Eastern. The row also records it (duty_logs.time_zone, migration
   * 00091): every entry carries the zone where it happened.
   */
  timeZone?: string;
}): Promise<AutoMotionResult> {
  const { client, companyId, detectedAtIso, submissionId, nowMs, origin } = opts;
  const timeZone = opts.timeZone ?? HOME_TIME_ZONE;
  if (!(await isAutoSwitchEnabled(client, companyId))) return { switched: false, reason: "switched_off" };

  // Replay of the same detection: report the original outcome, never a second row.
  const { data: existing } = await client
    .from("duty_logs")
    .select("id")
    .eq("company_id", companyId)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (existing) return { switched: true, deduplicated: true, startedAt: motionStartIso(detectedAtIso, null) };

  const { data: latestRows, error } = await client
    .from("duty_logs")
    .select("duty_status, started_at")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const latest = ((latestRows ?? [])[0] ?? null) as Pick<DutyLog, "duty_status" | "started_at"> | null;

  const verdict = judgeAutoMotion(latest, detectedAtIso, nowMs);
  if (!verdict.ok) return { switched: false, reason: verdict.reason };

  // Owner 2026-11-17: backdate to when the truck STARTED moving, as an ELD does - the 60 s it took to be
  // sure of the motion was driving, not the previous status. Never earlier than the latest row (the verdict
  // above already refuses when a row started inside the motion run, so this clamp is a second guard).
  const startedAt = motionStartIso(detectedAtIso, latest!.started_at);
  const note =
    `Automatic: switched to Driving by detected truck motion, from ${formatClock(startedAt, timeZone)} when the truck started moving ` +
    `(confirmed after 60 s of motion while the log said ${latest!.duty_status.replace("_", " ")}; ${origin === "app" ? "seen by the open app" : "from the phone's position feed"}).`;
  const base = {
    company_id: companyId,
    driver_id: null,
    load_id: null,
    duty_status: "driving",
    started_at: startedAt,
    location: null,
    odometer: null,
    notes: note,
    submission_id: submissionId,
    time_zone: timeZone,
  };
  let insert = await client.from("duty_logs").insert({ ...base, source: "auto_motion" });
  if (insert.error && /duty_logs_source_check|violates check constraint/i.test(insert.error.message)) {
    // Migration 00072 not applied yet: the row is still recorded, the note carries the provenance.
    insert = await client.from("duty_logs").insert({ ...base, source: "app" });
  }
  if (insert.error && /time_zone/i.test(insert.error.message) && /does not exist/i.test(insert.error.message)) {
    // Migration 00091 not applied yet: the row still lands; the note
    // carries the labeled time, so the zone is not lost, only uncolumned.
    const { time_zone: _dropped, ...withoutZone } = base;
    insert = await client.from("duty_logs").insert({ ...withoutZone, source: "auto_motion" });
  }
  if (insert.error) {
    // A second tab/device/feed won the same detection: that is a replay, not a failure.
    if ((insert.error as { code?: string }).code === "23505") return { switched: true, deduplicated: true, startedAt };
    throw new Error(insert.error.message);
  }
  return { switched: true, startedAt };
}

/** The Telegram notice, one wording for both callers — in the truck's zone, labeled, never UTC. */
export function autoSwitchNotice(startedAtIso: string, timeZone: string = HOME_TIME_ZONE): string {
  return `Switched to Driving at ${formatClock(startedAtIso, timeZone)} — truck moving. (Automatic, from detected motion. If that's wrong, change your status in the app.)`;
}

/** One stable id per detection, so a retry or a second source replays the same switch instead of adding another. */
export function autoSubmissionId(detectedAtMs: number): string {
  const hex = detectedAtMs.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/** One stable id per stop episode — a different namespace from the Driving switch, so a stop and a move can never collide on one id. */
export function autoStopSubmissionId(stoppedSinceMs: number): string {
  const hex = stoppedSinceMs.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4001-8000-${hex}`;
}

export interface AutoStopResult {
  switched: boolean;
  reason?: string;
  /** The stop start: the new On Duty row's started_at (backdated, never tap-time). */
  startedAt?: string;
  deduplicated?: boolean;
  /** ISO end of the current 14-hour window (unchanged by the correction — the window is not rewound). */
  windowEndsAt?: string | null;
  /** The confirmation to show him, with the 14-hour honesty line. */
  message?: string;
}

/** The 14-hour window end from the log as it stands after the correction (null when the log cannot say). */
async function windowEndsAtAfter(
  client: SupabaseClient,
  companyId: string,
  nowMs: number,
  correctedRow: { duty_status: DutyLog["duty_status"]; started_at: string },
): Promise<string | null> {
  try {
    const sinceIso = new Date(nowMs - 3 * 24 * 60 * 60_000).toISOString();
    const { data, error } = await client
      .from("duty_logs")
      .select("duty_status, started_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", sinceIso)
      .order("started_at", { ascending: true })
      .limit(500);
    if (error || !data) return null;
    const segments = buildSegments(
      [...(data as { duty_status: DutyLog["duty_status"]; started_at: string }[]), correctedRow],
      nowMs,
    );
    // Split sleeper (2026-11-17): the paired second rest doesn't count against the 14, so it pushes the end out.
    const anchor = findShortClockAnchor(segments);
    if (!anchor) return null;
    return new Date(anchor.startMs + anchor.excludedMs + 14 * 60 * 60_000).toISOString();
  } catch {
    return null;
  }
}

/**
 * The automatic switch OUT of Driving (ELD App. A §4.4.1.2): stopped 6
 * minutes, 5-minute prompt unanswered for a minute. Appends ONE On Duty
 * row at the stop start (last movement time) + a duty_log_edits trail
 * entry (reason, proposer Abel/app, confirmer the driver — the prompt
 * silence is his non-answer, the row is the mirror's). The original
 * Driving row is untouched; in-motion time is never edited. A corrected
 * On Duty stop is not a sleeper segment and must never count toward a
 * future split-sleeper pair (it is On Duty, not Sleeper — the HOS
 * engine only counts off_duty/sleeper as rest).
 */
export async function applyAutoStopSwitch(opts: {
  client: SupabaseClient;
  companyId: string;
  /** The stop start (last movement time): the new row's started_at. */
  stoppedSinceIso: string;
  submissionId: string;
  nowMs: number;
  /** When the 5-minute prompt was shown for this episode — null means never prompted: never auto-switch blind. */
  promptedAtMs: number | null;
  /** "app" = the open app saw it; "position feed" = a server-side position source (works with the app closed). */
  origin: "app" | "position feed";
  timeZone?: string;
}): Promise<AutoStopResult> {
  const { client, companyId, stoppedSinceIso, submissionId, nowMs, origin } = opts;
  const timeZone = opts.timeZone ?? HOME_TIME_ZONE;
  if (!(await isAutoSwitchEnabled(client, companyId))) return { switched: false, reason: "switched_off" };

  // Replay of the same stop: report the original outcome, never a second row.
  const { data: existing } = await client
    .from("duty_logs")
    .select("id")
    .eq("company_id", companyId)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (existing) return { switched: true, deduplicated: true, startedAt: stoppedSinceIso };

  const { data: latestRows, error } = await client
    .from("duty_logs")
    .select("id, duty_status, started_at, notes, time_zone")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const latest = ((latestRows ?? [])[0] ?? null) as
    | Pick<DutyLog, "id" | "duty_status" | "started_at" | "notes" | "time_zone">
    | null;

  const verdict = judgeAutoStop(latest, stoppedSinceIso, nowMs, opts.promptedAtMs);
  if (!verdict.ok) return { switched: false, reason: verdict.reason };

  const startedAt = new Date(stoppedSinceIso).toISOString();
  const stopLabel = formatClock(startedAt, timeZone);
  const note =
    `Auto-stop correction: switched to On Duty (not driving) from ${stopLabel} — truck stopped since then with no ` +
    `movement, and the 5-minute prompt went unanswered (${origin === "app" ? "seen by the open app" : "from the phone's position feed"}). ` +
    `Mirror correction — not the legal ELD; confirm the same change in the carrier ELD.`;
  const base = {
    company_id: companyId,
    driver_id: null,
    load_id: null,
    duty_status: "on_duty",
    started_at: startedAt,
    location: null,
    odometer: null,
    notes: note,
    submission_id: submissionId,
    time_zone: timeZone,
  };
  let insert = await client.from("duty_logs").insert({ ...base, source: "auto_motion" });
  if (insert.error && /duty_logs_source_check|violates check constraint/i.test(insert.error.message)) {
    // Migration 00072 not applied yet: the row is still recorded, the note carries the provenance.
    insert = await client.from("duty_logs").insert({ ...base, source: "app" });
  }
  if (insert.error && /time_zone/i.test(insert.error.message) && /does not exist/i.test(insert.error.message)) {
    // Migration 00091 not applied yet: the row still lands; the note
    // carries the labeled time, so the zone is not lost, only uncolumned.
    const { time_zone: _dropped, ...withoutZone } = base;
    insert = await client.from("duty_logs").insert({ ...withoutZone, source: "auto_motion" });
  }
  if (insert.error) {
    // A second tab/device/feed won the same stop: that is a replay, not a failure.
    if ((insert.error as { code?: string }).code === "23505") return { switched: true, deduplicated: true, startedAt };
    throw new Error(insert.error.message);
  }
  // The trail: the original Driving row is the "before", the new On
  // Duty row the "after". Best-effort — a missing trail table never
  // breaks the landed correction (recordDutyLogEdit reports false).
  // maybeSingle() is a PromiseLike, not a Promise: no .catch — the
  // try/catch below is the safety net.
  let newRowId: string | null = null;
  try {
    const found = await client
      .from("duty_logs")
      .select("id")
      .eq("company_id", companyId)
      .eq("submission_id", submissionId)
      .maybeSingle();
    newRowId = (found.data as { id: string } | null)?.id ?? null;
  } catch {
    newRowId = null;
  }
  if (newRowId) {
    await recordDutyLogEdit(client, {
      companyId,
      dutyLogId: newRowId,
      kind: "insert",
      reason: note,
      before: latest ? { ...latest } : null,
      after: { ...base, source: "auto_motion" },
      source: "app",
    });
  }
  const windowEndsAt = await windowEndsAtAfter(client, companyId, nowMs, { duty_status: "on_duty", started_at: startedAt });
  const message =
    `Switched to On duty (not driving) from ${stopLabel} — truck stopped, no answer to the prompt. ` +
    `${stopCorrectionConfirmation({ windowEndLabel: windowEndsAt ? formatClock(windowEndsAt, timeZone) : null })} ` +
    `(Mirror — not the legal ELD.)`;
  return { switched: true, startedAt, windowEndsAt, message };
}

/** The auto-stop notice — the confirmation message itself (it carries the 14-hour honesty line). */
export function autoStopNotice(message: string): string {
  return message;
}

export interface AutoRestResult {
  switched: boolean;
  /** "ask_first": eligible, but he has not been asked yet — send `message` (the question) and record the ask. */
  reason?: string;
  startedAt?: string;
  deduplicated?: boolean;
  message?: string;
}

/**
 * Owner 2026-11-17 ("Auto Off Duty after 2h"): parked 2 hours with no answer after the app's own automatic stop
 * (or still Driving) -> ONE Off Duty row from when he parked. ASK FIRST (audit F-003): with `askedAtMs` null an
 * eligible park returns reason "ask_first" and the question to send; the switch happens only once the question
 * is REST_ASK_SILENCE_MS old and he has sent no message since it (any reply is an answer — Abel takes it from there). Same kill switch, same idempotency and the same
 * audit trail as the stop side; an On Duty he set himself is never followed (lib/auto-motion-rules judgeAutoRest).
 * Planning log, not the legal ELD - the message says how to undo it.
 */
export async function applyAutoRestSwitch(opts: {
  client: SupabaseClient;
  companyId: string;
  stoppedSinceIso: string;
  submissionId: string;
  nowMs: number;
  origin: "app" | "position feed";
  timeZone?: string;
  /** When "going off duty?" was asked for this park; null = not asked yet. */
  askedAtMs: number | null;
}): Promise<AutoRestResult> {
  const { client, companyId, stoppedSinceIso, submissionId, nowMs, origin, askedAtMs } = opts;
  const timeZone = opts.timeZone ?? HOME_TIME_ZONE;
  if (!(await isAutoSwitchEnabled(client, companyId))) return { switched: false, reason: "switched_off" };

  const { data: existing } = await client.from("duty_logs").select("id").eq("company_id", companyId).eq("submission_id", submissionId).maybeSingle();
  if (existing) return { switched: true, deduplicated: true };

  const { data: latestRows, error } = await client
    .from("duty_logs")
    .select("id, duty_status, started_at, notes, time_zone, source")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const latest = ((latestRows ?? [])[0] ?? null) as (Pick<DutyLog, "id" | "duty_status" | "started_at" | "notes" | "time_zone"> & { source?: string | null }) | null;

  const verdict = judgeAutoRest(latest, stoppedSinceIso, nowMs);
  if (!verdict.ok) return { switched: false, reason: verdict.reason };

  const parkedLabel = formatClock(stoppedSinceIso, timeZone);
  if (askedAtMs === null) {
    const deadlineLabel = formatClock(new Date(nowMs + REST_ASK_SILENCE_MS).toISOString(), timeZone);
    return {
      switched: false,
      reason: "ask_first",
      message:
        `You've been parked since ${parkedLabel} — over 2 hours. Going off duty? ` +
        `Tell me "off duty", "sleeper", or "still working". If I don't hear from you by ${deadlineLabel}, ` +
        `I'll log Off Duty from ${parkedLabel} so your 14 and your cycle stop burning. (Planning log, not your ELD.)`,
    };
  }
  if (nowMs - askedAtMs < REST_ASK_SILENCE_MS) return { switched: false, reason: "waiting_for_answer" };
  // Any message from him since the question is an answer: never switch over it.
  const replies = await client
    .from("telegram_messages")
    .select("id")
    .eq("company_id", companyId)
    .eq("role", "user")
    .is("deleted_at", null)
    .gt("created_at", new Date(askedAtMs).toISOString())
    .limit(1);
  if (replies.error) return { switched: false, reason: "answer_unknown" };
  if ((replies.data ?? []).length > 0) return { switched: false, reason: "answered" };

  const startedAt = new Date(verdict.startedAtMs).toISOString();
  const askedLabel = formatClock(new Date(askedAtMs).toISOString(), timeZone);
  const note =
    `Automatic rest: switched to Off Duty from ${parkedLabel} - truck parked 2+ hours with no movement; asked "going off duty?" at ${askedLabel} ` +
    `and got no answer in ${Math.round(REST_ASK_SILENCE_MS / 60_000)} minutes ` +
    `(${origin === "app" ? "seen by the open app" : "from the phone's position feed"}). Planning log, not the legal ELD.`;
  const base = {
    company_id: companyId,
    driver_id: null,
    load_id: null,
    duty_status: "off_duty",
    started_at: startedAt,
    location: null,
    odometer: null,
    notes: note,
    submission_id: submissionId,
    time_zone: timeZone,
  };
  let insert = await client.from("duty_logs").insert({ ...base, source: "auto_motion" });
  if (insert.error && /duty_logs_source_check|violates check constraint/i.test(insert.error.message)) {
    insert = await client.from("duty_logs").insert({ ...base, source: "app" });
  }
  if (insert.error && /time_zone/i.test(insert.error.message) && /does not exist/i.test(insert.error.message)) {
    const { time_zone: _dropped, ...withoutZone } = base;
    insert = await client.from("duty_logs").insert({ ...withoutZone, source: "auto_motion" });
  }
  if (insert.error) {
    if ((insert.error as { code?: string }).code === "23505") return { switched: true, deduplicated: true, startedAt };
    throw new Error(insert.error.message);
  }
  try {
    const found = await client.from("duty_logs").select("id").eq("company_id", companyId).eq("submission_id", submissionId).maybeSingle();
    const newRowId = (found.data as { id: string } | null)?.id ?? null;
    if (newRowId) {
      await recordDutyLogEdit(client, { companyId, dutyLogId: newRowId, kind: "insert", reason: note, before: latest ? { ...latest } : null, after: { ...base, source: "auto_motion" }, source: "app" });
    }
  } catch {
    /* the trail is best-effort; the rest landed */
  }
  const message =
    `Logged you Off Duty from ${parkedLabel} - parked over 2 hours and no answer to my question at ${askedLabel}, so that's counted as rest (your 14 and your cycle stop burning). ` +
    `Wrong - were you working? Tell me "I was on duty since ${parkedLabel}" and I'll fix it. (Planning log, not your ELD.)`;
  return { switched: true, startedAt, message };
}

/** Idempotency key for the automatic rest of one park (a different variant from the stop's). */
export function autoRestSubmissionId(stoppedSinceMs: number): string {
  const hex = stoppedSinceMs.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4002-8000-${hex}`;
}
