// GAP-14 (Fresh-Eyes Register 2026-11-02) — broker working memory.
//
// The scorecard fills itself from records he already keeps: loads
// run with the broker, invoices and how fast they actually paid
// (GAP-12), detention raised on the broker's loads (GAP-04), and
// the dispatch exchanges now linked to the broker (migration
// 00057). Nothing here is entered twice — it's arithmetic over
// the existing record, surfaced at booking-decision time.

import type { DetentionStamp, Load, LoadInvoice } from "@/types/entities";
import { computeDetention } from "./detention";

export interface BrokerScorecard {
  brokerId: string;
  loadsRun: number;
  revenueCents: number;
  /** Invoices fully paid: average days from invoice date to paid_on (null when none have ever paid). */
  avgDaysToPay: number | null;
  invoicesOpen: number;
  invoicesLate: number;
  outstandingCents: number;
  /** Detention raised on this broker's loads, priced where a rate exists. */
  detentionOwedCents: number;
  detentionUnpricedLoads: number;
  dispatchExchanges: number;
}

export interface BrokerScorecardInput {
  loads: Load[];
  invoices: LoadInvoice[];
  stampsByLoadId: Map<string, DetentionStamp[]>;
  dispatchExchanges: number;
  today: string;
}

export function computeBrokerScorecard(
  brokerId: string,
  input: BrokerScorecardInput,
): BrokerScorecard {
  const loads = input.loads.filter((l) => l.broker_id === brokerId);
  const invoices = input.invoices.filter((i) => i.broker_id === brokerId);

  const paidInvoices = invoices.filter(
    (i) => i.paid_on != null && i.paid_amount_cents >= i.amount_cents,
  );
  const avgDaysToPay =
    paidInvoices.length === 0
      ? null
      : Math.round(
          paidInvoices.reduce(
            (sum, i) =>
              sum +
              (Date.parse(`${i.paid_on!}T00:00:00Z`) - Date.parse(`${i.invoice_date}T00:00:00Z`)) /
                86_400_000,
            0,
          ) / paidInvoices.length,
        );

  let detentionOwedCents = 0;
  let detentionUnpricedLoads = 0;
  for (const load of loads) {
    const stamps = input.stampsByLoadId.get(load.id) ?? [];
    if (stamps.length === 0) continue;
    const summary = computeDetention(load, stamps);
    if (summary.totalBillableHours > 0) {
      if (summary.totalOwedCents != null) detentionOwedCents += summary.totalOwedCents;
      else detentionUnpricedLoads += 1;
    }
  }

  return {
    brokerId,
    loadsRun: loads.length,
    revenueCents: loads.reduce((s, l) => s + (l.rate_cents ?? 0), 0),
    avgDaysToPay,
    invoicesOpen: invoices.filter((i) => i.paid_amount_cents < i.amount_cents).length,
    invoicesLate: invoices.filter(
      (i) => i.paid_amount_cents < i.amount_cents && input.today > i.due_date,
    ).length,
    outstandingCents: invoices.reduce(
      (s, i) => s + Math.max(0, i.amount_cents - i.paid_amount_cents),
      0,
    ),
    detentionOwedCents,
    detentionUnpricedLoads,
    dispatchExchanges: input.dispatchExchanges,
  };
}

export function describeScorecard(
  brokerName: string,
  card: BrokerScorecard,
): string {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const parts = [`${card.loadsRun} load(s) run with ${brokerName}, ${dollars(card.revenueCents)} booked.`];
  parts.push(
    card.avgDaysToPay == null
      ? "No paid invoice history yet."
      : `Pays in ${card.avgDaysToPay} days on average.`,
  );
  if (card.outstandingCents > 0) {
    parts.push(
      `${dollars(card.outstandingCents)} still outstanding${card.invoicesLate > 0 ? `, ${card.invoicesLate} invoice(s) LATE` : ""}.`,
    );
  }
  if (card.detentionOwedCents > 0) {
    parts.push(`Detention raised on their loads: ${dollars(card.detentionOwedCents)} priced.`);
  }
  if (card.detentionUnpricedLoads > 0) {
    parts.push(`Detention time on ${card.detentionUnpricedLoads} load(s) has no rate recorded, so it isn't priced yet.`);
  }
  return parts.join(" ");
}
