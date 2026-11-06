"use client";

// The tap-a-clock explainer (Block B): what the clock is, what happens at zero, what resets
// it - in plain words for a new driver. Reading only; safe while moving.

import Sheet from "@/components/Sheet";
import { clockExplainer } from "@/lib/clock-explainers";
import type { ClockKey } from "@/lib/hud-clocks";

export default function ClockExplainerSheet({
  clockKey,
  cycleLabel,
  onClose,
}: {
  clockKey: ClockKey;
  cycleLabel: string | null;
  onClose: () => void;
}) {
  const e = clockExplainer(clockKey, cycleLabel);
  return (
    <Sheet title={e.title} onClose={onClose}>
      <div className="hud-explainer">
        <h3>What it is</h3>
        <p>{e.what}</p>
        <h3>At zero</h3>
        <p>{e.atZero}</p>
        <h3>What resets it</h3>
        <p>{e.resets}</p>
        {e.watchOut && (
          <>
            <h3>Watch out</h3>
            <p>{e.watchOut}</p>
          </>
        )}
        <p className="row-sub">
          Based on the common federal rules and on the hours you log here — your carrier&apos;s rules and the truck&apos;s ELD
          are the legal record.
        </p>
      </div>
    </Sheet>
  );
}
