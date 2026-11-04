// Paper-log review service (docs/design/driver-hud.md §6). Server-only.
// - readPaperLogFromDocument: the one grid-reader entry point, shared by
//   Telegram and the app (same contract, same untrusted-output gate).
// - persistPaperLogRead: stores the read on the sheet's document so the
//   review screen can show EVERYTHING the reader returned, including the
//   segments under the floor that Telegram never stages.
// - buildPaperLogReview / savePaperLogDay: the screen's read and save.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  analyzePaperLogDay,
  extractPaperLog,
  paperLogExtractionSchema,
  type PaperLogExtraction,
} from "@/services/ai/paper-log-extraction";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import { paperSheetInstant } from "@/services/fleet/paper-logs";
import { draftFromRead, toDutyRows, validateDraft, type DraftSegment } from "@/lib/paper-day";
import type { PaperLogExistingRow, PaperLogReview, PaperLogSaveBody } from "@/types/paper-logs";

export const PAPER_READ_KEY = "paper_log_read";
const SIGNED_URL_TTL_SECONDS = 600;

interface DocRow {
  id: string;
  file_name: string;
  storage_path: string;
  scan_storage_path: string | null;
  content_type: string | null;
  extracted_fields: Record<string, unknown> | null;
}

async function loadDoc(client: SupabaseClient, companyId: string, documentId: string): Promise<DocRow | null> {
  const { data, error } = await client
    .from("documents")
    .select("id, file_name, storage_path, scan_storage_path, content_type, extracted_fields")
    .eq("id", documentId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DocRow | null) ?? null;
}

export async function readPaperLogFromDocument(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  knownBytes?: Buffer,
): Promise<PaperLogExtraction> {
  const doc = await loadDoc(client, companyId, documentId);
  if (!doc) throw new Error("The stored sheet couldn't be loaded back.");
  let buffer = knownBytes;
  let mediaType = doc.content_type ?? "image/jpeg";
  if (!buffer) {
    const path = doc.scan_storage_path ?? doc.storage_path;
    const { data: blob, error } = await client.storage.from("documents").download(path);
    if (error || !blob) throw new Error("The stored sheet couldn't be downloaded.");
    buffer = Buffer.from(await blob.arrayBuffer());
    if (doc.scan_storage_path) mediaType = "image/png";
  }
  return extractPaperLog(new OpenAiProvider(), { imageBase64: buffer.toString("base64"), mediaType });
}

/** Stores the read (and marks the document a paper log). Best-effort callers log failures. */
export async function persistPaperLogRead(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  extraction: PaperLogExtraction,
): Promise<void> {
  const doc = await loadDoc(client, companyId, documentId);
  if (!doc) throw new Error("The stored sheet couldn't be loaded back.");
  const { error } = await client
    .from("documents")
    .update({
      photo_purpose: "paper_log",
      extracted_fields: {
        ...(doc.extracted_fields ?? {}),
        [PAPER_READ_KEY]: extraction,
        paper_log_date: extraction.log_date,
      },
    })
    .eq("id", documentId)
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
}

function storedRead(doc: DocRow): PaperLogExtraction | null {
  const raw = doc.extracted_fields?.[PAPER_READ_KEY];
  if (raw === undefined || raw === null) return null;
  // Stored model output is still untrusted: re-validate before use.
  const parsed = paperLogExtractionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function dayBounds(logDate: string, timeZone: string): { start: Date; end: Date } {
  return { start: paperSheetInstant(logDate, "00:00", timeZone), end: paperSheetInstant(logDate, "24:00", timeZone) };
}

async function rowsForDay(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  logDate: string,
  timeZone: string,
): Promise<{ conflicts: PaperLogExistingRow[]; saved: PaperLogExistingRow[] }> {
  const { start, end } = dayBounds(logDate, timeZone);
  const [inDay, fromSheet] = await Promise.all([
    client
      .from("duty_logs")
      .select("id, duty_status, started_at, source, source_document_id")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", start.toISOString())
      .lt("started_at", end.toISOString())
      .order("started_at", { ascending: true })
      .limit(500),
    client
      .from("duty_logs")
      .select("id, duty_status, started_at, source, source_document_id")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .eq("source_document_id", documentId)
      .order("started_at", { ascending: true })
      .limit(500),
  ]);
  if (inDay.error) throw new Error(inDay.error.message);
  if (fromSheet.error) throw new Error(fromSheet.error.message);
  type Row = PaperLogExistingRow & { source_document_id: string | null };
  const strip = ({ id, duty_status, started_at, source }: Row): PaperLogExistingRow => ({ id, duty_status, started_at, source });
  return {
    conflicts: ((inDay.data ?? []) as Row[]).filter((r) => r.source_document_id !== documentId).map(strip),
    saved: ((fromSheet.data ?? []) as Row[]).map(strip),
  };
}

export async function buildPaperLogReview(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  timeZone: string,
): Promise<PaperLogReview | null> {
  const doc = await loadDoc(client, companyId, documentId);
  if (!doc) return null;
  const [photo, scan] = await Promise.all([
    client.storage.from("documents").createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS),
    doc.scan_storage_path
      ? client.storage.from("documents").createSignedUrl(doc.scan_storage_path, SIGNED_URL_TTL_SECONDS)
      : Promise.resolve({ data: null }),
  ]);
  const read = storedRead(doc);
  let draft: DraftSegment[] = draftFromRead([], []);
  let problems: string[] = [];
  if (read) {
    const analysis = analyzePaperLogDay(read);
    draft = draftFromRead(analysis.staged, analysis.dropped);
    problems = analysis.problems;
  }
  const logDate = read?.log_date ?? null;
  const rows = logDate ? await rowsForDay(client, companyId, documentId, logDate, timeZone) : { conflicts: [], saved: [] };
  return {
    document_id: doc.id,
    file_name: doc.file_name,
    photo_url: photo.data?.signedUrl ?? null,
    scan_url: scan.data?.signedUrl ?? null,
    time_zone: timeZone,
    read: read !== null,
    log_date: logDate,
    draft,
    problems,
    written_totals: read?.totals ?? null,
    truck_number: read?.truck_number ?? null,
    trailer_number: read?.trailer_number ?? null,
    remarks: read?.remarks ?? null,
    conflicts: rows.conflicts,
    saved_rows: rows.saved,
  };
}

export type SaveOutcome =
  | { ok: true; inserted: number }
  | { ok: false; kind: "invalid"; errors: string[] }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "not_found" };

export async function savePaperLogDay(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  timeZone: string,
  body: PaperLogSaveBody,
): Promise<SaveOutcome> {
  // Everything he submits is his word: every segment is confirmed.
  const segments: DraftSegment[] = body.segments.map((s) => ({
    status: s.status,
    startMin: s.start_min,
    endMin: s.end_min,
    confidence: null,
    origin: "edited",
  }));
  const validation = validateDraft(segments);
  if (!validation.ok) return { ok: false, kind: "invalid", errors: validation.errors };

  const { start, end } = dayBounds(body.log_date, timeZone);
  const toClock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const rows = toDutyRows(segments).map((r) => ({
    duty_status: r.status,
    started_at: paperSheetInstant(body.log_date, toClock(r.startMin), timeZone).toISOString(),
  }));

  const { data, error } = await client.rpc("save_paper_log_day", {
    p_document_id: documentId,
    p_day_start: start.toISOString(),
    p_day_end: end.toISOString(),
    p_rows: rows,
    p_replace_ids: body.replace_ids,
    p_notes: "Recreated from the paper log sheet photo and reviewed in the app.",
  });
  if (error) {
    if (error.hint === "paper_log_conflict") return { ok: false, kind: "conflict" };
    if (error.code === "P0002") return { ok: false, kind: "not_found" };
    if (error.code === "22023") return { ok: false, kind: "invalid", errors: [error.message] };
    throw new Error(error.message);
  }
  return { ok: true, inserted: typeof data === "number" ? data : rows.length };
}
