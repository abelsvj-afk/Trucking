// docs/design/confirm-paycheck.md (owner 2026-11-16). Fictional figures.
import { describe, expect, it } from "vitest";
import { applyPaycheckConfirmations, type PaycheckConfirmation } from "@/services/api/paycheck-confirmations";
import { pickPaycheck } from "@/services/bot/paycheck-tools";
import type { PaydayGroup } from "@/services/api/pay-summary";

const group = (over: Partial<PaydayGroup>): PaydayGroup =>
  ({
    payday: "2026-11-13", statement: null, periodStart: "2026-11-02", periodEnd: "2026-11-08", weekStarts: ["2026-11-02"],
    loadCount: 2, unpricedCount: 0, expectedLowCents: 150000, expectedHighCents: 150000, advancesCents: 20000, deductionsCents: 0,
    deductionLines: [], netLowCents: 130000, netHighCents: 130000, receivedCents: 0, stillOwedLowCents: 130000, stillOwedHighCents: 130000,
    shortCount: 0, shortfallCents: 0, unpaidCount: 2, overdue: true, loads: [], taxSetAside: null, ...over,
  }) as PaydayGroup;

const conf = (periodStart: string, cents: number): PaycheckConfirmation => ({
  id: "c1", period_start: periodStart, period_end: "2026-11-08", payday: "2026-11-13", received_cents: cents,
  statement_document_id: null, source: "app", confirmed_at: "2026-11-14T15:00:00Z",
});

describe("confirming a paycheck changes the picture in one place", () => {
  it("the deposit covers the expected take-home: paid - nothing unpaid, short or overdue", () => {
    const [g] = applyPaycheckConfirmations([group({})], [conf("2026-11-02", 130000)]);
    expect(g).toMatchObject({ receivedCents: 130000, unpaidCount: 0, shortCount: 0, shortfallCents: 0, overdue: false, stillOwedLowCents: 0 });
    expect(g!.confirmation).toMatchObject({ receivedCents: 130000 });
  });

  it("a smaller deposit is short by exactly the difference", () => {
    const [g] = applyPaycheckConfirmations([group({})], [conf("2026-11-02", 125050)]);
    expect(g).toMatchObject({ shortCount: 1, shortfallCents: 4950, unpaidCount: 0, overdue: false });
  });

  it("a range: paid when the deposit reaches the low end", () => {
    const [g] = applyPaycheckConfirmations([group({ netLowCents: 120000, netHighCents: 140000 })], [conf("2026-11-02", 120000)]);
    expect(g!.shortCount).toBe(0);
    expect(g!.stillOwedHighCents).toBe(20000);
  });

  it("an unconfirmed paycheck is left exactly as it was", () => {
    const original = group({ periodStart: "2026-11-09" });
    const [g] = applyPaycheckConfirmations([original], [conf("2026-11-02", 130000)]);
    expect(g).toEqual({ ...original, confirmation: null });
  });
});

describe("which paycheck 'I got paid' means", () => {
  const today = "2026-11-16";
  const a = { ...group({ payday: "2026-11-06", periodStart: "2026-10-26", periodEnd: "2026-11-01" }), confirmation: null };
  const b = { ...group({ payday: "2026-11-13" }), confirmation: null };
  const future = { ...group({ payday: "2026-11-20", periodStart: "2026-11-09", periodEnd: "2026-11-15" }), confirmation: null };

  it("the latest one that is due and not confirmed", () => {
    expect(pickPaycheck([future, b, a], undefined, today)?.payday).toBe("2026-11-13");
    const bDone = { ...b, confirmation: { receivedCents: 1, confirmedAt: "x", statementDocumentId: null } };
    expect(pickPaycheck([future, bDone, a], undefined, today)?.payday).toBe("2026-11-06");
  });

  it("a named payday, or a day inside its pay week", () => {
    expect(pickPaycheck([future, b, a], "2026-11-20", today)?.payday).toBe("2026-11-20");
    expect(pickPaycheck([future, b, a], "2026-11-04", today)?.payday).toBe("2026-11-13");
    expect(pickPaycheck([future, b, a], "2026-01-01", today)).toBeNull();
  });
});
