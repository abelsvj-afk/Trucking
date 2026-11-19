// The Road to Legacy route line: a pulsating golden glow (owner
// 2026-11-18: the plain gold line "is not distinct enough from a
// regular map"). Pure — the map only applies what this returns.
//
// Cheap on a phone by design: the pulse is two paint values on ONE
// line layer (width + opacity), updated at most GLOW_TICK_MS apart
// (~8 times a second) — never every frame, never new geometry. The
// map pauses it while the page is hidden and holds it still when the
// phone asks for reduced motion.

/** One full breath of the glow. */
export const GLOW_PERIOD_MS = 2_000;
/** How often the glow is updated. */
export const GLOW_TICK_MS = 125;

export interface GlowPaint {
  width: number;
  opacity: number;
  blur: number;
}

/**
 * The glow's paint at a moment. Night glows wider and brighter so it
 * reads on dimmed tiles; day keeps it strong enough to stand out from
 * the map's own yellow roads. `still` (reduced motion) holds the peak
 * minus a little — always visible, never pulsing.
 */
export function glowPaintAt(nowMs: number, night: boolean, still = false): GlowPaint {
  const phase = still ? 0.75 : 0.5 - 0.5 * Math.cos(((nowMs % GLOW_PERIOD_MS) / GLOW_PERIOD_MS) * 2 * Math.PI);
  const base = night ? { width: 18, opacity: 0.45 } : { width: 16, opacity: 0.35 };
  const swing = night ? { width: 10, opacity: 0.4 } : { width: 8, opacity: 0.35 };
  return {
    width: Math.round((base.width + swing.width * phase) * 10) / 10,
    opacity: Math.round((base.opacity + swing.opacity * phase) * 100) / 100,
    blur: night ? 8 : 6,
  };
}

/** Gold: the glow's color and the line's own. */
export const GLOW_COLOR = "#f2b705";
