// GAP-12 (Fresh-Eyes Register 2026-11-02) — receivables aging.
//
// A load's lifecycle used to end at "completed" — which is where
// the money questions start. An invoice ages against its due date
// (the broker's terms, GAP-14, counted from the invoice date);
// status is derived, never stored, so it can never disagree with
// the dates: paid (fully), partial, late, or open.

import type { Load, LoadInvoice } from "@/types/entities";

export type InvoiceStatus = "paid" | "partial" | "late" | "open";

export function invoiceStatus(invoice: Pick<LoadInvoice, "amount_cents" | "paid_amount_cents" | "due_date">, today: string): InvoiceStatus {
  if (invoice.paid_amount_cents >= invoice.amount_cents) return "paid";
  if (today > invoice.due_date) return "late";
  if (invoice.paid_amount_cents > 0) return "partial";
  return "open";
}

export type AgingBucket = "current" | "1-30" | "31-60" | "60+";

export interface AgingSummary {
  buckets: Record<AgingBucket, { count: number; outstandingCents: number }>;
  totalOutstandingCents: number;
  lateCount: number;
  lateOutstandingCents: number;
}

export function agingBucket(daysLate: number): AgingBucket {
  if (daysLate <= 0) return "current";
  if (daysLate <= 30) return "1-30";
  if (daysLate <= 60) return "31-60";
  return "60+";
}

export function summarizeAging(
  invoices: Pick<LoadInvoice, "amount_cents" | "paid_amount_cents" | "due_date">[],
  today: string,
): AgingSummary {
  const buckets: AgingSummary["buckets"] = {
    current: { count: 0, outstandingCents: 0 },
    "1-30": { count: 0, outstandingCents: 0 },
    "31-60": { count: 0, outstandingCents: 0 },
    "60+": { count: 0, outstandingCents: 0 },
  };
  let lateCount = 0;
  let lateOutstandingCents = 0;
  for (const invoice of invoices) {
    const outstanding = invoice.amount_cents - invoice.paid_amount_cents;
    if (outstanding <= 0) continue;
    const daysLate = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_date}T00:00:00Z`)) / 86_400_000,
    );
    const bucket = agingBucket(daysLate);
    buckets[bucket].count += 1;
    buckets[bucket].outstandingCents += outstanding;
    if (daysLate > 0) {
      lateCount += 1;
      lateOutstandingCents += outstanding;
    }
  }
  const totalOutstandingCents = Object.values(buckets).reduce((s, b) => s + b.outstandingCents, 0);
  return { buckets, totalOutstandingCents, lateCount, lateOutstandingCents };
}

/** The invoice the load's own facts propose at closeout (GAP-05). Terms come from the broker (GAP-14); 30 is the labeled fallback when the broker's terms are unknown. */
export function proposeInvoiceFromLoad(
  load: Pick<Load, "id" | "broker_id" | "rate_cents" | "delivery_date">,
  termsDays: number | null,
  invoiceDate: string,
): {
  load_id: string;
  broker_id: string | null;
  invoice_date: string;
  due_date: string;
  amount_cents: number;
  termsDaysUsed: number;
  termsAssumed: boolean;
} | null {
  if (load.rate_cents == null) return null;
  const terms = termsDays ?? 30;
  const due = new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + terms * 86_400_000);
  return {
    load_id: load.id,
    broker_id: load.broker_id,
    invoice_date: invoiceDate,
    due_date: due.toISOString().slice(0, 10),
    amount_cents: load.rate_cents,
    termsDaysUsed: terms,
    termsAssumed: termsDays == null,
  };
}
