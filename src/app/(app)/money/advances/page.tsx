"use client";

// Money -> Cash advances: money taken out of a pay period before payday
// (docs/design/employer-pay-profile.md section 9). Recording one here is
// what makes Home's pay preview, Projected pay and Paychecks show the
// NET he should actually receive - expected pay minus these advances,
// week by week against that week's payday.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError, TeachingEmpty } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { usePickerList } from "@/lib/use-picker-list";
import { apiClient, ApiClientError } from "@/lib/api-client";
import ConfirmDialog from "@/components/ConfirmDialog";
import { viewerTimeZone } from "@/lib/time";
import { zonedDate } from "@/lib/zoned-day";
import { formatDay } from "@/lib/pay-projection";
import { groupAdvancesByWeek } from "@/lib/cash-advances";
import type { PayTermsRow } from "@/lib/paycheck";
import type { CashAdvance, Driver, EmployerPayProfile } from "@/types/entities";
import { formatMoney } from "@/lib/money-format";

export default function CashAdvancesPage() {
  usePageTitle("Cash advances");
  const [advances, setAdvances] = useState<CashAdvance[] | null>(null);
  const [terms, setTerms] = useState<PayTermsRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const [amountDollars, setAmountDollars] = useState("");
  const [advanceDate, setAdvanceDate] = useState(() => zonedDate(Date.now(), viewerTimeZone()));
  const [driverId, setDriverId] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const drivers = usePickerList<Driver>("drivers");

  const reload = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.list<CashAdvance>("cash-advances", { limit: "200" }),
      apiClient.list<EmployerPayProfile>("pay-profiles").catch(() => null),
    ])
      .then(([list, profiles]) => {
        if (cancelled) return;
        setAdvances(list.data);
        setTerms(
          (profiles?.data ?? []).map((p) => ({
            employer_name: p.employer_name,
            rate_cents_per_mile: p.rate_cents_per_mile,
            mile_basis: p.mile_basis,
            percent_of_load_bps: p.percent_of_load_bps ?? null,
            pay_week_ends_on: p.pay_week_ends_on ?? null,
            statement_weekday: p.statement_weekday ?? null,
            payday_weekday: p.payday_weekday ?? null,
            effective_from: p.effective_from,
            effective_to: p.effective_to,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await apiClient.create<CashAdvance>("cash-advances", {
        // A fresh idempotency token per record (this form stays open for the next one).
        submission_id: crypto.randomUUID(),
        amount_cents: Math.round(parseFloat(amountDollars || "0") * 100),
        advance_date: advanceDate,
        driver_id: driverId || null,
        note: note || null,
      });
      setAmountDollars("");
      setNote("");
      reload();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Couldn't save that advance. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Money records never delete on one tap: the button asks first (it is kept in the Deleted view, but the pay figures change).
  const [pendingDelete, setPendingDelete] = useState<CashAdvance | null>(null);

  async function handleDelete(advance: CashAdvance) {
    setPendingDelete(null);
    try {
      await apiClient.remove("cash-advances", advance.id);
      reload();
    } catch {
      setFormError("Couldn't delete that advance. Try again.");
    }
  }

  const driverName = (id: string | null) => {
    if (!id) return "Not assigned to a driver";
    return drivers.find((d) => d.id === id)?.name ?? "Driver";
  };
  const weeks = advances ? groupAdvancesByWeek(advances, terms) : [];

  return (
    <div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this cash advance?"
        message={pendingDelete ? `${formatMoney(pendingDelete.amount_cents)} taken ${formatDay(pendingDelete.advance_date)} will stop being taken out of that payday, so the net you should get goes UP by that amount. If it was recorded against the wrong week, delete it and record it with the date you actually took it.` : ""}
        confirmLabel="Delete advance"
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
      <PageHeader
        title="Cash advances"
        purpose="Money you took out of a pay period before payday. These come straight off that week's expected pay, so the net you see on Home and in Paychecks is the net that should land."
      />

      <form onSubmit={handleSubmit}>
        <h2>Took an advance? Put it here</h2>
        <label htmlFor="amount">Amount ($)</label>
        <input
          id="amount"
          type="number"
          step="0.01"
          min="0.01"
          value={amountDollars}
          onChange={(event) => setAmountDollars(event.target.value)}
          required
        />
        <label htmlFor="advance_date">Date taken</label>
        <input
          id="advance_date"
          type="date"
          value={advanceDate}
          onChange={(event) => setAdvanceDate(event.target.value)}
          required
        />
        <label htmlFor="driver_id">Who took it (optional)</label>
        <select id="driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Me / not assigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>
        <label htmlFor="note">Note (optional)</label>
        <input id="note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Fuel advance, Comchek, …" />
        {formError && <p role="alert">{formError}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Record advance"}
        </button>
      </form>

      {advances === null && !loadError && <ListLoading />}
      {loadError && <ListError message="Couldn't load your cash advances." onRetry={reload} />}
      {advances !== null && advances.length === 0 && (
        <TeachingEmpty
          title="No advances recorded"
          message="When you take money out of a pay period early, record it here — your expected pay will show what's left after it, not the gross."
        />
      )}
      {weeks.map((week) => (
        <section key={week.start} aria-label={`Pay week ${week.start}`}>
          <h2>
            Pay week {formatDay(week.start)} to {formatDay(week.end)}
            {week.payday ? ` · comes out of the ${formatDay(week.payday)} payday` : " · payday day not set"}
          </h2>
          <p role="status">
            <strong>{formatMoney(week.totalCents)}</strong> taken out of this week&apos;s pay
          </p>
          <ul>
            {week.advances.map((a) => {
              const advance = a as CashAdvance;
              return (
                <li key={advance.id}>
                  <span className="row-title">{formatMoney(advance.amount_cents)}</span>
                  <span className="row-sub">
                    {formatDay(advance.advance_date)} · {driverName(advance.driver_id)}
                    {advance.note ? ` · ${advance.note}` : ""}
                  </span>{" "}
                  <button type="button" className="button-danger-quiet" onClick={() => setPendingDelete(advance)}>
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="row-sub">
        See the net in <Link href="/money/pay">Driver pay</Link> and <Link href="/money/paychecks">Paychecks</Link>. An advance recorded
        against the wrong week? Delete it and record it with the date you actually took it.
      </p>
    </div>
  );
}
