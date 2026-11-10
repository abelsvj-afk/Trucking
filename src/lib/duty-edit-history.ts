// Edit-history presentation for one duty entry (spec §2.2): turns a
// duty_log_edits trail row into plain lines - what changed (before ->
// after, per changed field), why, and which surface made the fix.
// Pure: the day view's history sheet and the editor's history section
// render exactly these lines.

import { formatDateTime } from "@/lib/time";
import type { DutyLogEdit, DutyStatus } from "@/types/entities";

export const EDIT_STATUS_LABELS: Record<DutyStatus, string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper berth",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

export const EDIT_SOURCE_LABELS: Record<DutyLogEdit["source"], string> = {
  app: "in the app",
  conversation: "through Abel",
  paper: "from a paper log",
};

const STATUS_VALUES = new Set<string>(["off_duty", "sleeper", "driving", "on_duty"]);

function statusLabel(value: unknown): string {
  return typeof value === "string" && STATUS_VALUES.has(value)
    ? EDIT_STATUS_LABELS[value as DutyStatus]
    : "—";
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "—";
}

function odometerValue(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

function loadValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? "a load" : "no load";
}

interface FieldSpec {
  key: string;
  label: string;
  format: (value: unknown, timeZone: string) => string;
}

const FIELD_SPECS: FieldSpec[] = [
  { key: "duty_status", label: "Status", format: (v) => statusLabel(v) },
  {
    key: "started_at",
    label: "Start",
    format: (v, tz) => (typeof v === "string" ? formatDateTime(v, tz) : "—"),
  },
  { key: "location", label: "Location", format: (v) => textValue(v) },
  { key: "odometer", label: "Odometer", format: (v) => odometerValue(v) },
  { key: "notes", label: "Notes", format: (v) => textValue(v) },
  { key: "load_id", label: "Load", format: (v) => loadValue(v) },
];

/** The "what changed" lines for one trail row (before -> after per changed field for an update; one line for the other kinds). */
export function summarizeDutyEdit(edit: DutyLogEdit, timeZone: string): string[] {
  if (edit.kind === "insert") {
    const at = typeof edit.after?.started_at === "string" ? formatDateTime(edit.after.started_at, timeZone) : "";
    return [`Entry added — ${statusLabel(edit.after?.duty_status)}${at ? ` from ${at}` : ""}`];
  }
  if (edit.kind === "delete") return ["Entry deleted"];
  if (edit.kind === "restore") return ["Entry restored"];
  const lines: string[] = [];
  for (const spec of FIELD_SPECS) {
    const from = edit.before?.[spec.key];
    const to = edit.after?.[spec.key];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
    lines.push(`${spec.label} ${spec.format(from, timeZone)} → ${spec.format(to, timeZone)}`);
  }
  return lines.length > 0 ? lines : ["Entry updated"];
}
