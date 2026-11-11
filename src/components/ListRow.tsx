// Shared design-system ListRow (spec §2.6, Phase 1): dot + two-line
// (title over sub) + trailing action — the shape the day entry, expense
// row, document row, and load row all share. Presentational only.
import type { ReactNode } from "react";

export type ListRowDot = "gold" | "bright" | "muted" | "good" | "danger" | "none";

const DOT_CLASS: Record<Exclude<ListRowDot, "none">, string> = {
  gold: "list-row-dot",
  bright: "list-row-dot list-row-dot-bright",
  muted: "list-row-dot list-row-dot-muted",
  good: "list-row-dot list-row-dot-good",
  danger: "list-row-dot list-row-dot-danger",
};

export default function ListRow({
  title,
  sub,
  subEdited = false,
  dot = "gold",
  action,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Renders the sub line in bright gold — the "Edited … — reason" line. */
  subEdited?: boolean;
  dot?: ListRowDot;
  action?: ReactNode;
}) {
  return (
    <div className="list-row">
      {dot !== "none" && <span className={DOT_CLASS[dot]} aria-hidden="true" />}
      <div className="list-row-main">
        <span className="list-row-title">{title}</span>
        {sub != null && (
          <span className={subEdited ? "list-row-sub list-row-sub-edited" : "list-row-sub"}>{sub}</span>
        )}
      </div>
      {action != null && <div className="list-row-action">{action}</div>}
    </div>
  );
}
