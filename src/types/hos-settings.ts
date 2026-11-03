// Shapes for the HOS carrier configuration endpoints (Reliability
// Unit B - docs/reliability-wave1-design-package.md B.5):
// GET/PATCH /api/v1/hos-settings and GET /api/v1/duty-logs/window.
// The settings are carrier-specified values stored per company
// (migration 00042); until the carrier's actual rules are entered,
// the stored values are the labeled PROVISIONAL defaults.

import type { HosCycleSummary } from "@/lib/hos-cycle";

export interface HosSettings {
  hos_cycle: "70/8" | "60/7";
  /** Carrier period anchor, "HH:MM" wall time in the carrier zone. */
  hos_period_anchor: string;
  hos_restart_enabled: boolean;
  /** IANA timezone the anchor is interpreted in. */
  hos_carrier_timezone: string;
}

/** The summary block of GET /api/v1/duty-logs/window (B.2.4/B.3). */
export interface DutyLogWindowSummary {
  cycle: HosCycleSummary["cycle"];
  cycleLimitMinutes: number;
  periodAnchor: string;
  restartEnabled: boolean;
  carrierTimeZone: string;
  /** ISO start of the computed window (counted span start). */
  windowStart: string;
  /** ISO end of the computed window (evaluation instant). */
  windowEnd: string;
  /** ISO start of the current carrier period. */
  currentPeriodStart: string;
  onDutyMinutesInCycle: number;
  restartApplied: { endedAt: string } | null;
  restartUnverified: boolean;
  warnings: string[];
}
