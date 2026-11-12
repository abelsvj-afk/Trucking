"use client";

// The load's contribution margin (Unit D, D-02): operational load revenue minus the
// expenses and fuel the owner assigned to THIS load. Never called profit; always shows
// what it leaves out; provisional until the load is delivered.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useLiveVersion } from "@/lib/use-live";
import type { LoadEconomics } from "@/lib/load-economics";
import { formatMoney } from "@/lib/money-format";


export default function LoadEconomicsSection({ loadId }: { loadId: string }) {
  const version = useLiveVersion(["loads", "expenses", "fuel_purchases"]);
  const [data, setData] = useState<LoadEconomics | "error" | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .loadEconomics(loadId)
      .then((res) => !cancelled && setData(res.data))
      .catch(() => !cancelled && setData("error"));
    return () => {
      cancelled = true;
    };
  }, [loadId, version]);

  if (data === null) return null;
  if (data === "error") return <p className="row-sub">Couldn&apos;t load this load&apos;s margin.</p>;
  return (
    <section aria-label="Contribution margin">
      <h2>Contribution margin{data.provisional ? " (provisional)" : ""}</h2>
      {data.contributionMarginCents === null ? (
        <p className="row-sub">{data.caveat}</p>
      ) : (
        <>
          <p>
            <strong>{formatMoney(data.contributionMarginCents)}</strong> = {formatMoney(data.revenueCents ?? 0)} load revenue − {formatMoney(data.directExpensesCents)} expenses on this load −{" "}
            {formatMoney(data.directFuelCents)} fuel assigned to it
          </p>
          {data.provisional && <p className="row-sub">Not delivered yet, so the revenue is still pipeline and this will change.</p>}
          {data.caveat && <p className="row-sub">{data.caveat}</p>}
        </>
      )}
      <p className="row-sub">Leaves out {data.excluded}. Operational revenue, not cash received.</p>
    </section>
  );
}
