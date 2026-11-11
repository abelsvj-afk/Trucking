// Shared design-system HubRow (spec §2.6, Phase 1): extracted from the
// hub-row markup the Fleet / Money / More hubs hand-roll today
// (Link.hub-row-link > span.hub-link + span.hub-desc + chevron). This
// component renders the same row shape — label, one-line description,
// chevron — on the consolidated token classes. Presentational only;
// the hubs adopt it in a later phase (no screen changes in Phase 1).
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export default function HubRow({
  href,
  label,
  desc,
}: {
  href: string;
  label: string;
  /** One-line purpose; may carry an inline figure (Phase 4 Money hub totals). */
  desc?: ReactNode;
}) {
  return (
    <Link href={href} className="ds-hub-row">
      <span className="hub-link">
        {label}
        <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" className="hub-chevron" />
      </span>
      {desc ? <span className="hub-desc">{desc}</span> : null}
    </Link>
  );
}
