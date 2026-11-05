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
import { projectPeriod, type PayTerms, type PeriodProjection } from "@/lib/pay-projection";
import type { EmployerPayProfile, Load } from "@/types/entities";

export type PayProjectionState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no-terms" }
  | { status: "ready"; terms: PayTerms; period: PeriodProjection };

export function usePayProjection(): PayProjectionState {
  const version = useLiveVersion(["loads"]);
  const nowMs = useNowTick(60_000);
  const [data, setData] = useState<{ terms: PayTerms | null; loads: Load[] } | "error" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.list<EmployerPayProfile>("pay-profiles"),
      apiClient.list<Load>("loads", { limit: "200" }),
    ])
      .then(([profiles, loads]) => {
        if (cancelled) return;
        const current = profiles.data.filter((p) => !p.effective_to).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
        setData({
          terms: current
            ? { employer_name: current.employer_name, rate_cents_per_mile: current.rate_cents_per_mile, mile_basis: current.mile_basis }
            : null,
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
  if (!data.terms) return { status: "no-terms" };
  return { status: "ready", terms: data.terms, period: projectPeriod(data.terms, data.loads, zonedDate(nowMs, viewerTimeZone())) };
}
