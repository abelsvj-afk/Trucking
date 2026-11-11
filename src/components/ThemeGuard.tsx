"use client";

// Theme guard (V78 live-check instability fix, 2026-11-10): the
// pre-paint bootstrap in the root layout applies the resolved theme
// before first paint; this guard re-asserts the SAME resolution once
// hydration lands, so a client whose bootstrap was stale, skipped,
// or whose data-theme attribute was disturbed settles on the correct
// scheme instead of staying on the light base tokens. Resolution is
// read-only (applyStoredTheme never writes storage): with no stored
// pick every load resolves to the shipped dark default; an explicit
// Settings pick always wins; "auto" leaves the OS media query in
// charge. Renders nothing.

import { useEffect } from "react";
import { applyStoredTheme } from "@/lib/theme";

export default function ThemeGuard() {
  useEffect(() => {
    applyStoredTheme();
  }, []);
  return null;
}
