"use client";

// Decorative, randomly-timed truck-crossing animation, per explicit
// owner request for real motion on the site. Purely cosmetic - fixed
// position, aria-hidden, pointer-events: none - so it can never sit in
// front of or intercept a real interaction. Self-disables under
// prefers-reduced-motion (docs/design/ui-ux.md commits this project to
// WCAG 2.1 AA, which covers motion sensitivity) both here in JS (skips
// scheduling entirely) and again in globals.css's blanket reduced-motion
// override, so a truck can never render for a user who asked for less
// motion even if this component's own check is somehow bypassed.
//
// Mounted once in the root layout so it's visible across every screen,
// login included - it's chrome, not per-page content.

import { useEffect, useRef, useState } from "react";

function randomMs(minSeconds: number, maxSeconds: number) {
  return (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
}

function TruckGlyph() {
  return (
    <svg width="72" height="36" viewBox="0 0 72 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="8" width="38" height="18" rx="2" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.5" />
      <path d="M40 14h11l7 7v5H40z" fill="#2563eb" stroke="#1d4ed8" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M51 16.5h4.5l4 4.5H51z" fill="#eff6ff" />
      <g className="truck-wheel">
        <circle cx="14" cy="28" r="4.5" fill="#0f172a" />
        <circle cx="14" cy="28" r="1.8" fill="#64748b" />
      </g>
      <g className="truck-wheel">
        <circle cx="34" cy="28" r="4.5" fill="#0f172a" />
        <circle cx="34" cy="28" r="1.8" fill="#64748b" />
      </g>
      <g className="truck-wheel">
        <circle cx="55" cy="28" r="4.5" fill="#0f172a" />
        <circle cx="55" cy="28" r="1.8" fill="#64748b" />
      </g>
    </svg>
  );
}

export function TruckCrossing() {
  const [direction, setDirection] = useState<"ltr" | "rtl" | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    timeoutRef.current = setTimeout(() => {
      setDirection(Math.random() < 0.5 ? "ltr" : "rtl");
    }, randomMs(5, 14));

    return () => clearTimeout(timeoutRef.current);
  }, []);

  function handleAnimationEnd() {
    setDirection(null);
    timeoutRef.current = setTimeout(() => {
      setDirection(Math.random() < 0.5 ? "ltr" : "rtl");
    }, randomMs(25, 75));
  }

  if (!direction) return null;

  return (
    <div
      className={`truck-crossing truck-crossing-${direction}`}
      aria-hidden="true"
      onAnimationEnd={handleAnimationEnd}
    >
      <div className={direction === "rtl" ? "truck-flip" : undefined}>
        <TruckGlyph />
      </div>
    </div>
  );
}
