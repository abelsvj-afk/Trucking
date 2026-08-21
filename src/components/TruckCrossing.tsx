"use client";

// Decorative, randomly-timed truck-crossing animation, per explicit
// owner request for real motion on the site - including a request for
// a road/terrain under the truck (not floating in empty space) and more
// natural movement, not just a straight-line slide. Purely cosmetic -
// fixed position, aria-hidden, pointer-events: none - so it can never
// sit in front of or intercept a real interaction. Self-disables under
// prefers-reduced-motion both here in JS (skips scheduling entirely)
// and again in globals.css's blanket reduced-motion override, matching
// this project's WCAG 2.1 AA commitment (docs/design/ui-ux.md).
//
// Mounted once in the root layout so it's visible across every screen,
// login included - it's chrome, not per-page content.

import { useEffect, useRef, useState, type CSSProperties } from "react";

type Terrain = "plain" | "hills" | "skyline";
const TERRAINS: Terrain[] = ["plain", "hills", "skyline"];

function randomMs(minSeconds: number, maxSeconds: number) {
  return (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
}

function randomTerrain(): Terrain {
  return TERRAINS[Math.floor(Math.random() * TERRAINS.length)] ?? "plain";
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

// Distant, low-opacity horizon silhouettes the truck drives past - three
// variants so consecutive crossings don't all look identical. "plain"
// (no extra silhouette, just the road) is deliberately in the rotation
// too, so hills/skyline read as a occasional change of scenery rather
// than permanent clutter behind every single crossing.
function TerrainBand({ variant }: { variant: Terrain }) {
  if (variant === "plain") return null;

  if (variant === "hills") {
    return (
      <svg
        className="truck-terrain"
        width="100%"
        height="56"
        viewBox="0 0 400 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M0,40 Q50,14 100,34 T200,28 T300,38 T400,20 L400,56 L0,56 Z"
          fill="#94a3b8"
          fillOpacity="0.22"
        />
      </svg>
    );
  }

  return (
    <svg
      className="truck-terrain"
      width="100%"
      height="56"
      viewBox="0 0 400 56"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g fill="#64748b" fillOpacity="0.2">
        <rect x="10" y="18" width="16" height="38" />
        <rect x="34" y="8" width="12" height="48" />
        <rect x="54" y="24" width="18" height="32" />
        <rect x="90" y="2" width="14" height="54" />
        <rect x="118" y="20" width="16" height="36" />
        <rect x="150" y="12" width="20" height="44" />
        <rect x="190" y="26" width="14" height="30" />
        <rect x="220" y="6" width="16" height="50" />
        <rect x="250" y="18" width="18" height="38" />
        <rect x="286" y="10" width="12" height="46" />
        <rect x="312" y="24" width="20" height="32" />
        <rect x="350" y="4" width="14" height="52" />
        <rect x="378" y="20" width="16" height="36" />
      </g>
    </svg>
  );
}

export function TruckCrossing() {
  const [direction, setDirection] = useState<"ltr" | "rtl" | null>(null);
  const [terrain, setTerrain] = useState<Terrain>("plain");
  const [bobDuration, setBobDuration] = useState(0.5);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function startCrossing() {
    setDirection(Math.random() < 0.5 ? "ltr" : "rtl");
    setTerrain(randomTerrain());
    // Slight per-crossing variation in bounce speed so consecutive
    // crossings don't all move identically - a real road isn't perfectly
    // smooth every time.
    setBobDuration(0.42 + Math.random() * 0.22);
  }

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    timeoutRef.current = setTimeout(startCrossing, randomMs(5, 14));
    return () => clearTimeout(timeoutRef.current);
  }, []);

  function handleAnimationEnd() {
    setDirection(null);
    timeoutRef.current = setTimeout(startCrossing, randomMs(25, 75));
  }

  if (!direction) return null;

  return (
    <div className="truck-scene" aria-hidden="true">
      <TerrainBand variant={terrain} />
      <div className="truck-road" />
      <div
        className={`truck-crossing truck-crossing-${direction}`}
        style={{ "--truck-bob-duration": `${bobDuration}s` } as CSSProperties}
        onAnimationEnd={handleAnimationEnd}
      >
        <div className={direction === "rtl" ? "truck-flip" : undefined}>
          <TruckGlyph />
        </div>
      </div>
    </div>
  );
}
