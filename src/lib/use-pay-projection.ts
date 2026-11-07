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
import type { CashAdvance, EmployerPayProfile, Load } from "@/types/entities";

export type PayProjectionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no-terms" }
  | { status: "ready"; terms: PayTerms; period: PeriodProjection; previous: PeriodProjection; advances: CashAdvance[] };

export function usePayProjection(): PayProjectionState {
  const version = useLiveVersion(["loads"]);
  const nowMs = useNowTick(60_000);
  const [data, setData] = useState<{ rows: PayTermsRow[]; loads: Load[]; advances: CashAdvance[] } | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.list<EmployerPayProfile>("pay-profiles"),
      apiClient.list<Load>("loads", { limit: "200" }),
      // Advances are an add-on to the projection: until migration 00076 is
      // applied (or on any failure) the projection still shows, netting $0.
      apiClient.list<CashAdvance>("cash-advances", { limit: "200" }).catch(() => null),
    ])
      .then(([profiles, loads, advances]) => {
        if (cancelled) return;
        setData({
          advances: advances?.data ?? [],
          rows: profiles.data.map((p) => ({
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
  };
}
