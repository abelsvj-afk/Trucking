"use client";

// Number ticker for headline money figures — Magic UI's number-ticker
// pattern (MIT, magicuidesign/magicui) reimplemented on Motion, per
// the design-resources shortlist ("borrow the technique, own the
// code"). Animates on mount and whenever `value` changes: ~600ms on
// the spec ease-out curve, tabular-nums so digits never jitter the
// layout. It is NOT a per-render loop — one Motion animation per value
// change, driven by a MotionValue rendered straight into the span (no
// React re-render per frame).
//
// Under prefers-reduced-motion the figure is static: the formatted
// final value, no animation.

import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

export default function NumberTicker({
  value,
  format,
  className,
}: {
  /** The figure to show, in whatever unit `format` expects (money surfaces pass cents). */
  value: number;
  /** Formats a (possibly mid-animation, fractional) value for display. */
  format: (value: number) => string;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();
  // Starts at 0 so the mount animation counts up to the figure; on a
  // value change the effect animates from wherever the value sits.
  const motionValue = useMotionValue(0);
  const rendered = useTransform(motionValue, (latest) => format(latest));

  useEffect(() => {
    if (reduceMotion) {
      motionValue.set(value);
      return;
    }
    const controls = animate(motionValue, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [value, reduceMotion, motionValue]);

  if (reduceMotion) {
    return (
      <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
        {format(value)}
      </span>
    );
  }

  return (
    <motion.span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {rendered}
    </motion.span>
  );
}
