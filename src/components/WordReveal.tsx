"use client";

// Word-split headline reveal — motion mini-spec rule 3: headlines may
// split word-by-word (30ms/word, fade + rise) on the research/news
// surfaces ONLY. Data screens (loads, money, HOS, lists) get nothing.
//
// Plays once on mount (animate, not whileInView — these headlines sit
// at the top of their surface). Under prefers-reduced-motion it renders
// the plain headline with no animation and no per-word spans.
//
// Accessibility: the wrapper carries the full headline as an
// aria-label and the animated word spans are aria-hidden, so a screen
// reader hears the headline once, whole — never word-by-word soup.

import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/components/use-prefers-reduced-motion";

export default function WordReveal({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();

  if (reduceMotion) {
    return <span className={className}>{text}</span>;
  }

  const words = text.split(/\s+/).filter(Boolean);

  return (
    <span className={className}>
      {/* The whole text stays readable to assistive tech; the animated
          words are decoration (an aria-label on a plain span is ignored
          by many screen readers, which would have read nothing). */}
      <span className="visually-hidden">{text}</span>
      {words.map((word, i) => (
        <motion.span
          key={`${i}-${word}`}
          className="word-reveal-word"
          aria-hidden="true"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: i * 0.03, ease: [0.22, 1, 0.36, 1] }}
        >
          {word}
          {i < words.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </span>
  );
}
