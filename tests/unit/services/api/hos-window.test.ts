import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleLine, hosWarnings, loadHosWindow, snapshotFromRows, HOS_WINDOW_ROW_LIMIT } from "@/services/api/hos-window";
import { PROVISIONAL_HOS_CONFIG } from "@/lib/hos-cycle";
import type { DutyLog } from "@/types/entities";

const H = 3_600_000;
const NOW = new Date("2026-11-04T15:00:00Z");
const row = (id: string, duty_status: DutyLog["duty_status"], ms: number) =>
  ({ id, duty_status, started_at: new Date(ms).toISOString() }) as DutyLog;

function fakeClient(rows: unknown[], company: Record<string, unknown> | null = null) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const query = (table: string) => {
    const rec = { table, filters: [] as [string, unknown][] };
    calls.push(rec);
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (rec.filters.push([c, v]), q),
      is: () => q,
      gte: (c: string, v: unknown) => (rec.filters.push([c, v]), q),
      order: () => q,
      limit: () => q,
      single: async () => ({ data: company, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: rows, error: null }),
    };
    return q;
  };
  return { client: { from: query } as unknown as SupabaseClient, calls };
}

describe("hos-window", () => {
  it("reads the company's full carrier window and computes the carrier cycle", async () => {
    const rows = [row("a", "off_duty", NOW.getTime() - 40 * H), row("b", "driving", NOW.getTime() - 5 * H)];
    const { client, calls } = fakeClient(rows);
    const snap = await loadHosWindow(client, "co-1", NOW);
    const duty = calls.find((c) => c.table === "duty_logs")!;
    expect(duty.filters).toContainEqual(["company_id", "co-1"]);
    expect(duty.filters.some(([c]) => c === "started_at")).toBe(true);
    expect(snap.provisional).toBe(true);
    expect(snap.cycle.onDutyMinutesInCycle).toBe(300);
    expect(cycleLine(snap)).toContain("70/8 cycle");
    expect(cycleLine(snap)).toContain("PROVISIONAL");
    expect(cycleLine(snap)).toContain("on duty 5h 00m of 70h 00m, 65h 00m left");
  });

  it("fails loudly past the row tripwire instead of computing from a truncated window", async () => {
    const many = Array.from({ length: HOS_WINDOW_ROW_LIMIT + 1 }, (_, i) => row(`r${i}`, "on_duty", NOW.getTime() - i * 60_000));
    const { client } = fakeClient(many);
    await expect(loadHosWindow(client, "co-1", NOW)).rejects.toThrow(/cannot be computed completely/);
  });

  it("uses the carrier's own settings when they're set, and stops saying provisional", async () => {
    const { client } = fakeClient([row("a", "driving", NOW.getTime() - H)], {
      hos_cycle: "60/7",
      hos_period_anchor: "06:00",
      hos_restart_enabled: true,
      hos_carrier_timezone: "America/Chicago",
    });
    const snap = await loadHosWindow(client, "co-1", NOW);
    expect(snap.provisional).toBe(false);
    expect(cycleLine(snap)).toContain("60/7 cycle (carrier-anchored at 06:00 America/Chicago)");
    expect(cycleLine(snap)).not.toContain("PROVISIONAL");
  });

  it("never states the superseded rolling 8-day warning", () => {
    // 75h on duty across the last 8 days, all inside one cycle.
    const rows: DutyLog[] = [];
    for (let d = 7; d >= 1; d--) {
      rows.push(row(`d${d}`, "driving", NOW.getTime() - d * 24 * H));
      rows.push(row(`o${d}`, "off_duty", NOW.getTime() - d * 24 * H + 11 * H));
    }
    const snap = snapshotFromRows(rows, PROVISIONAL_HOS_CONFIG, NOW);
    expect(hosWarnings(snap).some((w) => w.includes("8-day"))).toBe(false);
    expect(snap.cycle.onDutyMinutesInCycle).toBeGreaterThan(70 * 60);
    expect(hosWarnings(snap).some((w) => w.includes("70/8 on-duty limit reached"))).toBe(true);
  });
});
