// Paper-log review payloads (docs/design/driver-hud.md §6;
// docs/api-contracts.md "Paper-log review").

import type { DutyStatus } from "./entities";
import type { DraftSegment } from "@/lib/paper-day";

export interface PaperLogListItem {
  id: string;
  uploaded_at: string;
  file_name: string;
  log_date: string | null;
  /** The grid has been read and the read is stored for review. */
  read: boolean;
  /** Duty rows from this sheet are in the log. */
  saved: boolean;
}

export interface PaperLogExistingRow {
  id: string;
  duty_status: DutyStatus;
  started_at: string;
  source: string;
}

export interface PaperLogReview {
  document_id: string;
  file_name: string;
  photo_url: string | null;
  scan_url: string | null;
  /** The carrier timezone the sheet's 00:00-24:00 is placed in. */
  time_zone: string;
  /** False when the grid has never been read (or the stored read is unusable). */
  read: boolean;
  log_date: string | null;
  draft: DraftSegment[];
  /** Cross-check problems the reader's day failed, in words. */
  problems: string[];
  /** Totals as he wrote them on the sheet, hours; null where not written. */
  written_totals: Record<DutyStatus, number | null> | null;
  truck_number: string | null;
  trailer_number: string | null;
  remarks: string | null;
  /** Rows from other sources that start inside this day: saving replaces them only if acknowledged. */
  conflicts: PaperLogExistingRow[];
  /** Rows already saved from this sheet. */
  saved_rows: PaperLogExistingRow[];
}

export interface PaperLogSaveBody {
  log_date: string;
  segments: { status: DutyStatus; start_min: number; end_min: number }[];
  replace_ids: string[];
}
