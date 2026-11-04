"use client";

// HOS clocks that ride with the route (owner request 2026-11-04: "run
// alongside your route like an ELD"). Compact chips - drive, 14-hour
// window, break, cycle - ticking every second from the same data and the
// same engine as the Home HUD (lib/hud-clocks.ts). Glanceable, read-only,
// no controls: safe on the moving surface. If the clocks can't be
// computed it says so; it never shows a made-up number. Paper-log helper,
// not an ELD - said on the strip.

import { computeHudClocks, formatClock, type ClockTone } from "@/lib/hud-clocks";
import { useHosWindow } from "@/lib/use-hos-window";
import { useNowTick } from "@/lib/use-now-tick";

const TONE_WORD: Record<ClockTone, string> = {
  ok: "",
  warn: " · under 1 h",
  critical: " · under 15 min",
  expired: " · limit reached",
};

const TONE_COLOR_DARK: Record<ClockTone, string> = {
  ok: "#4ade80",
  warn: "#fbbf24",
  critical: "#f87171",
  expired: "#f87171",
};

export default function DriveClocks({ dark = false }: { dark?: boolean }) {
  const { state } = useHosWindow();
  const nowMs = useNowTick(1000);

  if (state.status === "loading") return null;
  if (state.status === "error") {
    return (
      <p role="status" style={{ margin: 0, fontSize: "0.95rem" }}>
        Hours clocks unavailable right now — check them on the ELD.
      </p>
    );
  }
  const clocks = computeHudClocks(state.data, state.hos, nowMs);
  if (clocks.state === "no-logs") {
    return (
      <p role="status" style={{ margin: 0, fontSize: "0.95rem" }}>
        Clocks start when you go on duty.
      </p>
    );
  }
  return (
    <div aria-label="Hours clocks" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
      {clocks.clocks.map((clock) => (
        <p
          key={clock.key}
          aria-label={`${clock.label}: ${formatClock(clock.remainingMs)} remaining${TONE_WORD[clock.tone]}`}
          style={{
            margin: 0,
            padding: "6px 8px",
            borderRadius: "8px",
            border: `2px solid ${dark ? TONE_COLOR_DARK[clock.tone] : "currentColor"}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "6px",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: "0.85rem" }}>
            {clock.label}
          </span>
          <strong aria-hidden="true" style={{ fontSize: "1.2rem", fontVariantNumeric: "tabular-nums" }}>
            {formatClock(clock.remainingMs)}
          </strong>
        </p>
      ))}
      <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: "0.8rem", opacity: 0.8 }}>
        Paper-log helper, not an ELD.
      </p>
    </div>
  );
}
