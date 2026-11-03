"use client";

// GAP-07 (Fresh-Eyes Register 2026-11-02): registers the service
// worker, flushes the offline outbox whenever connectivity returns
// (and once on mount), and shows a small honest badge while entries
// are still waiting on the device — queued work is never invisible.

import { useEffect, useState } from "react";
import { offlineOutbox } from "@/lib/offline-outbox";

export default function OfflineSupport() {
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // No worker, no harm: the outbox still queues and flushes
        // on the online event below.
      });
    }

    let cancelled = false;
    const refresh = async () => {
      const result = await offlineOutbox.flush().catch(() => null);
      if (!cancelled) setQueued(result ? result.remaining : offlineOutbox.count());
    };
    void refresh();
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    const interval = setInterval(() => setQueued(offlineOutbox.count()), 15_000);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      clearInterval(interval);
    };
  }, []);

  if (queued === 0) return null;
  return (
    <p role="status" className="offline-badge">
      {queued} entr{queued === 1 ? "y" : "ies"} saved on this device — will send when signal returns.
    </p>
  );
}
