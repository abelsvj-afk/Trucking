// Timezone transitions (owner order 2026-11-11) — the ONE source of
// truth for the DISPLAY ZONE.
//
// The bug it replaces: every Telegram-facing clock was hardcoded to
// America/New_York, two wordings carried no zone label at all, and a
// pending duty proposal from Nov 8 was quoted back to the owner as raw
// UTC. The owner drives across state lines; the bot only spoke Eastern.
//
// Rules, stated once here and nowhere else:
//   1. The display zone is derived from the truck's latest position
//      (Telegram Live Location / Tracker feed). No fresh fix -> home
//      America/New_York. "Fresh" is DISPLAY_ZONE_FRESH_MS below.
//   2. Every user-facing time renders in the display zone with an
//      EXPLICIT short label ("7:40 AM CT", "8:40 AM ET"). Raw UTC never
//      reaches the owner — the standing rule, absolute.
//   3. Delivery/appointment times render in the zone OF THE PLACE
//      (the facility's zone as dispatch wrote it, or the stop's
//      coordinates), not the truck's.
//   4. PAY DATES stay in the HOME zone (America/New_York): pay weeks
//      and paydays are home-terminal dates, not where the truck happens
//      to be. Callers rendering a pay date pass HOME_TIME_ZONE
//      explicitly; see lib/pay-projection.ts.
//   5. HOS clocks count REAL ELAPSED time (lib/hos.ts: millisecond
//      differences over instants). Crossing a zone line never adds or
//      loses an hour; the display zone never enters period math
//      (lib/hos-periods.ts: carrier anchor + carrier zone only).
//
// Labels use the owner's own abbreviations (CT/ET/MT/PT), stable
// across DST — never Intl's seasonal CST/CDT, so "7:40 AM CT" reads
// the same in January and July.

import tzLookup from "tz-lookup";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FALLBACK_TIME_ZONE, isValidTimeZone } from "./time";

/** Home zone: the owner's home terminal. The fallback everywhere. */
export const HOME_TIME_ZONE = FALLBACK_TIME_ZONE;
/** How long a position fix counts as "where the truck is" (24h — a parked truck is still where its last fix says). */
export const DISPLAY_ZONE_FRESH_MS = 24 * 60 * 60 * 1000;

/** The owner's abbreviations, one per US zone the truck can be in. */
const SHORT_LABELS: Record<string, string> = {
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Phoenix": "MT",
  "America/Los_Angeles": "PT",
  "America/Anchorage": "AKT",
  "Pacific/Honolulu": "HT",
};

/** The zone's name in words, for the crossing announcement. */
const LONG_NAMES: Record<string, string> = {
  "America/New_York": "Eastern",
  "America/Chicago": "Central",
  "America/Denver": "Mountain",
  "America/Phoenix": "Mountain",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

/**
 * The IANA zone for a position, from an offline embedded dataset
 * (tz-lookup — no network, no provider). Invalid coordinates fall
 * back to home Eastern rather than throwing: a bad fix must never
 * take a render down with it.
 */
export function timeZoneForPosition(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return HOME_TIME_ZONE;
  }
  try {
    const zone = tzLookup(lat, lng);
    return isValidTimeZone(zone) ? zone : HOME_TIME_ZONE;
  } catch {
    return HOME_TIME_ZONE;
  }
}

/** "CT" for America/Chicago, "ET" for America/New_York, etc. Unknown zones fall back to Intl's short name. */
export function zoneShortLabel(timeZone: string): string {
  const known = SHORT_LABELS[timeZone];
  if (known) return known;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Central" for America/Chicago, "Eastern" for America/New_York, etc. */
export function zoneLongName(timeZone: string): string {
  return LONG_NAMES[timeZone] ?? timeZone;
}

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}

/** "7:40 AM CT" — hour + minute in the zone, always with the label. */
export function formatClock(value: string | number | Date, timeZone: string = HOME_TIME_ZONE): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : HOME_TIME_ZONE;
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(ms)) +
    ` ${zoneShortLabel(zone)}`
  );
}

/** "Nov 12, 2026, 12:00 PM CT" — date + time in the zone, always with the label. */
export function formatDateTime(value: string | number | Date, timeZone: string = HOME_TIME_ZONE): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : HOME_TIME_ZONE;
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms)) + ` ${zoneShortLabel(zone)}`
  );
}

/**
 * A delivery/appointment in the PLACE's zone (rule 3): "Nov 12, 12:00 PM CT"
 * for a Seminole, OK noon. A missing or invalid zone falls back to
 * labeled home time — never an unlabeled render.
 */
export function formatAppointment(iso: string, timeZone: string | null | undefined): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : HOME_TIME_ZONE;
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso)) + ` ${zoneShortLabel(zone)}`
  );
}

export interface PositionFixInput {
  lat: number;
  lng: number;
  atMs: number;
}

export interface DisplayZone {
  timeZone: string;
  label: string;
  /** "position" = derived from a fresh fix; "home" = the fallback. */
  source: "position" | "home";
}

/**
 * The display zone for a latest fix (rule 1). A fresh fix sets the
 * zone to the truck's zone; a stale or missing fix falls back to home.
 * Callers that need the fix from the database use loadDisplayZone.
 */
export function resolveDisplayZone(fix: PositionFixInput | null, nowMs: number): DisplayZone {
  if (fix && Number.isFinite(fix.atMs) && nowMs - fix.atMs <= DISPLAY_ZONE_FRESH_MS) {
    const timeZone = timeZoneForPosition(fix.lat, fix.lng);
    return { timeZone, label: zoneShortLabel(timeZone), source: "position" };
  }
  return { timeZone: HOME_TIME_ZONE, label: zoneShortLabel(HOME_TIME_ZONE), source: "home" };
}

/**
 * The display zone from the latest stored position row (either feed —
 * Telegram Live Location or the Tracker device feed — whichever is
 * newest). Best-effort: any read failure falls back to home rather
 * than failing the turn or the message.
 */
export async function loadDisplayZone(
  client: SupabaseClient,
  companyId: string,
  nowMs: number = Date.now(),
): Promise<DisplayZone> {
  try {
    const { data, error } = await client
      .from("driver_positions")
      .select("lat, lng, recorded_at")
      .eq("company_id", companyId)
      .order("recorded_at", { ascending: false })
      .limit(1);
    if (error || !data || (data as unknown[]).length === 0) return resolveDisplayZone(null, nowMs);
    const row = (data as { lat: number; lng: number; recorded_at: string }[])[0]!;
    return resolveDisplayZone({ lat: row.lat, lng: row.lng, atMs: Date.parse(row.recorded_at) }, nowMs);
  } catch {
    return resolveDisplayZone(null, nowMs);
  }
}

/**
 * The zone-change announcement, said plainly ONCE per crossing:
 * "Crossed into Eastern — times below are ET." Null when the zone
 * did not change — callers send nothing in that case.
 */
export function zoneCrossingNotice(fromZone: string, toZone: string): string | null {
  if (fromZone === toZone) return null;
  return `Crossed into ${zoneLongName(toZone)} — times below are ${zoneShortLabel(toZone)}.`;
}
