"use client";

// "What's locked" when a clock has expired (owner 2026-11-06): names what you can't legally do, the reset
// counting down to green, why, and what is still allowed. Information only - it never stops him logging the
// truth. Paper-log helper, not an ELD.
//
// UI audit 2026-11-19 ("it needs to not feel cheap"): this was a wall of red paragraphs under the clocks.
// Now the card leads with what matters at a glance - each locked clock and when it comes back - and the
// full explanation (why, what's still allowed) sits one tap away. Nothing was removed.

import { activeLocks, resetLine } from "@/lib/clock-locks";
import { formatClock, type HudClock } from "@/lib/hud-clocks";

/** The glance line: when it comes back, in a few words (the full rule is under "Why"). */
function shortReset(clock: HudClock): string | null {
  const reset = clock.reset;
  if (!reset) return clock.key === "cycle" ? "Comes back as your oldest days drop off" : null;
  if (reset.underway) return `Back in ${formatClock(reset.remainingMs)}`;
  const need = formatClock(reset.requiredMs);
  // The 30-minute break only needs time NOT DRIVING (on-duty work counts) - never say "off" for it.
  if (clock.key === "break") return `Needs ${need} not driving — starts when you stop driving`;
  if (clock.key === "cycle") return `Needs ${need} off duty (the restart) — starts when you stop`;
  return `Needs ${need} off — starts when you stop`;
}

export default function LockedNow({ clocks }: { clocks: HudClock[] }) {
  const locks = activeLocks(clocks);
  if (locks.length === 0) return null;
  return (
    <section aria-label="What is locked" className="hud-locked" role="alert">
      <h3>
        <span aria-hidden="true">🔒 </span>Locked right now: {[...new Set(locks.map((l) => l.locked))].join(", ")}
      </h3>
      <ul className="hud-locked-list">
        {locks.map((l) => {
          const clock = clocks.find((c) => c.key === l.key)!;
          const reset = shortReset(clock);
          return (
            <li key={l.key}>
              <span className="hud-locked-name">{clock.label}</span>
              {reset && <span className="hud-locked-reset">{reset}</span>}
            </li>
          );
        })}
      </ul>
      <details className="hud-locked-more">
        <summary>Why, and what&apos;s still allowed</summary>
        <ul>
          {locks.map((l) => {
            const clock = clocks.find((c) => c.key === l.key)!;
            return (
              <li key={l.key}>
                <strong>{clock.label}:</strong> {l.why} {l.stillAllowed} {resetLine(clock, formatClock)}
              </li>
            );
          })}
        </ul>
        <p className="row-sub">
          This tells you what isn&apos;t legal; it never stops you logging what is really happening. Based on your logged
          hours — your carrier&apos;s rules and the ELD are the legal record.
        </p>
      </details>
    </section>
  );
}
