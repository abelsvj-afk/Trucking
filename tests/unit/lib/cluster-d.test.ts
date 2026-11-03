// Cluster D libs (GAP-11/12/13/14): watcher ladder, aging,
// obligation projection, broker scorecard math.

import { describe, expect, it } from "vitest";
import { credentialAlerts, daysUntil, describeCredentialAlert } from "@/lib/credentials";
import { invoiceStatus, proposeInvoiceFromLoad, summarizeAging } from "@/lib/invoices";
import { projectObligations } from "@/lib/obligations";
import { computeBrokerScorecard } from "@/lib/broker-scorecard";
import type { Load, LoadInvoice, RecurringObligation } from "@/types/entities";

describe("GAP-11 credentials", () => {
  it("ladders 60/30/7 and expiry, silent beyond 60", () => {
    const alerts = credentialAlerts(
      [
        { label: "CDL", kind: "cdl", expires_on: "2027-06-01" },
        { label: "Med card", kind: "medical_card", expires_on: "2026-11-20" },
        { label: "Insurance", kind: "insurance", expires_on: "2026-10-01" },
      ],
      "2026-11-02",
    );
    expect(alerts.map((a) => a.label)).toEqual(["Insurance", "Med card"]);
    expect(alerts[0]!.level).toBe("expired");
    expect(alerts[1]!.level).toBe("days30");
    expect(describeCredentialAlert(alerts[0]!)).toContain("EXPIRED");
    expect(daysUntil("2026-11-02", "2026-11-09")).toBe(7);
  });
});

describe("GAP-12 invoices", () => {
  const invoice = {
    amount_cents: 300_000,
    paid_amount_cents: 0,
    due_date: "2026-11-01",
  } as LoadInvoice;
  it("derives status from the dates, never a stored flag", () => {
    expect(invoiceStatus(invoice, "2026-10-15")).toBe("open");
    expect(invoiceStatus(invoice, "2026-11-02")).toBe("late");
    expect(invoiceStatus({ ...invoice, paid_amount_cents: 100_000 }, "2026-10-15")).toBe("partial");
    expect(invoiceStatus({ ...invoice, paid_amount_cents: 300_000 }, "2026-11-02")).toBe("paid");
  });
  it("ages only what's outstanding", () => {
    const aging = summarizeAging(
      [invoice, { ...invoice, due_date: "2026-12-01" }, { ...invoice, paid_amount_cents: 300_000 }],
      "2026-11-15",
    );
    expect(aging.lateCount).toBe(1);
    expect(aging.buckets["1-30"].outstandingCents).toBe(300_000);
    expect(aging.buckets.current.outstandingCents).toBe(300_000);
    expect(aging.totalOutstandingCents).toBe(600_000);
  });
  it("proposes an invoice from the load, labeling assumed terms", () => {
    const load = {
      id: "l1",
      broker_id: "b1",
      rate_cents: 390_000,
      delivery_date: "2026-11-02",
    } as Load;
    const withTerms = proposeInvoiceFromLoad(load, 21, "2026-11-03");
    expect(withTerms).toMatchObject({ due_date: "2026-11-24", amount_cents: 390_000, termsAssumed: false });
    const assumed = proposeInvoiceFromLoad(load, null, "2026-11-03");
    expect(assumed).toMatchObject({ due_date: "2026-12-03", termsAssumed: true });
    expect(proposeInvoiceFromLoad({ ...load, rate_cents: null }, 30, "2026-11-03")).toBeNull();
  });
});

describe("GAP-13 obligations", () => {
  const obligation = (overrides: Partial<RecurringObligation>): RecurringObligation =>
    ({
      id: "o1",
      company_id: "c1",
      name: "Phone",
      amount_cents: 9_500,
      cadence: "monthly",
      day_of_month: 12,
      weekday: null,
      anchor_date: null,
      active: true,
      notes: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      ...overrides,
    }) as RecurringObligation;

  it("projects a monthly bill once in 30 days and buckets by week", () => {
    const projection = projectObligations([obligation({})], "2026-11-02", 30);
    expect(projection.occurrences).toHaveLength(1);
    expect(projection.occurrences[0]!.date).toBe("2026-11-12");
    expect(projection.totalCents).toBe(9_500);
    expect(projection.heaviestWeek?.weekStart).toBe("2026-11-09");
  });

  it("projects a weekly bill four-plus times, skipping inactive", () => {
    const weekly = obligation({ id: "o2", name: "Storage", cadence: "weekly", weekday: 5, day_of_month: null });
    const inactive = obligation({ id: "o3", name: "Old sub", active: false });
    const projection = projectObligations([weekly, inactive], "2026-11-02", 30);
    expect(projection.occurrences.every((o) => o.name === "Storage")).toBe(true);
    expect(projection.occurrences.length).toBeGreaterThanOrEqual(4);
    expect(projection.occurrences[0]!.date).toBe("2026-11-06"); // first Friday
  });
});

describe("GAP-14 scorecard", () => {
  it("computes days-to-pay and detention from the records themselves", () => {
    const load = {
      id: "l1",
      broker_id: "b1",
      rate_cents: 200_000,
      detention_free_minutes: 120,
      detention_rate_cents_per_hour: 7_500,
    } as Load;
    const invoice = {
      broker_id: "b1",
      amount_cents: 200_000,
      paid_amount_cents: 200_000,
      invoice_date: "2026-10-01",
      due_date: "2026-10-31",
      paid_on: "2026-10-20",
    } as LoadInvoice;
    const stamps = new Map([
      [
        "l1",
        [
          { stamp_type: "arrival", stop_kind: "delivery", occurred_at: "2026-10-01T10:00:00Z" },
          { stamp_type: "departure", stop_kind: "delivery", occurred_at: "2026-10-01T15:00:00Z" },
        ] as never[],
      ],
    ]);
    const card = computeBrokerScorecard("b1", {
      loads: [load],
      invoices: [invoice],
      stampsByLoadId: stamps,
      dispatchExchanges: 3,
      today: "2026-11-02",
    });
    expect(card.loadsRun).toBe(1);
    expect(card.avgDaysToPay).toBe(19);
    // 5h at the dock - 2h free = 3 billable hours x $75 = $225.
    expect(card.detentionOwedCents).toBe(22_500);
    expect(card.dispatchExchanges).toBe(3);
  });
});
