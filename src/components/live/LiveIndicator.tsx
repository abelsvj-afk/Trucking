"use client";

// "Live" shows ONLY while the Realtime channel is actually subscribed.
// Disconnected, it renders nothing - the page still works (it
// re-fetches on open and on focus) but claims nothing it can't prove.

import { useLiveConnected } from "@/lib/use-live";

export default function LiveIndicator() {
  const connected = useLiveConnected();
  if (!connected) return null;
  return (
    <span className="live-indicator" role="status" aria-label="Live: this page updates on its own">
      <span className="live-dot" aria-hidden="true" />
      Live
    </span>
  );
}
