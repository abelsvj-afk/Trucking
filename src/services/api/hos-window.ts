// The one server-side HOS read (Reliability Unit B; King review D-1,
// 2026-11-04). Every surface that states his hours - the Hours page,
// Abel's answers and context, the paper-log "cycle picture", Smart
// Path's clocks - reads the SAME data the SAME way:
//   - every non-deleted duty row in the settings-anchored calculation
//     window, ascending (never a newest-N page: that truncation was
//     F-013), failing loudly past the row tripwire;
//   - the cycle from lib/hos-cycle.ts (rolling settings-anchored
//     periods, never a private rolling 8-day sum);
//   - the short-term clocks (11/14/break) from lib/hos.ts, which no
//     longer carries any cycle math of its own (the retired rolling
//     8-day figure used to be filtered out here by string match;
//     there is nothing left to filter).
//
// The cycle is a setting the driver picks himself in Settings ->
// Hours (60 hours / 7 days or 70 hours / 8 days, default 70/8,
// changeable any time). It is never sourced from a carrier: no
// carrier name, DOT/MC number, or carrier rule enters this read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeHos, type HosSummary } from "@/lib/hos";
import { summarizeHosCycle, type HosCycleSummary } from "@/lib/hos-cycle";
import { hosCalculationWindowStartMs, isProvisionalCarrierConfig, type HosCarrierConfig } from "@/lib/hos-periods";
import { loadHosConfig } from "@/services/api/hos-config";
import { ApiError } from "@/services/api/errors";
import type { DutyLog } from "@/types/entities";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

export const HOS_WINDOW_ROW_LIMIT = 5000;

export interface HosWindowSnapshot {
  rows: DutyLog[];
  config: HosCarrierConfig;
  provisional: boolean;
  cycle: HosCycleSummary;
  /** 11/14/break clocks; warnings exclude the superseded rolling 8-day one. */
  short: HosSummary;
}

export async function loadHosWindow(
  client: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
  columns = "*",
): Promise<HosWindowSnapshot> {
  const { config } = await loadHosConfig(client, companyId);
  const windowStart = new Date(hosCalculationWindowStartMs(now.getTime(), config));
  const { data, error } = await client
    .from("duty_logs")
    .select(columns)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .gte("started_at", windowStart.toISOString())
    .order("started_at", { ascending: true })
    .limit(HOS_WINDOW_ROW_LIMIT + 1);
  if (error) {
    throw new ApiError(500, "HOS_WINDOW_UNAVAILABLE", "The HOS duty-log window could not be loaded.");
  }
  const rows = (data ?? []) as unknown as DutyLog[];
  if (rows.length > HOS_WINDOW_ROW_LIMIT) {
    throw new ApiError(
      500,
      "HOS_WINDOW_TOO_LARGE",
      `The HOS window holds more than ${HOS_WINDOW_ROW_LIMIT} duty logs; the summary cannot be computed completely, so nothing is shown rather than a partial total.`,
    );
  }
  return snapshotFromRows(rows, config, now);
}

export function snapshotFromRows(rows: DutyLog[], config: HosCarrierConfig, now: Date): HosWindowSnapshot {
  const rawShort = summarizeHos(rows, now);
  return {
    rows,
    config,
    provisional: isProvisionalCarrierConfig(config),
    cycle: summarizeHosCycle(rows, now, config),
    short: rawShort,
  };
}

export function formatHosMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** One plain line for the cycle, with its basis and any restart labels - the cycle is the driver's own setting, never stated as a carrier fact. */
export function cycleLine(snapshot: HosWindowSnapshot): string {
  const { cycle } = snapshot;
  const left = Math.max(0, cycle.cycleLimitMinutes - cycle.onDutyMinutesInCycle);
  const parts = [
    `${cycle.cycle} cycle (your hours setting: periods start at ${cycle.periodAnchor} ${cycle.carrierTimeZone}${
      snapshot.provisional ? ", PROVISIONAL default settings - pick your own cycle in Settings → Hours" : ""
    }): on duty ${formatHosMinutes(cycle.onDutyMinutesInCycle)} of ${formatHosMinutes(cycle.cycleLimitMinutes)}, ${formatHosMinutes(left)} left.`,
  ];
  if (cycle.restartApplied) parts.push(`A 34-hour restart was applied (ended ${cycle.restartApplied.endedAt}).`);
  if (cycle.restartUnverified) parts.push("A possible 34-hour restart couldn't be verified, so it is NOT counted.");
  return parts.join(" ");
}

/** All warnings for the surface: short-term clocks plus the cycle's own. */
export function hosWarnings(snapshot: HosWindowSnapshot): string[] {
  return [...snapshot.short.warnings, ...snapshot.cycle.warnings];
}

/** The cycle summary every surface shows, in the shape the HUD clocks consume. */
export function toWindowSummary(snapshot: HosWindowSnapshot): DutyLogWindowSummary {
  const { cycle, config } = snapshot;
  return {
    cycle: cycle.cycle,
    cycleLimitMinutes: cycle.cycleLimitMinutes,
    periodAnchor: cycle.periodAnchor,
    restartEnabled: config.restartEnabled,
    carrierTimeZone: cycle.carrierTimeZone,
    windowStart: cycle.windowStart,
    windowEnd: cycle.windowEnd,
    currentPeriodStart: cycle.currentPeriodStart,
    onDutyMinutesInCycle: cycle.onDutyMinutesInCycle,
    restartApplied: cycle.restartApplied,
    restartUnverified: cycle.restartUnverified,
    warnings: cycle.warnings,
  };
}
