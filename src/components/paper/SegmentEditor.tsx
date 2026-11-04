"use client";

// One stretch of the paper day, editable (docs/design/driver-hud.md §6).
// The origin is always written in words - how sure the reader was is
// never hidden behind colour alone - and anything the reader wasn't sure
// of needs his tap before the day can save.

import type { DutyStatus } from "@/types/entities";
import { DAY_MINUTES, formatMinutes, parseClock, type DraftSegment, type SegmentOrigin } from "@/lib/paper-day";

export const STATUS_OPTIONS: { value: DutyStatus; label: string }[] = [
  { value: "off_duty", label: "Off duty" },
  { value: "sleeper", label: "Sleeper berth" },
  { value: "driving", label: "Driving" },
  { value: "on_duty", label: "On duty (not driving)" },
];

const ORIGIN_WORDS: Record<SegmentOrigin, string> = {
  clean: "Read clearly",
  flagged: "Faint on the sheet — double-check",
  low: "Reader wasn't sure — confirm or correct",
  missing: "Couldn't be read — choose what you were doing",
  edited: "Your entry",
};

interface Props {
  segment: DraftSegment;
  index: number;
  isLast: boolean;
  selected: boolean;
  onSelect: () => void;
  onStatus: (status: DutyStatus) => void;
  onEnd: (minute: number) => void;
  onSplit: () => void;
  onRemove: (() => void) | null;
}

export default function SegmentEditor({ segment, index, isLast, selected, onSelect, onStatus, onEnd, onSplit, onRemove }: Props) {
  const tone =
    segment.origin === "low" || segment.origin === "missing" ? "danger" : segment.origin === "flagged" ? "warn" : "ok";
  const id = `seg-${index}`;
  return (
    <li className={`seg seg-${tone}${selected ? " seg-selected" : ""}`} onFocus={onSelect} onClick={onSelect}>
      <p className="seg-head">
        <strong>
          {formatMinutes(segment.startMin)}–{formatMinutes(segment.endMin)}
        </strong>{" "}
        <span className="seg-origin">
          {ORIGIN_WORDS[segment.origin]}
          {segment.confidence !== null && ` (${Math.round(segment.confidence * 100)}%)`}
        </span>
      </p>
      <label htmlFor={`${id}-status`}>Status</label>
      <select
        id={`${id}-status`}
        value={segment.status ?? ""}
        onChange={(e) => onStatus(e.target.value as DutyStatus)}
      >
        {segment.status === null && (
          <option value="" disabled>
            Choose…
          </option>
        )}
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {segment.origin === "low" && segment.status && (
        <button type="button" onClick={() => onStatus(segment.status!)}>
          Yes, that&apos;s right
        </button>
      )}
      {!isLast && (
        <>
          <label htmlFor={`${id}-end`}>Ends at</label>
          <input
            id={`${id}-end`}
            type="time"
            step={60}
            defaultValue={formatMinutes(segment.endMin)}
            key={segment.endMin}
            onBlur={(e) => {
              const m = parseClock(e.target.value);
              if (m !== null && m !== segment.endMin && m > segment.startMin && m < DAY_MINUTES) onEnd(m);
            }}
          />
        </>
      )}
      <div className="seg-actions">
        <button type="button" onClick={onSplit} disabled={segment.endMin - segment.startMin < 2}>
          Split
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
