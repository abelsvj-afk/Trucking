"use client";

// One HUD ring (docs/design/driver-hud.md §2). The arc is the share of
// the limit still available; the centre is the exact time left,
// ticking each second. Colour shifts amber (<= 2 h) then red (<= 30 min)
// and EXPIRED at zero - all written in words too, never colour alone. Tapping a
// ring opens its plain-language explainer.

import { formatClock, TONE_WORDS, type HudClock } from "@/lib/hud-clocks";

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function spoken(clock: HudClock): string {
  if (clock.tone === "expired" && clock.reset) {
    const m = Math.floor(clock.reset.remainingMs / 60_000);
    return `${clock.label}: EXPIRED. Reset in ${Math.floor(m / 60)} hours ${m % 60} minutes${clock.reset.underway ? "" : " once you stop"}. Driving is locked`;
  }
  const minutes = Math.floor(clock.remainingMs / 60_000);
  const text = `${Math.floor(minutes / 60)} hours ${minutes % 60} minutes remaining`;
  return `${clock.label}: ${text}${TONE_WORDS[clock.tone] ? `. ${TONE_WORDS[clock.tone]}` : ""}`;
}

export default function ClockRing({ clock, onExplain }: { clock: HudClock; onExplain?: (key: HudClock["key"]) => void }) {
  // Expired with a timed reset: the ring shows the RESET filling up (red) until it completes and the clock is green again.
  const reset = clock.tone === "expired" ? clock.reset ?? null : null;
  const fraction = reset
    ? reset.requiredMs > 0 ? Math.min(1, reset.progressMs / reset.requiredMs) : 0
    : clock.totalMs > 0 ? Math.min(1, clock.remainingMs / clock.totalMs) : 0;
  const Tag = onExplain ? "button" : "div";
  return (
    <Tag
      className={`hud-ring hud-tone-${clock.tone}`}
      {...(onExplain
        ? { type: "button" as const, onClick: () => onExplain(clock.key), "aria-label": `${spoken(clock)}. Tap to learn what this clock means.` }
        : { role: "group", "aria-label": spoken(clock) })}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" className="hud-ring-svg">
        <circle cx="50" cy="50" r={RADIUS} className="hud-ring-track" />
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          className="hud-ring-arc"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="hud-ring-time" aria-hidden="true">
        {formatClock(reset ? reset.remainingMs : clock.remainingMs)}
      </span>
      <span className="hud-ring-label" aria-hidden="true">
        {reset ? `${clock.label} — reset` : clock.label}
      </span>
      {TONE_WORDS[clock.tone] && (
        <span className="hud-ring-tone" aria-hidden="true">
          {TONE_WORDS[clock.tone]}
        </span>
      )}
      {reset && (
        <span className="hud-ring-tone" aria-hidden="true">
          {reset.underway ? "Resetting…" : "Starts when you stop"}
        </span>
      )}
      {onExplain && (
        <span className="hud-ring-info" aria-hidden="true">
          ⓘ
        </span>
      )}
    </Tag>
  );
}
