"use client";

// The standard 24-hour duty grid (docs/design/driver-hud.md §3/§6):
// four status rows, hour columns with quarter-hour ticks, the duty line
// drawn across them with vertical connectors at each change - the same
// picture as the paper sheet, so the two can be compared side by side.
// Unresolved time (unreadable, or the reader unsure) is drawn as a
// striped band across all rows in the warning colour, never as a line
// on a row it can't vouch for. Tapping a stretch selects it for editing.
//
// `compact` is the Home mini (owner order 2026-11-17): the SAME
// renderer and the SAME line drawing, only tighter rows, no quarter
// ticks and hour labels every 6 hours - readable at a glance while
// driving. There is deliberately no second graph: the mini and the
// full Day log page can never draw different lines for the same day.

import type { DutyStatus } from "@/types/entities";
import { formatMinutes, type DraftSegment } from "@/lib/paper-day";

export const GRAPH_ROWS: { status: DutyStatus; label: string }[] = [
  { status: "off_duty", label: "Off" },
  { status: "sleeper", label: "SB" },
  { status: "driving", label: "D" },
  { status: "on_duty", label: "ON" },
];

const FULL = { labelW: 56, w: 720, rowH: 44, top: 26 };
const COMPACT = { labelW: 44, w: 720, rowH: 28, top: 20 };

function unresolved(s: DraftSegment): boolean {
  return s.status === null || s.origin === "low";
}

function describe(segments: DraftSegment[]): string {
  return segments
    .map((s) => {
      const label = s.status ? GRAPH_ROWS.find((r) => r.status === s.status)!.label : "unresolved";
      return `${formatMinutes(s.startMin)} to ${formatMinutes(s.endMin)} ${unresolved(s) ? `${label}, needs your confirmation` : label}`;
    })
    .join("; ");
}

export default function DayGraph({
  segments,
  selected,
  onSelect,
  compact,
}: {
  segments: DraftSegment[];
  selected?: number | null;
  onSelect?: (index: number) => void;
  /** Home mini: tighter rows, no quarter ticks, hour labels every 6h. Same lines, same geometry. */
  compact?: boolean;
}) {
  const d = compact ? COMPACT : FULL;
  const plotW = d.w - d.labelW - 6;
  const h = d.top + d.rowH * 4 + 4;
  const x = (minute: number) => d.labelW + (minute / 1440) * plotW;
  const rowY = (status: DutyStatus) =>
    d.top + GRAPH_ROWS.findIndex((r) => r.status === status) * d.rowH + d.rowH / 2;
  const hourLabelEvery = compact ? 6 : 3;

  return (
    <div className={compact ? "day-graph day-graph-compact" : "day-graph"}>
      <svg viewBox={`0 0 ${d.w} ${h}`} role="img" aria-label={`Duty graph: ${describe(segments)}`}>
        <defs>
          <pattern id="dg-stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="8" className="dg-stripe" />
          </pattern>
        </defs>
        {Array.from({ length: 25 }, (_, h) => (
          <g key={h}>
            <line x1={x(h * 60)} x2={x(h * 60)} y1={d.top} y2={d.top + d.rowH * 4} className="dg-hour" />
            {h % hourLabelEvery === 0 && h < 24 && (
              <text x={x(h * 60) + 2} y={d.top - 4} className="dg-hour-label">
                {h === 0 ? "M" : h === 12 ? "N" : h > 12 ? h - 12 : h}
              </text>
            )}
          </g>
        ))}
        {!compact &&
          Array.from({ length: 96 }, (_, q) =>
            q % 4 === 0 ? null : (
              <line key={`q${q}`} x1={x(q * 15)} x2={x(q * 15)} y1={d.top} y2={d.top + 5} className="dg-quarter" />
            ),
          )}
        {GRAPH_ROWS.map((row, i) => (
          <g key={row.status}>
            <line x1={d.labelW} x2={d.w - 6} y1={d.top + i * d.rowH} y2={d.top + i * d.rowH} className="dg-row-line" />
            <text x={2} y={d.top + i * d.rowH + d.rowH / 2 + 4} className="dg-row-label">
              {row.label}
            </text>
          </g>
        ))}
        <line x1={d.labelW} x2={d.w - 6} y1={d.top + d.rowH * 4} y2={d.top + d.rowH * 4} className="dg-row-line" />

        {segments.map((s, i) =>
          unresolved(s) ? (
            <rect
              key={`u${i}`}
              x={x(s.startMin)}
              y={d.top}
              width={Math.max(1, x(s.endMin) - x(s.startMin))}
              height={d.rowH * 4}
              fill="url(#dg-stripes)"
              className="dg-unresolved"
            />
          ) : null,
        )}

        {segments.map((s, i) => {
          if (unresolved(s)) return null;
          const y = rowY(s.status!);
          const next = segments[i + 1];
          return (
            <g key={`s${i}`} className={s.origin === "flagged" ? "dg-flagged" : "dg-line"}>
              <line x1={x(s.startMin)} x2={x(s.endMin)} y1={y} y2={y} />
              {next && !unresolved(next) && next.status !== s.status && (
                <line x1={x(s.endMin)} x2={x(s.endMin)} y1={y} y2={rowY(next.status!)} />
              )}
            </g>
          );
        })}

        {selected != null && segments[selected] && (
          <rect
            x={x(segments[selected].startMin)}
            y={d.top - 2}
            width={Math.max(2, x(segments[selected].endMin) - x(segments[selected].startMin))}
            height={d.rowH * 4 + 4}
            className="dg-selected"
          />
        )}

        {onSelect &&
          segments.map((s, i) => (
            <rect
              key={`hit${i}`}
              x={x(s.startMin)}
              y={0}
              width={Math.max(6, x(s.endMin) - x(s.startMin))}
              height={h}
              className="dg-hit"
              onClick={() => onSelect(i)}
            />
          ))}
      </svg>
    </div>
  );
}
