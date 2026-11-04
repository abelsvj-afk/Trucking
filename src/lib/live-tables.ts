// The live layer's table set and resource mapping (docs/design/
// driver-hud.md §4). Realtime events are only a "something changed"
// signal: pages re-fetch through the normal company-scoped REST API.
// An event's payload is never rendered, so even a misrouted event can
// at worst cause a harmless re-fetch of the viewer's own data.

/** Tables the app listens to. Each must be in the supabase_realtime publication (migration 00058). */
export const LIVE_TABLES = [
  "duty_logs",
  "loads",
  "expenses",
  "fuel_purchases",
  "maintenance_events",
  "maintenance_schedules",
  "trucks",
  "trailers",
  "drivers",
  "documents",
  "detention_stamps",
] as const;

export type LiveTable = (typeof LIVE_TABLES)[number];

const LIVE_SET = new Set<string>(LIVE_TABLES);

/** The money summary is computed from these. */
export const MONEY_TABLES: LiveTable[] = ["loads", "expenses", "fuel_purchases", "maintenance_events"];

/** "duty-logs" -> "duty_logs"; null when the resource isn't a live table. */
export function tableForResource(resource: string): LiveTable | null {
  const table = resource.replace(/-/g, "_");
  return LIVE_SET.has(table) ? (table as LiveTable) : null;
}

/** "/api/v1/fuel-purchases/abc/restore" -> "fuel_purchases"; null when not a live table. */
export function tableForApiPath(path: string): LiveTable | null {
  const match = /^\/api\/v1\/([a-z-]+)/.exec(path.split("?")[0] ?? "");
  return match ? tableForResource(match[1]!) : null;
}
