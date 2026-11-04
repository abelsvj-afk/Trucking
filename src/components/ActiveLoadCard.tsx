"use client";

// The active load on Home (owner-operator cockpit): where it goes, when,
// and what it pays - the money line is worded as operational revenue
// recognized on delivery (Unit C), never as cash received. Live via the
// loads table. Quietly absent when there is no confirmed load.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { pickActiveLoad, dateOnlyToNoon } from "@/lib/active-load";
import { formatDate, viewerTimeZone, formatSinceTime } from "@/lib/time";
import { zonedDate } from "@/lib/zoned-day";
import { useNowTick } from "@/lib/use-now-tick";
import type { Load } from "@/types/entities";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const day = (value: string | null) => (value ? formatDate(dateOnlyToNoon(value)) : null);

export default function ActiveLoadCard() {
  const { state } = useApiList<Load>("loads", { status: "confirmed", limit: "50" });
  const nowMs = useNowTick(60_000);
  if (state.status !== "loaded") return null;

  const active = pickActiveLoad(state.result.data, zonedDate(nowMs, viewerTimeZone()));
  if (!active) return null;
  const { load, overdue } = active;

  const pickup = day(load.pickup_date);
  const delivery = day(load.delivery_date);
  const window = load.delivery_window_start
    ? `Delivery window starts ${formatSinceTime(load.delivery_window_start, nowMs)}`
    : null;

  return (
    <section aria-label="Active load" className="active-load">
      <h2>Active load</h2>
      <p className="active-load-route">
        <strong>{load.origin}</strong> → <strong>{load.destination}</strong>
      </p>
      <p className="row-sub">
        {pickup ? `Pickup ${pickup}` : "No pickup date"}
        {delivery ? ` · Delivery ${delivery}` : ""}
        {load.miles ? ` · ${load.miles.toLocaleString()} mi` : ""}
      </p>
      {window && <p className="row-sub">{window}</p>}
      {load.rate_cents !== null && (
        <p className="row-sub">
          Rate {dollars(load.rate_cents)} — operational revenue, counted when delivered (not cash received).
        </p>
      )}
      {overdue && (
        <p role="status" className="hud-note">
          This load&apos;s delivery date has passed and it&apos;s still open. Mark it complete if it delivered.
        </p>
      )}
      <Link href={`/loads/${load.id}`} className="page-action">
        Open load
      </Link>
    </section>
  );
}
