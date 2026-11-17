// The way home (owner 2026-11-17: "a target amount that I want to make for the month before I go home... after
// this load, I'll have enough, and then I can start worrying about getting back to Florida"). Once the monthly goal
// is covered, Abel names the load that covers it and roughly how far home is from where that load ends, so he can
// ask dispatch to route him home. Rough on purpose: straight-line distance plus a road allowance, at a planning
// speed, with the 10-hour rests his hours require - labeled as such, never presented as a route.

import { loadMonthIncome } from "@/services/api/monthly-income";
import { createCachedGeocoder } from "@/services/navigation/geocode-cache";
import { NominatimGeocodingProvider, type GeocodingProvider } from "@/services/integrations/geocoding";
import { haversineMiles } from "@/lib/smart-path";
import { formatMoney } from "@/lib/money-format";
import { formatCalendarDay } from "@/lib/time";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";

const ROAD_FACTOR = 1.2;
const PLANNING_MPH = 55;

/** Rough trip home: road miles and elapsed hours including the 10-hour rests 11-hour driving days need. Pure. */
export function roughTripHome(straightMiles: number): { miles: number; driveHours: number; elapsedHours: number } {
  const miles = Math.round(straightMiles * ROAD_FACTOR);
  const driveHours = miles / PLANNING_MPH;
  const rests = Math.max(0, Math.ceil(driveHours / 11) - 1);
  return { miles, driveHours, elapsedHours: driveHours + rests * 10 };
}

const hoursWords = (h: number) => (h < 1 ? "under an hour" : h < 24 ? `about ${Math.round(h)} h` : `about ${Math.round((h / 24) * 10) / 10} days`);

/** His home base: the owner's "home_base" preference ({ city, state }), or null. */
async function homeBase(store: BotBrainStore): Promise<string | null> {
  const { data, error } = await store.client
    .from("person_preferences")
    .select("value")
    .eq("company_id", store.companyId)
    .eq("subject_type", "owner")
    .eq("key", "home_base")
    .is("deleted_at", null)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const v = (data[0] as { value: { city?: string; state?: string } | null }).value;
  return v && (v.city || v.state) ? [v.city, v.state].filter(Boolean).join(", ") : null;
}

export interface WayHome {
  /** One message, or null when the goal isn't covered yet (or there's no goal). */
  text: string | null;
}

export async function wayHome(store: BotBrainStore, geocoder?: GeocodingProvider): Promise<WayHome> {
  const m = await loadMonthIncome(store.client, store.companyId);
  if (!m.goalCents || !m.goalLoad) return { text: null };
  const head = `🏠 Your ${formatMoney(m.goalCents)} goal for the month is covered after ${m.goalLoad.label} (delivery ${formatCalendarDay(m.goalLoad.deliveryDate)}).`;
  const home = await homeBase(store);
  if (!home) return { text: `${head} Tell me where home is (city and state) and I'll work out the way home from there.` };
  const { data: load } = await store.client.from("loads").select("destination").eq("company_id", store.companyId).eq("id", m.goalLoad.loadId).maybeSingle();
  const from = (load as { destination: string } | null)?.destination ?? null;
  if (!from) return { text: `${head} Ask dispatch to start routing you toward ${home}.` };
  const g = geocoder ?? createCachedGeocoder(store.client, store.companyId, new NominatimGeocodingProvider());
  try {
    const [a, b] = await Promise.all([g.geocode(from), g.geocode(home)]);
    if (!a || !b) return { text: `${head} Ask dispatch to start routing you from ${from} toward ${home}.` };
    const trip = roughTripHome(haversineMiles(a, b));
    return {
      text:
        `${head} From ${from} to ${home} is roughly ${trip.miles.toLocaleString("en-US")} mi - ${hoursWords(trip.elapsedHours)} on the road with the rest your hours need. ` +
        `Good time to ask dispatch to route you home after it. (Rough estimate, not a route.)`,
    };
  } catch {
    return { text: `${head} Ask dispatch to start routing you from ${from} toward ${home}.` };
  }
}

export function buildWayHomeTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "way_home",
      description:
        "When can he head home? Whether his monthly goal is covered, by which load, and roughly how far home is from where that load ends (his home_base preference). Use for 'when can I go home', 'do I have enough to go home', 'how far is home'.",
      parameters: { type: "object", properties: {} },
      access: "read",
      async run() {
        const w = await wayHome(store);
        if (w.text) return w.text;
        const m = await loadMonthIncome(store.client, store.companyId);
        if (!m.goalCents) return "He has no monthly goal set yet - offer to set one (Money → This month in the app).";
        return `Goal ${formatMoney(m.goalCents)} not covered yet: ${formatMoney(m.stillNeededCents ?? 0)} more needed beyond the loads booked this month.`;
      },
    },
  ];
}
