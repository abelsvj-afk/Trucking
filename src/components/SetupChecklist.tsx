"use client";

// Home's first-run setup checklist (audit rank 9). Detects completion from real records, links straight to each unfinished task,
// separates ESSENTIAL from optional, and can be dismissed without losing progress (progress is never stored - it is re-detected).
// Hidden once everything is done or the owner dismisses it; a load failure shows nothing rather than a wrong "all done".

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { allDone, buildSetupChecklist, essentialRemaining, type SetupFacts, type SetupItem } from "@/lib/setup-checklist";

const DISMISS_KEY = "setup-checklist-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export default function SetupChecklist() {
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => (typeof window === "undefined" ? true : readDismissed()));

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    Promise.all([
      apiClient.list<SetupFacts["payProfiles"][number]>("pay-profiles", { limit: "50" }),
      apiClient.list<{ height_in: number | null }>("trucks", { limit: "50" }),
      apiClient.list<{ id: string }>("loads", { limit: "1" }),
      apiClient.list<{ id: string }>("drivers", { limit: "1" }),
    ])
      .then(([pay, trucks, loads, drivers]) => {
        if (cancelled) return;
        setItems(
          buildSetupChecklist({
            payProfiles: pay.data,
            truckCount: trucks.data.length,
            truckWithProfileCount: trucks.data.filter((t) => t.height_in != null).length,
            loadCount: loads.data.length,
            driverCount: drivers.data.length,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setItems(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  if (dismissed || !items || allDone(items)) return null;
  const remaining = essentialRemaining(items);
  const open = items.filter((i) => !i.done);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* the checklist simply returns next visit */
    }
    setDismissed(true);
  }

  return (
    <section aria-label="Set up Road to Legacy" className="setup-checklist">
      <h2>Finish setting up</h2>
      <p className="row-sub">
        {remaining > 0 ? `${remaining} essential step${remaining === 1 ? "" : "s"} left — your pay figures are not trustworthy until they are done.` : "Essentials done. The rest are optional."}
      </p>
      <ul>
        {open.map((item) => (
          <li key={item.key}>
            <Link href={item.href}>{item.label}</Link> <span className="row-sub">{item.essential ? "Essential" : "Optional"} — {item.why}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={dismiss}>
        Hide this for now
      </button>
    </section>
  );
}
