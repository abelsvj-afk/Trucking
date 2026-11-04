"use client";

// GAP-08 (Fresh-Eyes Register 2026-11-02): the day-wrap on Home —
// the day's records checked against the day itself, gaps named
// before they cost money (an unlogged fuel stop, a POD never
// photographed, detention owed and unclaimed).

import { useEffect, useState } from "react";
import { DAY_WRAP_TABLES } from "@/lib/live-tables";
import { useLiveVersion } from "@/lib/use-live";

interface DayWrapItem {
  kind: string;
  severity: "gap" | "info" | "ok";
  text: string;
}

export default function DayWrapCard() {
  const [items, setItems] = useState<DayWrapItem[] | null>(null);
  // Live layer: re-derived whenever anything the wrap checks changes,
  // so the card (and its proposal count) is never a stale snapshot.
  const liveVersion = useLiveVersion(DAY_WRAP_TABLES);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/day-wrap")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        // A successful answer with nothing in it clears the card; a
        // failed one keeps the last good wrap rather than blanking it.
        if (!cancelled && body?.data?.items) setItems(body.data.items as DayWrapItem[]);
      })
      .catch(() => {
        // The wrap is a nudge, never a blocker — stay silent offline.
      });
    return () => {
      cancelled = true;
    };
  }, [liveVersion]);

  if (!items || items.length === 0) return null;
  const allOk = items.every((item) => item.severity === "ok");

  return (
    <section aria-label="Day wrap">
      <h2>{allOk ? "Day wrap — clean" : "Day wrap — worth a look"}</h2>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item.severity === "ok" ? `✓ ${item.text}` : item.text}</li>
        ))}
      </ul>
    </section>
  );
}
