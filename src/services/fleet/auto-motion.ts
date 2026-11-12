// The ONE place the automatic switch to Driving is performed (docs/design/driver-hud-round2.md
// Block A; extended to work with the app closed). Two callers feed it a DETECTION time:
//   - the open app (POST /api/v1/duty-logs/auto-motion, from sustained on-screen GPS);
//   - the Telegram Live Location handler / any server-side position ingest (the phone keeps
//     reporting with the screen off).
// Both get the same rules (lib/auto-motion-rules.ts): it only ADDS a Driving row from the
// detection time forward, never edits or deletes anything, stands down for a manual choice,
// is idempotent per detection, and respects the auto_duty_switch kill switch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { judgeAutoMotion } from "@/lib/auto-motion-rules";
import { formatClock, HOME_TIME_ZONE } from "@/lib/display-zone";
import { AUTO_DUTY_SWITCH_CAPABILITY, DEFAULT_ON_CAPABILITIES } from "@/lib/live-motion";
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
  if (existing) return { switched: true, deduplicated: true, startedAt: detectedAtIso };

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

  const startedAt = new Date(detectedAtIso).toISOString();
  const note =
    `Automatic: switched to Driving by detected truck motion at ${formatClock(startedAt, timeZone)} ` +
    `(moving for 60 s while the log said ${latest!.duty_status.replace("_", " ")}; ${origin === "app" ? "seen by the open app" : "from the phone's position feed"}).`;
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
