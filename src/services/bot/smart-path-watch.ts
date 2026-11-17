// Smart Path doesn't wait to be opened (owner 2026-11-17: "Smart Path shouldn't wait on me, and Abel should use
// it"). Once an hour, while a load is active, the SAME automatic planner the page uses re-plans the run from the
// truck's latest position and his hours; when the answer turns LATE or NOT LEGAL - or comes back to on time
// after that - Abel says so once, with why. Delivered through the reminder scheduler (routine: quiet hours hold
// it; reminder_sends makes each alert once-only). Planning only, not the ELD.

import type { BotBrainStore } from "./store";
import type { Reminder } from "@/lib/reminders";
import { runAutoSmartPath, type AutoRunResult } from "@/services/smart-path/auto";
import { hoursLine } from "@/lib/smart-path-summary";

export const WATCH_EVERY_MS = 60 * 60_000;
const lastRun = new Map<string, number>();
/** A position older than this is too stale to call a verdict on (matches MAX_START_AGE_MS). */
export const STALE_POSITION_S = 60 * 60;

const WORD: Record<string, string> = { on_time: "ON TIME", early: "EARLY", late: "LATE", not_legal: "NOT LEGAL AS PLANNED" };
const BAD = new Set(["late", "not_legal"]);

function ageWords(seconds: number): string {
  if (seconds < 90) return "just now";
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * Trust-gate for the verdict (owner 2026-11-17: Abel kept declaring LATE on wrong inputs and never said
 * which input was shaky). A verdict is UNCERTAIN — never LATE, never "back on time" — when any input it
 * rests on is shaky, and each shaky input is named in plain words:
 *   - the duty log: the plan ran on the app's log and the log says he is (nearly) out of driving or
 *     shift time, so the plan starts with a 10-hour rest — the exact signature of a log that is behind;
 *   - the position: no live fix, or the last fix is over an hour old;
 *   - the pickup: the routing assumes the pickup is done without a departed_at mark.
 * There is no "log flagged wrong" field anywhere in the app, so the duty-log leg uses the checkable
 * signal the engine already has (app-log clocks, nearly exhausted); ELD-entered hours are trusted.
 */
export function verdictTrust(out: AutoRunResult): { uncertain: boolean; reasons: string[] } {
  const r = out.result;
  if (!r || !out.load) return { uncertain: false, reasons: [] };
  const reasons: string[] = [];
  const hours = hoursLine(r);
  if (hours?.fromAppLog && hours.tight) {
    reasons.push("your hours log says you're nearly out of driving or shift time, so the plan starts with a 10-hour rest — if the log is behind, this call is a guess");
  }
  if (out.phase === "no_position") {
    reasons.push("there is no live position from this phone or the Tracker, so the plan starts from the pickup");
  } else if (out.positionAgeSeconds != null && out.positionAgeSeconds > STALE_POSITION_S) {
    reasons.push(`your last position is ${ageWords(out.positionAgeSeconds)} old`);
  }
  if (out.pickupUnconfirmed) {
    // Short here — the full trip-state basis rides in the alert's "why" line (Fix C).
    reasons.push("I can't confirm you left the pickup yet");
  }
  return { uncertain: reasons.length > 0, reasons };
}

/** The alert for this plan, or null when there is nothing to say. Pure; the dedupe key makes it once-only. */
export function watchAlert(out: AutoRunResult, appUrl: string | null): Reminder | null {
  const r = out.result;
  if (!r || !out.load) return null;
  const status = r.verdict.status;
  // Fix C: when the pickup was never confirmed left, the "why" carries the trip-state basis in plain
  // words instead of only the tradeoff line.
  const why = [r.verdict.tradeoffLines[0] ?? r.verdict.legalLines[0] ?? "", out.pickupUnconfirmed ? (out.pickupUnknownBasis ?? "") : ""]
    .filter(Boolean)
    .join(" ");
  const hours = hoursLine(r);
  const link = appUrl ? ` Open Smart Path: ${appUrl.replace(/\/+$/, "")}/smart-path` : "";
  const trust = verdictTrust(out);
  if (BAD.has(status)) {
    // Fix B: never declare LATE on shaky inputs. Say the verdict is uncertain, name the shaky input,
    // and use a separate dedupe key so the real LATE alert can still fire once the inputs are solid.
    if (trust.uncertain) {
      return {
        kind: "checkin",
        key: `smartpath:${out.load.id}:uncertain`,
        critical: false,
        text:
          `❓ Smart Path: ${out.load.label} — I can't call this late yet. ${trust.reasons.map((s) => s.replace(/\.+$/, "")).join("; ")}.` +
          (why ? ` ${why}` : "") +
          (hours ? `\n${hours.text}` : "") +
          link +
          "\n(Planning only - not your ELD.)",
      };
    }
    return {
      kind: "checkin",
      key: `smartpath:${out.load.id}:${status}`,
      critical: false,
      text:
        `⚠️ Smart Path: ${out.load.label} is now ${WORD[status]}. ${why}` +
        (hours ? `\n${hours.text}` : "") +
        (hours?.fromAppLog && hours.tight ? "\nIf your log is behind, tell me what you actually did and I'll fix it." : "") +
        link +
        "\n(Planning only - not your ELD.)",
    };
  }
  // "Back on time" stays as-is when the inputs are solid; on shaky inputs say nothing — a recovery
  // declared on a guess is as wrong as a late call on one.
  if (trust.uncertain) return null;
  return {
    kind: "checkin",
    key: `smartpath:${out.load.id}:ok`,
    critical: false,
    text: `✅ Smart Path: ${out.load.label} is back ${WORD[status] ?? "on time"}. ${why}${link}`,
  };
}

/**
 * Runs the planner at most once an hour per company. Returns the alert to send, or null. The "back on time" alert
 * only goes out when a bad-status alert for this load was already sent (checked by the caller's dedupe table).
 */
export async function planSmartPathWatch(
  store: BotBrainStore,
  now: Date,
  wasWarned: (loadId: string) => Promise<boolean>,
  appUrl: string | null,
): Promise<Reminder | null> {
  const last = lastRun.get(store.companyId);
  if (last !== undefined && now.getTime() - last < WATCH_EVERY_MS) return null;
  lastRun.set(store.companyId, now.getTime());
  const out = await runAutoSmartPath(store.client, store.companyId, {}, now);
  const alert = watchAlert(out, appUrl);
  if (!alert || !out.load) return null;
  if (alert.key.endsWith(":ok") && !(await wasWarned(out.load.id))) return null;
  return alert;
}

/** For tests: forget the hourly throttle. */
export function resetSmartPathWatch(): void {
  lastRun.clear();
}
