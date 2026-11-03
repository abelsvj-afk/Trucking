"use client";

// Reveal-once entrance — motion mini-spec rule 3: fade + 8px rise,
// 360ms, 40ms stagger (via the `index` prop), FIRST MOUNT ONLY.
// Motion's whileInView with viewport={{ once: true }} fires the
// reveal a single time per mount and never replays it on scroll;
// route remounts are new mounts by definition. Transform/opacity
// only — nothing here shifts layout.
//
// Deliberately used ONLY on Home cards and hub list rows. Never on
// Drive, forms, or data lists (loads/money/HOS stay quiet).
// Under prefers-reduced-motion it renders the plain element.

import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";
import type { ReactNode } from "react";

type RevealProps = {
  /** Stagger position: delay = index * 40ms. */
  index?: number;
  className?: string;
  children: ReactNode;
} & (
  | { as?: "section"; "aria-label"?: string }
  | { as: "li" }
);

export default function Reveal(props: RevealProps) {
  const reduceMotion = usePrefersReducedMotion();
  const { index = 0, className, children } = props;

  if (reduceMotion) {
    if (props.as === "li") return <li className={className}>{children}</li>;
    return (
      <section className={className} aria-label={props["aria-label"]}>
        {children}
      </section>
    );
  }

  const shared = {
    className,
    initial: { opacity: 0, y: 8 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: 0.36, delay: index * 0.04, ease: [0.22, 1, 0.36, 1] as const },
  };

  if (props.as === "li") {
    return <motion.li {...shared}>{children}</motion.li>;
  }
  return (
    <motion.section {...shared} aria-label={props["aria-label"]}>
      {children}
    </motion.section>
  );
}
