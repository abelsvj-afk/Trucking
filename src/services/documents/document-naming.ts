// Content-derived document names (Telegram review D8, 2026-11-12).
// A filed document is named from what it IS - the vision/extraction
// read plus the trip it belongs to - never from the storage key
// (telegram-photo-<stamp>.jpg). The raw name stays only as the
// stored-file key (storage_path); no owner-facing surface shows it.

export interface DocumentNameInput {
  /** The extraction classifier's kind (bol, fuel_receipt, ...), if read. */
  docType?: string | null;
  /** The extraction's opening text / vision description, if read. */
  summary?: string | null;
  /** His caption on the photo, if any. */
  caption?: string | null;
}

const KIND_LABELS: Record<string, string> = {
  bol: "BOL",
  rate_confirmation: "Rate confirmation",
  scale_ticket: "Scale ticket",
  fuel_receipt: "Fuel receipt",
  settlement: "Settlement",
};

/** The storage-key shape: telegram-photo-<ET stamp>.jpg (and siblings). */
const RAW_PHOTO_FILE_NAME = /^telegram-(photo|document|file)-\d+\.\w+$/i;

export function isRawPhotoFileName(fileName: string): boolean {
  return RAW_PHOTO_FILE_NAME.test(fileName.trim());
}

function tripNumberFrom(text: string): string | null {
  const m = text.match(/trip\s*#?\s*(\d{3,6})/i);
  return m ? m[1]! : null;
}

/**
 * A detail in parentheses, only from words actually in the vision
 * read - never invented: "trailer H1181 side view", "trailer H1181",
 * "seal photo".
 */
function detailFrom(summary: string): string | null {
  const trailer = summary.match(/trailer\s+([A-Za-z0-9][A-Za-z0-9-]{2,12})/i);
  if (trailer) {
    const unit = trailer[1]!.toUpperCase();
    return /side view/i.test(summary) ? `trailer ${unit} side view` : `trailer ${unit}`;
  }
  if (/\bseal\b/i.test(summary)) return "seal photo";
  return null;
}

/**
 * The document's name in his words ("Trip 1874 — BOL (seal photo)"),
 * or null when the kind is genuinely unknown - the caller then asks
 * him once with the vision description instead of filing it unnamed.
 * A caption can name the kind even when extraction did not
 * ("Bol for trip 1874"); a trip number alone is not a kind.
 */
export function documentDisplayName(input: DocumentNameInput): string | null {
  const summary = input.summary?.trim() ?? "";
  const caption = input.caption?.trim() ?? "";
  let kind: string | null = null;
  if (input.docType && KIND_LABELS[input.docType]) kind = KIND_LABELS[input.docType]!;
  if (!kind && /\bbol\b/i.test(caption)) kind = "BOL";
  if (!kind && /\bbill of lading\b/i.test(summary)) kind = "BOL";
  if (!kind) return null;
  const trip = tripNumberFrom(caption) ?? tripNumberFrom(summary);
  const detail = detailFrom(summary);
  const head = trip ? `Trip ${trip} — ${kind}` : kind;
  return detail ? `${head} (${detail})` : head;
}

/**
 * What a stored file_name shows as: a raw telegram-photo-* key shows
 * its kind (or "photo"), never the key itself. Any other name is
 * already human and passes through unchanged.
 */
export function displayFileName(fileName: string, docType?: string | null): string {
  if (!isRawPhotoFileName(fileName)) return fileName;
  if (docType && KIND_LABELS[docType]) return KIND_LABELS[docType]!;
  return "photo";
}
