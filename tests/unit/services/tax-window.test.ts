import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getIftaWorksheet, getTaxPacket } from "@/services/tax-filings";

// KR-2 (King review of the steps 3–5 stack): the house pattern for
// timestamped records is a generous UTC fetch window bucketed by
// America/New_York calendar date in code (services/day-wrap.ts).
// tax-filings fetched fuel with EXACT UTC quarter/year bounds while
// lib/ifta buckets by ET date — so a purchase in the ET evening of
// the period's last day (UTC timestamp already in the next period)
// was never fetched: it vanished from the IFTA worksheet entirely
// and landed in the wrong year of the tax packet. This fake honors
// gte/lte bounds the way Postgres would, so the window itself is
// under test.
const COMPANY = "22222222-2222-4222-8222-222222222222";

// 2026-12-31 20:30 EST = 2027-01-01T01:30:00Z — ET date in Q4/2026.
const EVENING_PURCHASE = {
  id: "e1", company_id: COMPANY, purchased_at: "2027-01-01T01:30:00.000Z",
  gallons: 50, state: "FL", total_cost_cents: 17500, deleted_at: null,
};
const MID_PURCHASE = {
  id: "e2", company_id: COMPANY, purchased_at: "2026-11-15T15:00:00.000Z",
  gallons: 40, state: "GA", total_cost_cents: 14000, deleted_at: null,
};
// ET date 2027-01-02 — must NOT land in Q4/2026 even if fetched.
const NEXT_YEAR_PURCHASE = {
  id: "e3", company_id: COMPANY, purchased_at: "2027-01-02T17:00:00.000Z",
  gallons: 99, state: "FL", total_cost_cents: 9900, deleted_at: null,
};

function boundAwareFake() {
  const tables: Record<string, Record<string, unknown>[]> = {
    fuel_purchases: [EVENING_PURCHASE, MID_PURCHASE, NEXT_YEAR_PURCHASE],
    loads: [],
    duty_logs: [],
    expenses: [],
    settlements: [],
  };
  const client = {
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      const builder: Record<string, unknown> = {};
      const range = (col: string, v: unknown, keep: (a: string, b: string) => boolean) => {
        rows = rows.filter((r) => typeof r[col] === "string" && keep(r[col] as string, String(v)));
        return builder;
      };
      builder.select = () => builder;
      builder.eq = (col: string, v: unknown) => {
        rows = rows.filter((r) => r[col] === v);
        return builder;
      };
      builder.is = () => builder;
      builder.gte = (col: string, v: unknown) => range(col, v, (a, b) => a >= b);
      builder.gt = (col: string, v: unknown) => range(col, v, (a, b) => a > b);
      builder.lte = (col: string, v: unknown) => range(col, v, (a, b) => a <= b);
      builder.lt = (col: string, v: unknown) => range(col, v, (a, b) => a < b);
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: rows, error: null, count: rows.length });
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

describe("IFTA worksheet fuel window (ET bucketing)", () => {
  it("includes an ET-evening purchase on the quarter's last day", async () => {
    const ws = await getIftaWorksheet(boundAwareFake(), COMPANY, "2026Q4");
    expect(ws.totalGallons).toBe(90); // 50 evening + 40 mid; NOT the 99 from Jan 2 ET
    expect(ws.gallonsByState.FL).toBe(50);
  });
});

describe("tax packet fuel year (ET bucketing)", () => {
  it("counts an ET-evening Dec 31 purchase in that year, not the next", async () => {
    const packet = await getTaxPacket(boundAwareFake(), COMPANY, 2026);
    expect(packet.fuel.purchases).toBe(2);
    expect(packet.fuel.totalCostCents).toBe(31500);
  });
});
