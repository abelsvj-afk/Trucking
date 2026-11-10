// Shared design-system Card (spec §2.6, Phase 1): the one card surface —
// token background/border, 14px radius, 16px padding. Presentational
// only; screens adopt it in later phases.
import type { ReactNode } from "react";

export default function Card({
  children,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={className ? `ds-card ${className}` : "ds-card"} aria-label={ariaLabel}>
      {children}
    </section>
  );
}
