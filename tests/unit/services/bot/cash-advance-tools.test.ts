// Owner 2026-11-21: "Had two 200 dollar bag advances this pay period" became a $400 confirmation of the
// PREVIOUS paycheck (Nov 20, pay week Nov 8-14). An advance is not a paycheck, and one taken this pay week
// (Sun Nov 15 - Sat Nov 21) comes out of NEXT Friday's check (Nov 27).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terms = vi.hoisted(() => [
  { employer_name: "E", rate_cents_per_mile: 60, mile_basis: "dispatched", pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5, effective_from: "2026-01-01", effective_to: null },
]);
vi.mock("@/services/api/pay-terms", () => ({ fetchPayTerms: async () => terms }));
vi.mock("@/services/api/pay-summary", () => ({
  loadPaySummary: async () => ({
    paydays: [
      { payday: "2026-11-27", periodStart: "2026-11-15", periodEnd: "2026-11-21", loadCount: 2, netLowCents: 11_585, advancesCents: 40_000 },
      { payday: "2026-11-20", periodStart: "2026-11-08", periodEnd: "2026-11-14", loadCount: 2, netLowCents: 51_585, advancesCents: 0 },
    ],
  }),
}));

import { buildCashAdvanceTools } from "@/services/bot/cash-advance-tools";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";

function store() {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (rows: Record<string, unknown>[]) => {
        if (table === "cash_advances") inserted.push(...rows);
        return { error: null };
      },
    }),
  };
  return { s: { client, companyId: "c1" } as unknown as BotBrainStore, inserted };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T18:00:00Z")); // Saturday Nov 21, 1 PM Eastern
});
afterEach(() => vi.useRealTimers());

const ARGS = { advances: [{ amount_dollars: 200 }, { amount_dollars: 200 }] };

describe("record_cash_advance", () => {
  it("two $200 advances this pay week: proposed as two advances out of NEXT Friday's (Nov 27) check, not the Nov 20 one", async () => {
    const [tool] = buildCashAdvanceTools(store().s);
    const v = await tool!.verifyProposal!(ARGS);
    expect(v.ok).toBe(true);
    const summary = (v as { summary: string }).summary;
    expect(summary).toContain("$200.00 on");
    expect(summary).toContain("2 advances, $400.00");
    expect(summary).toMatch(/Nov(ember)? 27/);
    expect(summary).toMatch(/pay week .*Nov(ember)? 15.* to .*Nov(ember)? 21/);
    expect(summary).not.toMatch(/Nov(ember)? 20 paycheck/);
  });

  it("on his yes: two rows in cash_advances, dated today, and the reply says the Nov 27 check now expects about $115.85", async () => {
    const { s, inserted } = store();
    const [tool] = buildCashAdvanceTools(s);
    const reply = await tool!.run(ARGS);
    expect(inserted).toEqual([
      { company_id: "c1", amount_cents: 20_000, advance_date: "2026-11-21", note: null },
      { company_id: "c1", amount_cents: 20_000, advance_date: "2026-11-21", note: null },
    ]);
    expect(reply).toContain("$115.85");
    expect(reply).toMatch(/Nov(ember)? 27/);
  });

  it("an advance dated last week lands in last week's check; a future date or a $0 amount is refused", async () => {
    const [tool] = buildCashAdvanceTools(store().s);
    const v = await tool!.verifyProposal!({ advances: [{ amount_dollars: 150, date: "2026-11-12" }] });
    expect((v as { summary: string }).summary).toMatch(/Nov(ember)? 20/);
    expect(tool!.validateArgs!({ advances: [{ amount_dollars: 100, date: "2026-11-30" }] })).toMatchObject({ ok: false });
    expect(tool!.validateArgs!({ advances: [{ amount_dollars: 0 }] })).toMatchObject({ ok: false });
  });

  it("Abel has the tool, and confirm_paycheck says it is never for advances", () => {
    const tools = buildBotTools(store().s);
    expect(tools.some((t) => t.name === "record_cash_advance")).toBe(true);
    expect(tools.find((t) => t.name === "confirm_paycheck")!.description).toMatch(/NEVER for a cash advance/);
  });
});
