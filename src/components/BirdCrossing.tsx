"use client";

// A random bird (or small loose flock) flying across the upper part of
// the screen, per explicit owner request for more ambient motion beyond
// the truck. Rarer and higher up than the truck so the two never
// compete for attention. Same rules as TruckCrossing.tsx: decorative
// only (aria-hidden, pointer-events: none), self-disables under
// prefers-reduced-motion, mounted once in the root layout.

import { useEffect, useRef, useState } from "react";

function randomMs(minSeconds: number, maxSeconds: number) {
  return (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
}

// A bird as two stacked wing-position frames, opacity-toggled - a
// simple, reliable 2-frame flap without animating an SVG path directly.
function BirdGlyph({ scale }: { scale: number }) {
  return (
    <span className="bird-flap" style={{ transform: `scale(${scale})` }}>
      <svg className="bird-frame bird-frame-up" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
        <path
          d="M1 7 Q5 1 10 7 Q15 1 19 7"
          stroke="#64748b"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <svg className="bird-frame bird-frame-down" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
        <path
          d="M1 6 Q5 11 10 6 Q15 11 19 6"
          stroke="#64748b"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  );
}

export function BirdCrossing() {
  const [flight, setFlight] = useState<{
    direction: "ltr" | "rtl";
    lane: number;
    birds: number[];
  } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function startFlight() {
    const flockSize = Math.random() < 0.65 ? 1 : 2 + Math.round(Math.random());
    setFlight({
      direction: Math.random() < 0.5 ? "ltr" : "rtl",
      lane: Math.random() * 60 + 8, // vertical position, top 8-68px band
      birds: Array.from({ length: flockSize }, () => 0.75 + Math.random() * 0.5),
    });
  }

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // First bird can show up sooner than the truck's own first
    // appearance so a short verification pass doesn't need a long wait,
    // but subsequent ones are rarer than truck crossings on purpose -
    // birds are a lighter, occasional touch, not a constant background.
    timeoutRef.current = setTimeout(startFlight, randomMs(8, 25));
    return () => clearTimeout(timeoutRef.current);
  }, []);

  function handleAnimationEnd() {
    setFlight(null);
    timeoutRef.current = setTimeout(startFlight, randomMs(45, 130));
  }

  if (!flight) return null;

  return (
    <div
      className={`bird-crossing bird-crossing-${flight.direction}`}
      style={{ top: `${flight.lane}px` }}
      aria-hidden="true"
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="bird-flock">
        {flight.birds.map((scale, i) => (
          <BirdGlyph key={i} scale={scale} />
        ))}
      </div>
    </div>
  );
}
