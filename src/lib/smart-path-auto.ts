// Smart Path v2 (docs/design/smart-path-v2.md): what to plan, decided from what the app already knows -
// the load, which stop is next, where the truck is, and the stops' appointments - so the driver types nothing.
// Pure; the service gathers the inputs.

import type { RouteCheckRequest } from "@/data/schemas/smart-path";
import type { LoadStop } from "@/types/entities";

export type AutoPhase = "to_pickup" | "loaded" | "no_position" | "finished";

export interface AutoPrefs {
  food_mode?: "grocery" | "fast_food";
  sleep_start_hour?: number;
  sleep_end_hour?: number;
  workout?: { want: boolean; minutes?: number; setting?: "gym_preferred" | "any_safe_stop" };
}

export interface AutoInputs {
  load: {
    id: string;
    status: string;
    pickup_date: string | null;
    delivery_date: string | null;
    /** The load's recorded appointment windows (dispatch parser writes the stop's parsed end here). */
    pickup_window_start?: string | null;
    pickup_window_end?: string | null;
    delivery_window_start?: string | null;
    delivery_window_end?: string | null;
  };
  stops: LoadStop[];
  /** The stop the active-load builder says is next (its trip-state model), or null. */
  nextStopKind: "pickup" | "delivery" | "other" | null;
  position: { lat: number; lng: number; ageSeconds: number; source: "device" | "server" } | null;
  now: Date;
  departAt?: string | null;
  prefs?: AutoPrefs;
  /** His ELD's clocks, if he entered them (minutes left + when). */
  eldClocks?: RouteCheckRequest["eld_clocks"];
}

export interface AutoPlan {
  phase: AutoPhase;
  request: RouteCheckRequest | null;
  /** What Smart Path assumed, in plain words, shown on the status card. */
  assumptions: string[];
  /** True when the delivery window end was not recorded and appt+2h was used instead — the output says so. */
  deliveryWindowEstimated: boolean;
  /** Age of the position the plan used, in seconds; null when no position exists at all. */
  positionAgeSeconds: number | null;
}

const WINDOW_MS = 2 * 3_600_000;

/**
 * The window the verdict is judged against. The load's recorded window end wins whenever it is recorded
 * (the dispatch parser captures it); only when no end is recorded does the plan fall back to the
 * appointment + 2h — and then it says so, because an invented window end once called an 11 AM arrival
 * LATE against a real 8 AM-4 PM window.
 */
function recordedWindow(
  start: string | null,
  end: string | null,
): { window: { start: string; end: string }; estimated: boolean } | undefined {
  if (!start || !Number.isFinite(Date.parse(start))) return undefined;
  const startMs = Date.parse(start);
  if (end && Number.isFinite(Date.parse(end)) && Date.parse(end) > startMs) {
    return { window: { start: new Date(startMs).toISOString(), end: new Date(Date.parse(end)).toISOString() }, estimated: false };
  }
  return { window: { start: new Date(startMs).toISOString(), end: new Date(startMs + WINDOW_MS).toISOString() }, estimated: true };
}

function ageWords(seconds: number): string {
  if (seconds < 90) return "just now";
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Positions older than this are too old to plan from as "where you are". */
export const MAX_POSITION_AGE_S = 6 * 3600;

export function planAuto(i: AutoInputs): AutoPlan {
  const live = i.stops.filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq);
  if (i.load.status === "completed" || (live.length > 0 && live.every((s) => s.departed_at))) {
    return { phase: "finished", request: null, assumptions: ["This load is finished - pick another load to plan."], deliveryWindowEstimated: false, positionAgeSeconds: i.position?.ageSeconds ?? null };
  }
  const firstPickup = live.find((s) => s.kind === "pickup");
  const lastDelivery = [...live].reverse().find((s) => s.kind === "delivery");
  const departAt = i.departAt && Number.isFinite(Date.parse(i.departAt)) ? new Date(i.departAt).toISOString() : i.now.toISOString();
  const leavingNow = departAt === i.now.toISOString();
  const fresh = i.position && i.position.ageSeconds <= MAX_POSITION_AGE_S ? i.position : null;

  const request: RouteCheckRequest = {
    load_id: i.load.id,
    depart_at: departAt,
    food_mode: i.prefs?.food_mode ?? "grocery",
    ...(i.eldClocks ? { eld_clocks: i.eldClocks } : {}),
  };
  const pickupRecorded = recordedWindow(i.load.pickup_window_start ?? firstPickup?.appointment_at ?? null, i.load.pickup_window_end ?? null);
  const deliveryRecorded = recordedWindow(i.load.delivery_window_start ?? lastDelivery?.appointment_at ?? null, i.load.delivery_window_end ?? null);
  const pickupWindow = pickupRecorded?.window;
  const deliveryWindow = deliveryRecorded?.window;
  const deliveryWindowEstimated = deliveryRecorded?.estimated ?? false;
  const positionAgeSeconds = i.position?.ageSeconds ?? null;
  // An invented window end is an assumption the driver must see, not a silent default.
  const windowNotes: string[] = [];
  if (pickupRecorded?.estimated) windowNotes.push("The pickup window is an estimate - no end time was recorded for this pickup, so I allowed 2 hours from the appointment.");
  if (deliveryRecorded?.estimated) windowNotes.push("The delivery window is an estimate - no end time was recorded for this delivery, so I allowed 2 hours from the appointment.");
  if (deliveryWindow) request.delivery_window = deliveryWindow;
  const life: NonNullable<RouteCheckRequest["life"]> = {};
  if (i.prefs?.sleep_start_hour !== undefined) life.sleep_start_hour = i.prefs.sleep_start_hour;
  if (i.prefs?.sleep_end_hour !== undefined) life.sleep_end_hour = i.prefs.sleep_end_hour;
  if (i.prefs?.workout?.want) {
    life.workout = { want: true, minutes: i.prefs.workout.minutes ?? 60, setting: i.prefs.workout.setting ?? "gym_preferred" };
  }
  if (Object.keys(life).length > 0) request.life = life;

  const assumptions: string[] = [];
  const when = leavingNow ? "leaving now" : "leaving at the time you picked";
  const pickupDone =
    i.nextStopKind === "delivery" || Boolean(firstPickup?.departed_at) || (live.length > 0 && !firstPickup) ? true : false;

  if (!fresh) {
    if (pickupWindow) request.pickup_window = pickupWindow;
    assumptions.push(
      i.position
        ? `Your last known position is from ${ageWords(i.position.ageSeconds)} - too old to plan from, so this plans from the pickup, ${when}.`
        : `No live position from this phone or the Tracker, so this plans from the pickup, ${when}.`,
    );
    assumptions.push(...windowNotes);
    return { phase: "no_position", request, assumptions, deliveryWindowEstimated, positionAgeSeconds };
  }
  request.start_point = { lat: fresh.lat, lng: fresh.lng };
  const from = `from where you are (${fresh.source === "device" ? "this phone" : "the Tracker"}, ${ageWords(fresh.ageSeconds)})`;
  if (pickupDone) {
    request.already_picked_up = true;
    assumptions.push(`Loaded - the pickup is behind you, so this plans ${from} straight to the delivery, ${when}.`);
    assumptions.push(...windowNotes);
    return { phase: "loaded", request, assumptions, deliveryWindowEstimated, positionAgeSeconds };
  }
  if (pickupWindow) request.pickup_window = pickupWindow;
  assumptions.push(`Heading to the pickup - this plans ${from} to the pickup, then the loaded run, ${when}.`);
  assumptions.push(...windowNotes);
  return { phase: "to_pickup", request, assumptions, deliveryWindowEstimated, positionAgeSeconds };
}
