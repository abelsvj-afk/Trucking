"use client";

// Edit history for one duty entry (spec §2.2): the trail rows for the
// entry - when each fix happened, what changed (before -> after),
// the reason, and which surface made it - over the line every entry
// starts from: "Original entry created" (from the entry's own
// created_at). An entry with no trail shows just that line: its
// history honestly starts at its creation, nothing invented.

import { formatDateTime } from "@/lib/time";
import { EDIT_SOURCE_LABELS, EDIT_STATUS_LABELS, summarizeDutyEdit } from "@/lib/duty-edit-history";
import { enteredAfterTheFact, type DayRow } from "@/lib/day-view";
import type { DutyLogEdit } from "@/types/entities";

export default function DutyEditHistory({
  row,
  edits,
  timeZone,
}: {
  row: DayRow;
  edits: DutyLogEdit[];
  timeZone: string;
}) {
  const newestFirst = [...edits].reverse();
  return (
    <div className="edit-history">
      {newestFirst.map((edit) => (
        <div key={edit.id} className="edit-history-row">
          <p className="edit-history-when">{formatDateTime(edit.edited_at, timeZone)}</p>
          {summarizeDutyEdit(edit, timeZone).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>
            Reason: &ldquo;{edit.reason}&rdquo; · {EDIT_SOURCE_LABELS[edit.source]}
          </p>
        </div>
      ))}
      <div className="edit-history-row">
        <p className="edit-history-when">{row.created_at ? formatDateTime(row.created_at, timeZone) : ""}</p>
        <p>
          Original entry created — {EDIT_STATUS_LABELS[row.duty_status]}
          {enteredAfterTheFact(row) ? " · Entered after the fact" : ""}
        </p>
      </div>
    </div>
  );
}
