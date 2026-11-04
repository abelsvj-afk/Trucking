// Paper-log day model for the review screen (docs/design/driver-hud.md
// §6). Pure and shared by the screen and the save route. The rule it
// enforces: NO INVENTED HOURS. A day saves only when every minute from
// 00:00 to 24:00 is covered by a segment whose status the driver has
// confirmed - the reader's low-confidence guesses and the spans it could
// not read at all must be resolved by him, in his own word, first.
// (A duty row runs until the next row, so an unresolved hole would
// otherwise silently become the previous status - falsified hours.)

import type { DutyStatus } from "@/types/entities";

export const DAY_MINUTES = 1440;

/**
 * clean    - read at/above the clean bar
 * flagged  - read, above the floor but faint: shown for a double-check
 * low      - under the floor: the reader's guess, must be confirmed
 * missing  - nothing readable: status must be chosen
 * edited   - set or confirmed by the driver
 */
export type SegmentOrigin = "clean" | "flagged" | "low" | "missing" | "edited";

export interface DraftSegment {
  status: DutyStatus | null;
  startMin: number;
  endMin: number;
  confidence: number | null;
  origin: SegmentOrigin;
}

export interface ReadSegment {
  status: DutyStatus;
  startMin: number;
  endMin: number;
  confidence: number;
  flagged?: boolean;
}

export function needsConfirmation(segment: DraftSegment): boolean {
  return segment.origin === "low" || segment.origin === "missing" || segment.status === null;
}

/** Builds the editable day from the analyzer's output, filling every hole explicitly. */
export function draftFromRead(staged: ReadSegment[], dropped: ReadSegment[]): DraftSegment[] {
  const sorted = [...staged]
    .filter((s) => s.endMin > s.startMin)
    .sort((a, b) => a.startMin - b.startMin);
  const out: DraftSegment[] = [];
  let cursor = 0;

  const fillGap = (from: number, to: number) => {
    let at = from;
    const candidates = dropped
      .filter((d) => d.endMin > from && d.startMin < to)
      .sort((a, b) => a.startMin - b.startMin);
    for (const d of candidates) {
      const start = Math.max(d.startMin, at);
      const end = Math.min(d.endMin, to);
      if (end <= start) continue;
      if (start > at) out.push({ status: null, startMin: at, endMin: start, confidence: null, origin: "missing" });
      out.push({ status: d.status, startMin: start, endMin: end, confidence: d.confidence, origin: "low" });
      at = end;
    }
    if (to > at) out.push({ status: null, startMin: at, endMin: to, confidence: null, origin: "missing" });
  };

  for (const s of sorted) {
    const start = Math.max(Math.min(s.startMin, DAY_MINUTES), cursor);
    const end = Math.min(s.endMin, DAY_MINUTES);
    if (end <= start) continue;
    if (start > cursor) fillGap(cursor, start);
    out.push({
      status: s.status,
      startMin: start,
      endMin: end,
      confidence: s.confidence,
      origin: s.flagged ? "flagged" : "clean",
    });
    cursor = end;
  }
  if (cursor < DAY_MINUTES) fillGap(cursor, DAY_MINUTES);
  return out;
}

export interface DayValidation {
  ok: boolean;
  errors: string[];
}

export function validateDraft(segments: DraftSegment[]): DayValidation {
  const errors: string[] = [];
  if (segments.length === 0) return { ok: false, errors: ["The day has no segments."] };
  if (segments[0]!.startMin !== 0) errors.push("The day must start at 00:00.");
  if (segments[segments.length - 1]!.endMin !== DAY_MINUTES) errors.push("The day must end at 24:00.");
  segments.forEach((s, i) => {
    const at = `${formatMinutes(s.startMin)}–${formatMinutes(s.endMin)}`;
    if (!Number.isInteger(s.startMin) || !Number.isInteger(s.endMin) || s.endMin <= s.startMin) {
      errors.push(`${at}: a segment must end after it starts.`);
    }
    if (s.startMin < 0 || s.endMin > DAY_MINUTES) errors.push(`${at}: outside the day.`);
    const next = segments[i + 1];
    if (next && next.startMin !== s.endMin) {
      errors.push(
        next.startMin > s.endMin
          ? `${formatMinutes(s.endMin)}–${formatMinutes(next.startMin)} is not covered.`
          : `${at} overlaps the next segment.`,
      );
    }
    if (s.status === null) errors.push(`${at}: choose what you were doing.`);
    else if (s.origin === "low") errors.push(`${at}: the reader wasn't sure - confirm or correct it.`);
  });
  return { ok: errors.length === 0, errors };
}

/** Consecutive same-status segments collapse into one duty row each. */
export function toDutyRows(segments: DraftSegment[]): { status: DutyStatus; startMin: number }[] {
  const rows: { status: DutyStatus; startMin: number }[] = [];
  for (const s of segments) {
    if (s.status === null) throw new Error("toDutyRows called on an unresolved day");
    if (rows.length > 0 && rows[rows.length - 1]!.status === s.status) continue;
    rows.push({ status: s.status, startMin: s.startMin });
  }
  return rows;
}

export function dayTotals(segments: DraftSegment[]): Record<DutyStatus | "unresolved", number> {
  const totals = { off_duty: 0, sleeper: 0, driving: 0, on_duty: 0, unresolved: 0 };
  for (const s of segments) {
    const minutes = Math.max(0, s.endMin - s.startMin);
    if (s.status === null || s.origin === "low") totals.unresolved += minutes;
    else totals[s.status] += minutes;
  }
  return totals;
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" (00:00-24:00) -> minutes, or null when malformed. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59 || h > 24 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

/** Moves the boundary between segment i and i+1, keeping the day tiled. */
export function moveBoundary(segments: DraftSegment[], index: number, minute: number): DraftSegment[] {
  const a = segments[index];
  const b = segments[index + 1];
  if (!a || !b || minute <= a.startMin || minute >= b.endMin) return segments;
  const next = [...segments];
  next[index] = { ...a, endMin: minute };
  next[index + 1] = { ...b, startMin: minute };
  return next;
}

/** Splits segment i at `minute` into two of the same status (both then editable). */
export function splitSegment(segments: DraftSegment[], index: number, minute: number): DraftSegment[] {
  const s = segments[index];
  if (!s || minute <= s.startMin || minute >= s.endMin) return segments;
  const next = [...segments];
  next.splice(index, 1, { ...s, endMin: minute }, { ...s, startMin: minute });
  return next;
}

/** Sets a segment's status - the driver's own word. */
export function setStatus(segments: DraftSegment[], index: number, status: DutyStatus): DraftSegment[] {
  const next = [...segments];
  const s = next[index];
  if (!s) return segments;
  next[index] = { ...s, status, origin: "edited" };
  return next;
}

/** Removes segment i, giving its time to the previous segment (or the next, for the first). */
export function removeSegment(segments: DraftSegment[], index: number): DraftSegment[] {
  if (segments.length <= 1 || !segments[index]) return segments;
  const next = [...segments];
  const [gone] = next.splice(index, 1);
  if (index > 0) next[index - 1] = { ...next[index - 1]!, endMin: gone!.endMin };
  else next[0] = { ...next[0]!, startMin: gone!.startMin };
  return next;
}
