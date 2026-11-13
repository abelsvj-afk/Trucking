"use client";

// Shared by Home's small preview and the Money tab's breakdown: the owner's
// current pay terms + his loads, the projection for the current week
// (Monday-Sunday in the viewer's zone), refreshed when loads change.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useLiveVersion } from "@/lib/use-live";
import { useNowTick } from "@/lib/use-now-tick";
import { viewerTimeZone } from "@/lib/time";
import { zonedDate } from "@/lib/zoned-day";
import { projectPeriod, projectPreviousPeriod, type PayTerms, type PeriodProjection } from "@/lib/pay-projection";
import { termsForDate, type PayTermsRow } from "@/lib/paycheck";
import { bucketOf, type DeductionLike } from "@/lib/expense-buckets";
import type { CashAdvance, EmployerPayProfile, Expense, Load } from "@/types/entities";

export type PayProjectionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no-terms" }
  | {
      status: "ready";
      terms: PayTerms;
      period: PeriodProjection;
      previous: PeriodProjection;
      advances: CashAdvance[];
      /**
       * false when the cash-advances read FAILED: advances is then an empty
       * placeholder and consumers must say the figures don't take advances
       * out - never net against it as if zero were recorded.
       */
      advancesAvailable: boolean;
      /** Pay-deduction expenses (bucket 'pay_deduction') from his expense rows. */
      deductions: (DeductionLike & { category?: string | null })[];
      /** Same honesty rule as advancesAvailable, for the deductions read. */
      deductionsAvailable: boolean;
    };

export function usePayProjection(): PayProjectionState {
  const version = useLiveVersion(["loads"]);
  const nowMs = useNowTick(60_000);
  const [data, setData] = useState<{
    rows: PayTermsRow[];
    loads: Load[];
    advances: CashAdvance[];
    advancesAvailable: boolean;
    deductions: (DeductionLike & { category?: string | null })[];
    deductionsAvailable: boolean;
  } | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.list<EmployerPayProfile>("pay-profiles"),
      apiClient.list<Load>("loads", { limit: "200" }),
      // Migration 00079 is applied, so a failed advances read is a real
      // failure, not a pre-migration state: the projection still shows its
      // gross figures, but the failure travels with the state
      // (advancesAvailable false) instead of silently netting $0.
      apiClient.list<CashAdvance>("cash-advances", { limit: "200" }).then(
        (r) => ({ data: r.data, available: true }),
        () => ({ data: [] as CashAdvance[], available: false }),
      ),
      // Pay deductions ride the expenses list: rows whose bucket says
      // pay_deduction. Pre-00085 rows have no bucket and read as
      // business - "no deductions" is then the truth, not a failure.
      apiClient.list<Expense>("expenses", { limit: "200" }).then(
        (r) => ({
          data: r.data
            .filter((e) => bucketOf(e) === "pay_deduction")
            .map((e) => ({
              amount_cents: e.amount_cents,
              expense_date: e.expense_date,
              description: e.description,
              category: e.category,
              driver_id: e.driver_id,
            })),
          available: true,
        }),
        () => ({ data: [] as (DeductionLike & { category?: string | null })[], available: false }),
      ),
    ])
      .then(([profiles, loads, advances, deductions]) => {
        if (cancelled) return;
        setData({
          advances: advances.data,
          advancesAvailable: advances.available,
          deductions: deductions.data,
          deductionsAvailable: deductions.available,
          rows: profiles.data.map((p) => ({
            employer_name: p.employer_name,
            rate_cents_per_mile: p.rate_cents_per_mile,
            mile_basis: p.mile_basis,
            worker_type: p.worker_type ?? null,
            tax_set_aside_bps: p.tax_set_aside_bps ?? null,
            percent_of_load_bps: p.percent_of_load_bps ?? null,
            pay_week_ends_on: p.pay_week_ends_on ?? null,
            statement_weekday: p.statement_weekday ?? null,
            payday_weekday: p.payday_weekday ?? null,
            effective_from: p.effective_from,
            effective_to: p.effective_to,
          })),
          loads: loads.data,
        });
      })
      .catch(() => {
        if (!cancelled) setData("error");
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (data === null) return { status: "loading" };
  if (data === "error") return { status: "error" };
  if (data.rows.length === 0) return { status: "no-terms" };
  const today = zonedDate(nowMs, viewerTimeZone());
  // The CURRENT terms drive the pay week and payday; each load is priced with the terms in force on its own date.
  const current = termsForDate(data.rows, today)!.terms;
  const options = { termsFor: (load: { delivery_date: string | null; pickup_date: string | null }) => termsForDate(data.rows, load.delivery_date ?? load.pickup_date)!.terms };
  return {
    status: "ready",
    terms: current,
    period: projectPeriod(current, data.loads, today, options),
    previous: projectPreviousPeriod(current, data.loads, today, options),
    advances: data.advances,
    advancesAvailable: data.advancesAvailable,
    deductions: data.deductions,
    deductionsAvailable: data.deductionsAvailable,
  };
}
