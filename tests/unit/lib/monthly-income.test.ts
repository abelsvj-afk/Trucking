// docs/design/monthly-income-goal.md (owner 2026-11-17). Fictional loads.
import { describe, expect, it } from "vitest";
import { monthIncome, type MonthLoad } from "@/lib/monthly-income";
import type { PayTerms } from "@/lib/pay-projection";

const terms = { employer_name: "Sample Carrier", rate_cents_per_mile: 55, mile_basis: "all", percent_of_load_bps: null } as unknown as PayTerms;
const load = (id: string, delivery: string, miles: number | null, status = "confirmed", trip?: string): MonthLoad =>
  ({ id, origin: "A, OK", destination: "B, FL", status, miles, delivery_date: delivery, pickup_date: delivery, trip_number: trip ?? null }) as MonthLoad;

const run = (loads: MonthLoad[], goal: number | null, today = "2026-11-17") =>
  monthIncome({ month: "2026-11", today, loads, termsFor: () => terms, goalCents: goal });

describe("projected pay for the month", () => {
  it("counts booked and finished loads delivered in the month, in delivery order, with a running total", () => {
    const m = run(
      [load("c", "2026-11-25", 1000), load("a", "2026-11-03", 1000, "completed"), load("b", "2026-11-18", 1000), load("x", "2026-12-01", 1000), load("d", "2026-11-20", 1000, "draft")],
      null,
    );
    expect(m.rows.map((r) => r.loadId)).toEqual(["a", "b", "c"]);
    expect(m.rows.map((r) => r.runningLowCents)).toEqual([55000, 110000, 165000]);
    expect(m).toMatchObject({ earnedLowCents: 55000, bookedLowCents: 110000, totalLowCents: 165000, stillNeededCents: null });
  });

  it("names the load that reaches the goal, and what is still needed", () => {
    const loads = [load("a", "2026-11-03", 1000, "completed"), load("b", "2026-11-18", 1223, "confirmed", "9918"), load("c", "2026-11-25", 500)];
    const m = run(loads, 120000);
    expect(m.goalLoad).toEqual({ loadId: "b", label: "Trip 9918, A, OK → B, FL", deliveryDate: "2026-11-18" });
    expect(m.rows.find((r) => r.loadId === "b")!.reachesGoal).toBe(true);
    expect(m.stillNeededCents).toBe(0);
    const short = run(loads, 300000);
    expect(short.goalLoad).toBeNull();
    expect(short.stillNeededCents).toBe(300000 - 149765);
  });

  it("a load that can't be priced is listed with the reason and never counted as $0", () => {
    const m = run([load("a", "2026-11-03", 1000), load("b", "2026-11-04", null)], 50000);
    expect(m.unpricedCount).toBe(1);
    expect(m.rows[1]!.lowCents).toBeNull();
    expect(m.totalLowCents).toBe(55000);
  });
});
