// Shared design-system QuickAction (spec §2.6, Phase 1): one tile of
// the Home quick-action grid — icon over label, whole tile is the
// link. Presentational only.
import Link from "next/link";
import type { ReactNode } from "react";

export default function QuickAction({
  href,
  icon,
  label,
}: {
  href: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Link href={href} className="quick-action">
      <span className="quick-action-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </Link>
  );
}
