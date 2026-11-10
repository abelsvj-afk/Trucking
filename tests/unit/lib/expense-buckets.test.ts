import { describe, expect, it } from "vitest";
import {
  bucketOf,
  deductionReason,
  deductionsForPeriod,
  groupDeductionsByWeek,
  sumDeductions,
} from "@/lib/expense-buckets";
import type { PayTermsRow } from "@/lib/paycheck";

// Sun-Sat pay weeks (pay_week_ends_on 6 = Saturday), statement Thursday,
// payday Friday - the terms shape the pay builders read.
const terms: PayTermsRow[] = [
  {
    employer_name: "Carrier",
    rate_cents_per_mile: 55,
    mile_basis: "all",
    percent_of_load_bps: null,
    pay_week_ends_on: 6,
    statement_weekday: 4,
    payday_weekday: 5,
    effective_from: "2026-01-01",
    effective_to: null,
  } as PayTermsRow,
];

describe("bucketOf", () => {
  it("defaults everything that doesn't say pay_deduction to business", () => {
    expect(bucketOf({})).toBe("business");
    expect(bucketOf({ bucket: null })).toBe("business");
    expect(bucketOf({ bucket: "business" })).toBe("business");
    expect(bucketOf({ bucket: "pay_deduction" })).toBe("pay_deduction");
    expect(bucketOf({ bucket: "nonsense" })).toBe("business");
  });
});

describe("deduction math", () => {
  it("sums and slices by period", () => {
    const rows = [
      { amount_cents: 25000, expense_date: "2026-11-08" },
      { amount_cents: 4000, expense_date: "2026-11-20" },
    ];
    expect(sumDeductions(rows)).toBe(29000);
    expect(deductionsForPeriod(rows, "2026-11-08", "2026-11-14")).toEqual([rows[0]]);
  });

  it("always gives a reason in words", () => {
    expect(deductionReason({ description: "  Mud recovery — truck stuck  " })).toBe("Mud recovery — truck stuck");
    expect(deductionReason({ description: null, category: "repairs" })).toBe("repairs chargeback");
    expect(deductionReason({})).toBe("chargeback from the company");
  });

  it("groups by the pay week containing the expense date, with its payday", () => {
    const weeks = groupDeductionsByWeek(
      [
        { amount_cents: 25000, expense_date: "2026-11-08", description: "Mud recovery" },
        { amount_cents: 1000, expense_date: "2026-11-09", description: null, category: "other" },
      ],
      terms,
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.totalCents).toBe(26000);
    // Sun Nov 8 2026 - Sat Nov 14 2026; Friday payday after week end.
    expect(weeks[0]!.start).toBe("2026-11-08");
    expect(weeks[0]!.end).toBe("2026-11-14");
    expect(weeks[0]!.payday).toBe("2026-11-20");
    expect(weeks[0]!.lines[0]!.reason).toBe("other chargeback");
    expect(weeks[0]!.lines[1]!.reason).toBe("Mud recovery");
  });
});
