// Drive Mode - end-of-drive review lines and trip persistence. Split out of
// drive.ts (file decomposition, 2026-11-06); behavior unchanged, and drive.ts
// re-exports everything here so existing imports keep working.

import { DRIVE_THRESHOLDS } from "./drive";
import type { DriveStopKind, DrivePlanSnapshot, DriveSession } from "./drive";
import type { RouteCheckResponse } from "@/types/smart-path";

// ---------------------------------------------------------------------------
// End-of-drive review (G-8): three honest lines from stop outcomes
// only - arrived / skipped / missed. Abel owns the coaching record;
// Drive computes and hands over, it stores nothing new.

export function driveReviewLines(
  plan: DrivePlanSnapshot,
  session: DriveSession,
): string[] {
  const lines: string[] = [];
  const outcome = (kind: DriveStopKind) => {
    const indexes = plan.stops
      .map((stop, i) => ({ stop, i }))
      .filter(({ stop }) => stop.kind === kind);
    if (indexes.length === 0) return null;
    if (indexes.every(({ i }) => session.stopStatus[i] === "arrived")) return "arrived";
    if (indexes.some(({ i }) => session.stopStatus[i] === "arrived")) return "partial";
    if (indexes.some(({ i }) => session.stopStatus[i] === "skipped")) return "skipped";
    if (indexes.some(({ i }) => session.stopStatus[i] === "missed")) return "missed";
    return "not reached";
  };
  const sleep = outcome("rest");
  if (sleep) {
    lines.push(
      sleep === "arrived"
        ? "Sleep: you made your planned sleep stop."
        : `Sleep: the planned sleep stop was ${sleep}.`,
    );
  }
  const workout = outcome("workout");
  if (workout) {
    lines.push(
      workout === "arrived"
        ? "Workout: done."
        : `Workout: ${workout === "partial" ? "partly done" : `it was ${workout}`}.`,
    );
  }
  const food = outcome("food");
  if (food) {
    lines.push(
      food === "arrived"
        ? "Food: you stopped for food on this run."
        : `Food: the planned food stop was ${food}.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Persistence: the active plan (set by Plan, read by Home + Drive)
// and the trip checkpoint (G-5). localStorage only - the run must
// survive a killed browser, and nothing here is a server record.

export const ACTIVE_PLAN_STORAGE_KEY = "trucking.smartpath.active-plan.v1";
export const DRIVE_CHECKPOINT_STORAGE_KEY = "trucking.smartpath.drive-checkpoint.v1";
export const DRIVE_MUTED_STORAGE_KEY = "trucking.smartpath.drive-muted.v1";
export const DRIVE_FIRST_RUN_STORAGE_KEY = "trucking.smartpath.drive-first-run-seen.v1";

export interface StoredActivePlan {
  version: 1;
  savedAtMs: number;
  result: RouteCheckResponse;
}

export function serializeActivePlan(result: RouteCheckResponse, savedAtMs: number): string {
  const stored: StoredActivePlan = { version: 1, savedAtMs, result };
  return JSON.stringify(stored);
}

export function parseActivePlan(json: string | null): StoredActivePlan | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StoredActivePlan;
    if (parsed.version !== 1 || !parsed.result?.route || !parsed.result?.load) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface DriveCheckpoint {
  version: 1;
  savedAtMs: number;
  plan: DrivePlanSnapshot;
  session: DriveSession;
}

export function serializeCheckpoint(
  plan: DrivePlanSnapshot,
  session: DriveSession,
  savedAtMs: number,
): string {
  const checkpoint: DriveCheckpoint = { version: 1, savedAtMs, plan, session };
  return JSON.stringify(checkpoint);
}

/** A checkpoint offers Resume only while it's younger than the
 * G-5 12-hour line - an older one is a different day's run. */
export function parseCheckpoint(json: string | null, nowMs: number): DriveCheckpoint | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as DriveCheckpoint;
    if (parsed.version !== 1 || !parsed.plan || !parsed.session) return null;
    if (nowMs - parsed.savedAtMs > DRIVE_THRESHOLDS.checkpointMaxAgeMs) return null;
    if (parsed.session.planKey !== parsed.plan.key) return null;
    return parsed;
  } catch {
    return null;
  }
}
