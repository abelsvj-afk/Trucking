// Shared HOS paper/partial-day labeling (UH-12 fix, union fix round).
// Extracted from the HOS page's inline logic so EVERY surface that
// shows HOS numbers (HOS page, Home summary) labels paper-sourced and
// partial days the same way. Client-safe: pure functions over the
// entity types the API already returns — no API/schema change.

import type { Document, DutyLog } from "@/types/entities";

export interface PaperDocInfo {
  complete: boolean;
  date: string | null;
}

/** Map of paper-log document id -> completeness, from the documents list. */
export function buildPaperDocMap(documents: Document[]): Map<string, PaperDocInfo> {
  const map = new Map<string, PaperDocInfo>();
  for (const doc of documents) {
    if (doc.photo_purpose !== "paper_log") continue;
    const fields = (doc.extracted_fields ?? {}) as Record<string, unknown>;
    map.set(doc.id, {
      complete: fields.paper_log_complete !== false,
      date: typeof fields.paper_log_date === "string" ? fields.paper_log_date : null,
    });
  }
  return map;
}

export function hosPaperSummary(
  rows: DutyLog[],
  paperDocs: Map<string, PaperDocInfo>,
): { paperRowCount: number; partialDates: string[] } {
  const paperRowCount = rows.filter((row) => row.source === "paper_photo").length;
  const partialDates = [
    ...new Set(
      rows
        .filter((row) => row.source_document_id && paperDocs.get(row.source_document_id)?.complete === false)
        .map((row) => paperDocs.get(row.source_document_id!)?.date ?? "that day"),
    ),
  ];
  return { paperRowCount, partialDates };
}

/** The banner line for a summary built partly/wholly from paper logs (null when no paper rows). */
export function hosPaperBanner(rows: DutyLog[], paperDocs: Map<string, PaperDocInfo>): string | null {
  const { paperRowCount } = hosPaperSummary(rows, paperDocs);
  if (paperRowCount === 0) return null;
  return paperRowCount === rows.length
    ? "Every hour above was read off your paper log sheet(s) — the paper stays the legal record; this page mirrors it."
    : "The hours above mix what you logged here with hours read off your paper log sheet(s) — where they differ, the paper is the legal record.";
}

/** "Partial — ..." alert lines, one per partial paper date. */
export function hosPartialLines(rows: DutyLog[], paperDocs: Map<string, PaperDocInfo>): string[] {
  return hosPaperSummary(rows, paperDocs).partialDates.map(
    (date) => `Partial — from the readable part of ${date}'s log; the unreadable spans aren't in these numbers.`,
  );
}

/** Per-row suffixes: paper source + partial-day marker. */
export function hosRowPaperSuffix(row: DutyLog, paperDocs: Map<string, PaperDocInfo>): string {
  let suffix = "";
  if (row.source === "paper_photo") suffix += " — from your paper log sheet";
  if (row.source === "conversation") suffix += " — from your words";
  if (row.source_document_id && paperDocs.get(row.source_document_id)?.complete === false) {
    suffix += " (partial day)";
  }
  return suffix;
}

/** Compact label for summary surfaces (Home): names paper + partial state in one line, or null. */
export function hosPaperLabel(rows: DutyLog[], paperDocs: Map<string, PaperDocInfo>): string | null {
  const { paperRowCount, partialDates } = hosPaperSummary(rows, paperDocs);
  if (paperRowCount === 0) return null;
  const base = "Includes hours from your paper log sheet";
  return partialDates.length > 0
    ? `${base} — ${partialDates.length === 1 ? `the ${partialDates[0]} sheet was partial (unreadable spans aren't counted)` : "some sheets were partial (unreadable spans aren't counted)"}.`
    : `${base}.`;
}
