"use client";

// "What's locked" when a clock has expired (owner 2026-11-06): a red panel under the rings that names
// what you can't legally do, why, what is still allowed, and the reset clock counting down to green.
// Information only - it never stops him logging the truth. Paper-log helper, not an ELD.

import { activeLocks, resetLine } from "@/lib/clock-locks";
import { formatClock, type HudClock } from "@/lib/hud-clocks";

export default function LockedNow({ clocks }: { clocks: HudClock[] }) {
  const locks = activeLocks(clocks);
  if (locks.length === 0) return null;
  return (
    <section aria-label="What is locked" className="hud-locked" role="alert">
      <h3>🔒 Locked right now: {[...new Set(locks.map((l) => l.locked))].join(", ")}</h3>
      <ul>
        {locks.map((l) => {
          const clock = clocks.find((c) => c.key === l.key)!;
          return (
            <li key={l.key}>
              <strong>{clock.label}:</strong> {l.why} {l.stillAllowed}
              {resetLine(clock, formatClock) && <div className="hud-locked-reset">{resetLine(clock, formatClock)}</div>}
            </li>
          );
        })}
      </ul>
      <p className="row-sub">
        This tells you what isn&apos;t legal; it never stops you logging what is really happening. Based on your logged
        hours — your carrier&apos;s rules and the ELD are the legal record.
      </p>
    </section>
  );
}
