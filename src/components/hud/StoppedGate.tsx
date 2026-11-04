"use client";

// Wraps anything that needs reading or typing (docs/design/driver-hud.md
// §5). Moving: blocked outright. Unknown (no GPS reading): a deliberate
// "I'm parked" confirmation first - the driver's own word, never
// assumed. Stopped: passes straight through.

import { useState, type ReactNode } from "react";
import type { MotionState } from "@/lib/vehicle-motion";

export default function StoppedGate({ motion, children }: { motion: MotionState; children: ReactNode }) {
  const [confirmed, setConfirmed] = useState(false);
  const [seen, setSeen] = useState<MotionState>(motion);
  // Any sighting of movement voids an earlier "I'm parked": after the
  // truck has been rolling, the driver must say it again.
  if (seen !== motion) {
    setSeen(motion);
    if (motion === "moving" && confirmed) setConfirmed(false);
  }

  if (motion === "stopped") return <>{children}</>;

  if (motion === "moving") {
    return (
      <p role="alert" className="hud-note">
        You&apos;re moving. Stop before you change or edit anything — the clocks above keep running.
      </p>
    );
  }

  if (confirmed) return <>{children}</>;
  return (
    <div className="hud-gate">
      <p>I can&apos;t tell whether the truck is stopped (no GPS speed). Only continue if you&apos;re parked.</p>
      <button type="button" onClick={() => setConfirmed(true)}>
        I&apos;m parked
      </button>
    </div>
  );
}
