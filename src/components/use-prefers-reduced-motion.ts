"use client";

// Combined reduced-motion check for the UI/UX pass components.
// Motion's useReducedMotion is the spec'd hook, but it resolves
// after mount (its first render reports "not reduced"), which would
// flash one animated frame at exactly the users who asked for none.
// This hook seeds from a synchronous matchMedia read on first render
// (guarded: SSR and jsdom-without-matchMedia both fall back to
// Motion's value) and then ORs in Motion's live value, so changes to
// the OS preference mid-session are still honored.

import { useState } from "react";
import { useReducedMotion } from "motion/react";

export function usePrefersReducedMotion(): boolean {
  const [initial] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  const motionReduced = useReducedMotion();
  return initial || motionReduced === true;
}
