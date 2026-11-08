import { describe, expect, it } from "vitest";
import { buildPayTools } from "@/services/bot/pay-tools";

function fakeClient(tables: Record<string, { data?: unknown[]; error?: { message: string } }>) {
  const builder = (table: string) => {
    const result = { data: tables[table]?.data ?? [], error: tables[table]?.error ?? null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "gte", "lte", "lt", "gt"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return b;
  };
  return { from: (t: string) => builder(t) };
}
const tool = (client: unknown) => buildPayTools({ client, companyId: "c", channel: "telegram" } as never).find((t) => t.name === "paychecks_by_payday")!;

describe("paychecks_by_payday (Abel)", () => {
  it("is a read tool", () => {
    expect(tool(fakeClient({})).access).toBe("read");
  });
  it("says plainly that the figure is unavailable when the paycheck picture can't load (never an estimate)", async () => {
    const out = await tool(fakeClient({ cash_advances: { error: { message: "x" } } })).run({});
    expect(out).toContain("couldn't be loaded");
    expect(out).toContain("don't estimate");
  });
  it("says no terms are recorded when there are none", async () => {
    expect(await tool(fakeClient({})).run({})).toContain("No pay terms");
  });
  it("gives the labelled payday figures when there are terms and finished loads", async () => {
    const out = await tool(
      fakeClient({
        employer_pay_profiles: { data: [{ employer_name: "Acme", rate_cents_per_mile: 60, mile_basis: "all", effective_from: "2026-01-01", effective_to: null, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 }] },
        loads: { data: [{ id: "a", origin: "A", destination: "B", status: "completed", miles: 1000, pickup_date: "2026-10-30", delivery_date: "2026-10-31", deleted_at: null }] },
        cash_advances: { data: [{ amount_cents: 25000, advance_date: "2026-10-28", driver_id: null }] },
      }),
    ).run({});
    expect(out).toContain("Expected total: $600.00");
    expect(out).toContain("Advances taken: -$250.00");
    expect(out).toContain("Net expected: $350.00");
    expect(out).toContain("Still owed:");
  });
});
