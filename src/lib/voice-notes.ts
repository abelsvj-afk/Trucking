// Location voice notes — the rules (owner 2026-11-18/19). Pure: no DB,
// no React. Design: docs/design/voice-notes.md.
//
// Owner decisions (2026-11-19):
//  - PASSED = he went past the note's spot going the same way; if that is
//    never detected (GPS gap, detour) the note clears for him 30 minutes
//    after he listened.
//  - LIFETIME by type: traffic 2 h, road work 7 days, low bridge / hazard
//    until cleared, tip 30 days.
//  - Coworkers can report a hazard GONE and clear it for everyone, gated by
//    fleet size: one report while the company is 1–3 people, two at 4–20,
//    three past that ("gated to more than one driver ... once more and more
//    users use my app"). A "this note is wrong" flag clears on the same gate.
//  - A note never pesters its author; the author can remove it.

import { haversineMiles, type LatLng } from "./smart-path";

export const VOICE_NOTE_KINDS = ["traffic", "roadwork", "bridge", "hazard", "tip"] as const;
export type VoiceNoteKind = (typeof VOICE_NOTE_KINDS)[number];

export const VOICE_NOTE_LABEL: Record<VoiceNoteKind, string> = {
  traffic: "Traffic / wreck",
  roadwork: "Road work",
  bridge: "Low bridge",
  hazard: "Hazard",
  tip: "Tip",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long a note lives after it is left; null = until cleared. */
export const VOICE_NOTE_LIFETIME_MS: Record<VoiceNoteKind, number | null> = {
  traffic: 2 * HOUR,
  roadwork: 7 * DAY,
  bridge: null,
  hazard: null,
  tip: 30 * DAY,
};

/** Longest note a driver can record. */
export const VOICE_NOTE_MAX_SECONDS = 30;
/** Fallback: listened but no pass detected → cleared for him after this. */
export const PASS_FALLBACK_MS = 30 * 60_000;
/** "At the spot" for the pass check, and the distance past it that counts as passed. */
export const NEAR_SPOT_MILES = 0.15;
export const PAST_SPOT_MILES = 0.1;
/** Same direction: headings within this many degrees. */
export const SAME_DIRECTION_DEG = 60;
/** Notes of the same kind this close, going the same way, stack into one bubble. */
export const STACK_MILES = 0.2;

export function expiresAtFor(kind: VoiceNoteKind, createdAtMs: number): number | null {
  const life = VOICE_NOTE_LIFETIME_MS[kind];
  return life === null ? null : createdAtMs + life;
}

/** Reports needed to clear a note for everyone, by fleet size. */
export function clearThreshold(memberCount: number): number {
  if (memberCount <= 3) return 1;
  if (memberCount <= 20) return 2;
  return 3;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

export function sameDirection(noteHeading: number | null, heading: number | null): boolean {
  if (noteHeading === null || heading === null) return true; // unknown: never hide a warning for it
  return angleDiff(noteHeading, heading) <= SAME_DIRECTION_DEG;
}

/**
 * Has he passed the spot? He is going the note's way and is now
 * PAST_SPOT_MILES beyond it along that direction, having been near it
 * (`wasNear`, tracked by the caller from earlier fixes).
 */
export function hasPassed(
  note: { point: LatLng; headingDeg: number | null },
  fix: { point: LatLng; headingDeg: number | null },
  wasNear: boolean,
): boolean {
  if (!wasNear || !sameDirection(note.headingDeg, fix.headingDeg)) return false;
  const dir = note.headingDeg ?? fix.headingDeg;
  if (dir === null) return haversineMiles(note.point, fix.point) > NEAR_SPOT_MILES;
  // Component of (fix - note) along the travel direction, in miles.
  const kx = 69.17 * Math.cos((note.point.lat * Math.PI) / 180);
  const dx = (fix.point.lng - note.point.lng) * kx;
  const dy = (fix.point.lat - note.point.lat) * 69.09;
  const rad = (dir * Math.PI) / 180;
  const along = dx * Math.sin(rad) + dy * Math.cos(rad);
  return along >= PAST_SPOT_MILES;
}

export function isNearSpot(note: { point: LatLng }, point: LatLng): boolean {
  return haversineMiles(note.point, point) <= NEAR_SPOT_MILES;
}

export interface VoiceNoteRecord {
  id: string;
  authorId: string;
  kind: VoiceNoteKind;
  point: LatLng;
  headingDeg: number | null;
  roadRef: string | null;
  durationS: number;
  createdAtMs: number;
  expiresAtMs: number | null;
  removedAtMs: number | null;
  goneReports: number;
  badReports: number;
  /** This viewer's own state. */
  listenedAtMs: number | null;
  passedAtMs: number | null;
  reportedByMe: boolean;
}

/** Live for EVERYONE: not removed, not expired, not cleared by enough reports. */
export function isLive(note: VoiceNoteRecord, memberCount: number, nowMs: number): boolean {
  if (note.removedAtMs !== null) return false;
  if (note.expiresAtMs !== null && nowMs >= note.expiresAtMs) return false;
  const need = clearThreshold(memberCount);
  if (note.goneReports >= need || note.badReports >= need) return false;
  return true;
}

/** Done for THIS viewer: listened and passed — or listened 30+ min ago with no pass seen. */
export function isDoneForViewer(note: VoiceNoteRecord, nowMs: number): boolean {
  if (note.listenedAtMs === null) return false;
  if (note.passedAtMs !== null) return true;
  return nowMs - note.listenedAtMs >= PASS_FALLBACK_MS;
}

/** What the viewer sees: the coworker notes still for him (his own never pester him). */
export function notesForViewer(notes: VoiceNoteRecord[], viewerId: string, memberCount: number, nowMs: number): VoiceNoteRecord[] {
  // A note he has already reported (gone / wrong) is done for him too.
  return notes.filter((n) => n.authorId !== viewerId && !n.reportedByMe && isLive(n, memberCount, nowMs) && !isDoneForViewer(n, nowMs));
}

export interface VoiceNoteStack {
  /** The newest note — the one played first. */
  lead: VoiceNoteRecord;
  notes: VoiceNoteRecord[];
}

/** Duplicates of the same warning (same kind, same way, within STACK_MILES) stack into one bubble, newest first. */
export function stackVoiceNotes(notes: VoiceNoteRecord[]): VoiceNoteStack[] {
  const sorted = [...notes].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const stacks: VoiceNoteStack[] = [];
  for (const note of sorted) {
    const home = stacks.find(
      (s) =>
        s.lead.kind === note.kind &&
        sameDirection(s.lead.headingDeg, note.headingDeg) &&
        haversineMiles(s.lead.point, note.point) <= STACK_MILES,
    );
    if (home) home.notes.push(note);
    else stacks.push({ lead: note, notes: [note] });
  }
  return stacks;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function freshnessLabel(createdAtMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - createdAtMs) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Without a planned route (Home's map, 2026-11-19): a note is "ahead" when it
 * lies in front of the truck (bearing to it within SAME_DIRECTION_DEG of his
 * heading), was left going his way, and is within `maxMiles` straight-line.
 * Returns the straight-line miles, or null when it is not ahead of him.
 */
export function milesAheadByBearing(note: { point: LatLng; headingDeg: number | null }, fix: { point: LatLng; headingDeg: number | null }, maxMiles: number): number | null {
  const miles = haversineMiles(fix.point, note.point);
  if (miles > maxMiles) return null;
  if (!sameDirection(note.headingDeg, fix.headingDeg)) return null;
  if (fix.headingDeg !== null && miles > NEAR_SPOT_MILES) {
    const kx = Math.cos((fix.point.lat * Math.PI) / 180);
    const b = ((Math.atan2((note.point.lng - fix.point.lng) * kx, note.point.lat - fix.point.lat) * 180) / Math.PI + 360) % 360;
    if (angleDiff(b, fix.headingDeg) > SAME_DIRECTION_DEG) return null;
  }
  return miles;
}
