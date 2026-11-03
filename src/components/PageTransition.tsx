"use client";

// Page transition for the (app) shell — motion mini-spec rule 1
// (Trucking-Design-Resources-GitHub-2026-11-02.md): route changes
// crossfade + 4px rise over 240ms on the spec ease-out curve; tab
// switches crossfade in place (the bottom nav itself never moves, and
// nothing ever slides sideways).
//
// VIEW TRANSITIONS INVESTIGATION (Next 16.3 / React 19.2, this tree):
// The platform path is next.config `experimental.viewTransition: true`
// + React's <ViewTransition>. On THIS tree it does not hold up:
// - the installed react@19.2.8 (stable) exports no ViewTransition at
//   runtime (verified: Object.keys(require('react')) has none), and
// - @types/react exposes ViewTransition only from its canary entry
//   (canary.d.ts, behind @enableViewTransition) — importing it from
//   "react" fails typecheck with TS2305 (verified with a probe file).
// Next's compiled react-experimental does carry the component, but
// adopting it means swapping the whole app onto the experimental
// React build + canary types for one crossfade — not a safe trade for
// a production build. Per the pass brief's fallback clause, this ships
// the minimal working variant instead:
// - Motion animates the shell content on route change (below), and
// - globals.css (Crew B appended section) carries the
//   ::view-transition-old/new(root) rules, so IF the experimental flag
//   is ever enabled the browser-native root transition matches this
//   exact spec (crossfade + 4px rise, 240ms, spec ease-out). They are
//   inert until then — plain progressive enhancement.
// Every View Transitions API touch is therefore either pure CSS or
// absent: no JS here calls document.startViewTransition, so browsers
// without it — and jsdom, and reduced-motion users — get instant,
// unanimated navigation.

import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";
import type { ReactNode } from "react";

// The Drive surface is a glance surface: no decorative transition of
// any kind, ever (audit F-5 / mini-spec rule 6 — nothing moves in
// Drive Mode except the surface's own state changes).
export function isDriveSurface(pathname: string | null | undefined): boolean {
  return pathname?.startsWith("/smart-path/drive") ?? false;
}

export default function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduceMotion = usePrefersReducedMotion();

  // Drive exclusion + reduced motion: render the page exactly as-is —
  // instant navigation, no wrapper animation.
  if (isDriveSurface(pathname) || reduceMotion) {
    return <>{children}</>;
  }

  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
