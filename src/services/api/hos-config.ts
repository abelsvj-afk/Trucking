// Shared loader for a company's HOS carrier configuration
// (Reliability Unit B - design B.2.5/B.5), used by both the
// hos-settings route and the duty-log window route so the settings a
// driver edits and the configuration the engine computes with can
// never diverge.
//
// Columns live on companies (migration 00042). Reads tolerate the
// pre-migration state: if Postgres reports the columns do not exist
// yet (42703), the owner-approved PROVISIONAL defaults stand in - the
// same values the migration itself defaults to - so the HOS surface
// keeps working, labeled provisional, instead of failing. Any other
// read failure is explicit: a silently-assumed configuration is
// exactly the failure mode F-015 names.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeHosCarrierConfig,
  PROVISIONAL_HOS_CONFIG,
  type HosCarrierConfig,
} from "@/lib/hos-periods";
import type { HosSettings } from "@/types/hos-settings";
import { ApiError } from "./errors";

export interface LoadedHosConfig {
  /** DB-shaped settings for API responses. */
  settings: HosSettings;
  /** Engine-shaped configuration for the cycle engine. */
  config: HosCarrierConfig;
}

export function hosSettingsFromConfig(config: HosCarrierConfig): HosSettings {
  return {
    hos_cycle: config.cycle,
    hos_period_anchor: config.periodAnchor,
    hos_restart_enabled: config.restartEnabled,
    hos_carrier_timezone: config.carrierTimeZone,
  };
}

export const PROVISIONAL_HOS_SETTINGS: HosSettings = hosSettingsFromConfig(PROVISIONAL_HOS_CONFIG);

const HOS_COLUMNS = "hos_cycle, hos_period_anchor, hos_restart_enabled, hos_carrier_timezone";

export async function loadHosConfig(
  supabase: SupabaseClient,
  companyId: string,
): Promise<LoadedHosConfig> {
  const { data, error } = await supabase
    .from("companies")
    .select(HOS_COLUMNS)
    .eq("id", companyId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === "42703") {
      // Migration 00042 not applied yet: provisional defaults stand in.
      return { settings: PROVISIONAL_HOS_SETTINGS, config: PROVISIONAL_HOS_CONFIG };
    }
    throw new ApiError(
      500,
      "HOS_CONFIG_UNAVAILABLE",
      "The carrier HOS configuration could not be loaded.",
    );
  }

  const row = (data ?? {}) as Partial<Record<keyof HosSettings, unknown>>;
  const config = normalizeHosCarrierConfig({
    cycle: row.hos_cycle,
    periodAnchor: row.hos_period_anchor,
    restartEnabled: row.hos_restart_enabled,
    carrierTimeZone: row.hos_carrier_timezone,
  });
  return { settings: hosSettingsFromConfig(config), config };
}
