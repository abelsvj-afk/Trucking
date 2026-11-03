// UH-07 + UH-09 regression tests (union fix round).
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const COMPANY = "22222222-2222-4222-8222-222222222222";

function fakeSupabase(opts: { stampsError: boolean; settlements?: { driver_pay_cents: number; period_end: string }[] | "missing" }) {
  const load = {
    id: "11111111-1111-4111-8111-111111111111", company_id: COMPANY, origin: "A", destination: "B",
    status: "completed", delivery_date: "2026-11-02", pickup_date: "2026-11-01",
    created_at: "2026-11-01T00:00:00Z", deleted_at: null, rate_cents: 100000,
  };
  const results: Record<string, { data: unknown; error: { message: string } | null; count?: number }> = {
    duty_logs: { data: [], error: null },
    fuel_purchases: { data: [], error: null },
    loads: { data: [load], error: null },
    bot_pending_actions: { data: null, error: null, count: 0 },
    credentials: { data: null, error: { message: 'relation "credentials" does not exist' } },
    load_invoices: { data: null, error: { message: 'relation "load_invoices" does not exist' } },
    broker_followups: { data: null, error: { message: 'relation "broker_followups" does not exist' } },
    documents: { data: [], error: null },
    expenses: { data: [], error: null },
    detention_stamps: opts.stampsError
      ? { data: null, error: { message: 'relation "detention_stamps" does not exist' } }
      : { data: [], error: null },
    settlements: opts.settlements === "missing"
      ? { data: null, error: { message: 'relation "settlements" does not exist' } }
      : { data: opts.settlements ?? [], error: null },
  };
  const client = {
    from: (table: string) => {
      const result = results[table] ?? { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "gte", "lt", "lte", "order", "limit", "in", "not"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => void) => resolve(result);
      return builder;
    },
  };
  return client as unknown as SupabaseClient;
}

describe("UH-07: day-wrap tolerates a missing detention_stamps table", () => {
  it("resolves even when a load was delivered that day", async () => {
    const { getDayWrap } = await import("@/services/day-wrap");
    const wrap = await getDayWrap(fakeSupabase({ stampsError: true }), COMPANY, "2026-11-02", new Date("2026-11-02T20:00:00Z"));
    expect(wrap.date).toBe("2026-11-02");
  });
});

describe("UH-09: tax packet joins settlement income", () => {
  it("sums driver pay from settlements ending in the year", async () => {
    const { getTaxPacket } = await import("@/services/tax-filings");
    const packet = await getTaxPacket(
      fakeSupabase({ stampsError: false, settlements: [{ driver_pay_cents: 125000, period_end: "2026-03-31" }, { driver_pay_cents: 75000, period_end: "2026-06-30" }] }),
      COMPANY, 2026,
    );
    expect(packet.settlementIncomeCents).toBe(200000);
    expect(packet.settlementsCount).toBe(2);
    expect(packet.note).toMatch(/included above/);
  });
  it("tolerates a missing settlements table", async () => {
    const { getTaxPacket } = await import("@/services/tax-filings");
    const packet = await getTaxPacket(fakeSupabase({ stampsError: false, settlements: "missing" }), COMPANY, 2026);
    expect(packet.settlementIncomeCents).toBe(0);
  });
});
