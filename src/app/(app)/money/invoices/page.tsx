"use client";

// Receivables (GAP-12; audit decision D-1, 2026-11-05: this feature had an
// API and Abel tools but no screen). What brokers owe, aged against the due
// date in Eastern time: paid / partial / late / open. Status is derived from
// the dates and amounts, never stored. "Mark paid" records the full amount as
// paid TODAY (his tap - nothing is assumed paid). Money is integer cents.

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import { invoiceStatus, summarizeAging } from "@/lib/invoices";
import { todayEastern } from "@/lib/eastern-date";
import type { Load, LoadInvoice } from "@/types/entities";
import { formatMoney } from "@/lib/money-format";

const centsFrom = (text: string): number | null => {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const STATUS_LABEL = { paid: "Paid", partial: "Partly paid", late: "LATE", open: "Open" } as const;

export default function InvoicesPage() {
  usePageTitle("Invoices");
  const { state, retry } = useApiList<LoadInvoice>("load-invoices");
  const loads = usePickerList<Load>("loads");
  const [today] = useState(() => todayEastern());
  const [loadId, setLoadId] = useState("");
  const [amount, setAmount] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, 30));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invoices = state.status === "loaded" ? state.result.data : [];
  const aging = summarizeAging(invoices, today);

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cents = centsFrom(amount);
    if (!loadId) return setError("Pick the load this invoice is for.");
    if (cents === null) return setError("Enter the amount in dollars, for example 1850.00.");
    setBusy(true);
    setError(null);
    try {
      await apiClient.create<LoadInvoice>("load-invoices", {
        load_id: loadId, invoice_date: invoiceDate, due_date: dueDate, amount_cents: cents, paid_amount_cents: 0,
      });
      setAmount("");
      retry();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function markPaid(invoice: LoadInvoice) {
    setError(null);
    try {
      await apiClient.update<LoadInvoice>("load-invoices", invoice.id, { paid_amount_cents: invoice.amount_cents, paid_on: todayEastern() });
      retry();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    }
  }

  return (
    <div>
      <PageHeader title="Invoices" purpose="What brokers owe you, and how late it is — counted from the due date, in Eastern time." />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && (
        <p role="status">
          Outstanding {formatMoney(aging.totalOutstandingCents)}
          {aging.lateCount > 0 ? ` · ${aging.lateCount} late (${formatMoney(aging.lateOutstandingCents)})` : " · nothing late"}
        </p>
      )}
      {state.status === "loaded" && invoices.length === 0 && (
        <TeachingEmpty title="No invoices yet" message="Add an invoice when you bill a load; it then ages against its due date." />
      )}
      {invoices.length > 0 && (
        <ul>
          {[...invoices].sort((a, b) => a.due_date.localeCompare(b.due_date)).map((inv) => {
            const status = invoiceStatus(inv, today);
            return (
              <li key={inv.id}>
                <span className="row-title">{formatMoney(inv.amount_cents)} · {STATUS_LABEL[status]}</span>
                <span className="row-sub">
                  Invoiced {inv.invoice_date} · due {inv.due_date}
                  {inv.paid_amount_cents > 0 ? ` · paid ${formatMoney(inv.paid_amount_cents)}${inv.paid_on ? ` on ${inv.paid_on}` : ""}` : ""}
                </span>
                <span className="row-sub"><Link href={`/loads/${inv.load_id}`}>Open the load</Link></span>
                {status !== "paid" && <button type="button" onClick={() => void markPaid(inv)}>Mark paid today</button>}
              </li>
            );
          })}
        </ul>
      )}

      <form aria-label="Add invoice" onSubmit={handleAdd}>
        <h2>Add an invoice</h2>
        <label htmlFor="inv-load">Load</label>
        <select id="inv-load" value={loadId} onChange={(e) => setLoadId(e.target.value)} required>
          <option value="">Pick a load…</option>
          {loads.map((l) => <option key={l.id} value={l.id}>{l.origin} → {l.destination}{l.pickup_date ? ` (${l.pickup_date})` : ""}</option>)}
        </select>
        <label htmlFor="inv-amount">Amount (dollars)</label>
        <input id="inv-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <label htmlFor="inv-date">Invoice date</label>
        <input id="inv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required />
        <label htmlFor="inv-due">Due date</label>
        <input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Add invoice"}</button>
      </form>
    </div>
  );
}
