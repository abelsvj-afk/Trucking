// Telegram photo → document intake (design §13). The owner sends
// Abel a photo of paperwork (a BOL, a scale ticket, a receipt) and
// it lands in his documents — "snap a picture, send it, done."
//
// Flow, all of it before anything is stored, so a failure never
// leaves a half-stored document:
// 1. Pick the largest size Telegram offers (it sends several
//    renditions of the same photo; the largest is the readable one).
// 2. Oversize check against the documents pipeline's own 25MB cap —
//    first from Telegram's declared size, again from the getFile
//    result, and finally from the downloaded bytes themselves.
// 3. Download via the Bot API (getFile → file path → file bytes).
// 4. Store through the SHARED documents pipeline
//    (services/documents/store-document.ts) — same bucket, same
//    path convention, same row shape as a web upload. Filed under
//    the company itself (related_entity_type "company",
//    related_entity_id = the company id): a photo off the dock
//    doesn't arrive knowing which load it belongs to, and guessing
//    an attachment would file it wrong; he can re-file it from
//    More → Documents, and the assistant's document tools see it
//    either way (they list by company, not by entity).
// 5. Processing (the merge-time wiring, landed with this union):
//    when document text extraction is enabled for the company, the
//    stored photo goes through the SAME processor a web upload uses
//    (services/documents/process-document.ts) — scan rendition +
//    AI extraction, outcomes written onto the row. When extraction
//    is off, the photo is stored plainly and no processing runs.
// 6. Reply in plain words with what was stored — plus the
//    extraction state through the seam reader: off means off (said
//    plainly), done carries the doc type + the text's opening,
//    pending is named as pending, never dressed up as read.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_DOCUMENT_BYTES,
  StoreDocumentError,
  storeDocumentFile,
} from "@/services/documents/store-document";
import {
  getDocumentExtractionStatus,
  type DocumentExtractionStatus,
} from "@/services/documents/extraction-hook";
import {
  isExtractionEnabled,
  processUploadedDocument,
} from "@/services/documents/process-document";

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramPhotoIntakeDeps {
  client: SupabaseClient;
  companyId: string;
  botToken: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to the shared documents pipeline. */
  storeFile?: typeof storeDocumentFile;
  /** Injectable for tests; defaults to the §13 extraction seam reader. */
  extractionStatus?: (documentId: string) => Promise<DocumentExtractionStatus>;
  /**
   * Injectable for tests; defaults to the real post-store processing
   * (the extraction gate + document-scan's processor, §13). Resolves
   * "ran" when the processor ran, "off" when the gate is verifiably
   * closed for this company.
   */
  processDocument?: (documentId: string, fileBuffer: Buffer) => Promise<"ran" | "off">;
  now?: () => Date;
}

const TOO_BIG_REPLY =
  "That photo is bigger than the 25MB limit for documents, so I couldn't store it — nothing was saved. Try sending it again (Telegram usually compresses it), or upload it from More → Documents in the app.";

const DOWNLOAD_FAILED_REPLY =
  "I couldn't download that photo from Telegram, so nothing was stored. Send it again and I'll retry.";

const STORE_FAILED_REPLY =
  "I got the photo but couldn't save it into your documents — nothing was stored. Try again in a moment.";

/** Telegram sends several renditions; the largest (by declared size, else pixel area) is the readable one. */
export function pickLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  return photos.reduce((best, candidate) => {
    const score = (p: TelegramPhotoSize) => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);
    return score(candidate) > score(best) ? candidate : best;
  }, photos[0]!);
}

function photoFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `telegram-photo-${stamp}.jpg`;
}

function extractionLines(status: DocumentExtractionStatus): string[] {
  switch (status.state) {
    case "off":
      return [
        "Document text extraction is off right now, so I stored the photo itself without reading its text. (It lives under Settings → Document text extraction.)",
      ];
    case "done":
      return [
        status.docType
          ? `I read it as a ${status.docType}. What it says starts: "${status.summary}"`
          : `I read its text. It starts: "${status.summary}"`,
      ];
    case "processing":
      return [
        "Text extraction is on — the read of this one is still pending, so I can't quote it yet. It'll be readable under More → Documents.",
      ];
    case "failed":
      return [
        "Text extraction is on but reading this photo failed, so it's stored as a photo only for now.",
      ];
    case "unavailable":
      return [
        "Text extraction is switched on, but the reading piece isn't part of this build yet — the photo is stored, unread, until that update lands.",
      ];
  }
}

/**
 * Handles one photo message end to end and returns the exact reply
 * text for the owner. Never throws for an expected failure (too
 * big, download failed, store failed) — those come back as honest
 * replies that say nothing was stored.
 */
export async function handleTelegramPhoto(
  deps: TelegramPhotoIntakeDeps,
  photos: TelegramPhotoSize[],
  caption?: string,
): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const storeFile = deps.storeFile ?? storeDocumentFile;
  const now = deps.now ?? (() => new Date());

  const photo = pickLargestPhoto(photos);
  if (photo.file_size && photo.file_size > MAX_DOCUMENT_BYTES) return TOO_BIG_REPLY;

  // --- download (nothing stored yet) --------------------------------
  let bytes: ArrayBuffer;
  try {
    const fileRes = await fetchFn(
      `https://api.telegram.org/bot${deps.botToken}/getFile?file_id=${encodeURIComponent(photo.file_id)}`,
    );
    const fileJson = (await fileRes.json()) as {
      ok?: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    const filePath = fileJson.ok ? fileJson.result?.file_path : undefined;
    if (!filePath) return DOWNLOAD_FAILED_REPLY;
    if (fileJson.result?.file_size && fileJson.result.file_size > MAX_DOCUMENT_BYTES) {
      return TOO_BIG_REPLY;
    }
    const downloadRes = await fetchFn(
      `https://api.telegram.org/file/bot${deps.botToken}/${filePath}`,
    );
    if (!downloadRes.ok) return DOWNLOAD_FAILED_REPLY;
    bytes = await downloadRes.arrayBuffer();
  } catch {
    return DOWNLOAD_FAILED_REPLY;
  }
  if (bytes.byteLength === 0) return DOWNLOAD_FAILED_REPLY;
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return TOO_BIG_REPLY;

  // --- store through the shared documents pipeline -------------------
  const fileName = photoFileName(now());
  let documentId: string;
  try {
    const row = await storeFile(deps.client, {
      companyId: deps.companyId,
      relatedEntityType: "company",
      relatedEntityId: deps.companyId,
      fileName,
      body: new Blob([bytes], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      size: bytes.byteLength,
    });
    documentId = row.id;
  } catch (err) {
    if (err instanceof StoreDocumentError && err.kind === "validation") {
      return `I couldn't store that photo: ${err.message} Nothing was saved.`;
    }
    console.error("[telegram] photo store failed", err);
    return STORE_FAILED_REPLY;
  }

  // --- processing: the same pipeline a web upload runs (§13) --------
  // Only when extraction is enabled — the gate is process-document's
  // own, so "on" here means exactly what the web door means by it.
  // The processor never throws; a gate check that itself fails falls
  // through to the seam read below, which reports the state honestly.
  const processDocument =
    deps.processDocument ??
    (async (id: string, buf: Buffer): Promise<"ran" | "off"> => {
      if (!(await isExtractionEnabled(deps.client, deps.companyId))) return "off";
      await processUploadedDocument(deps.client, {
        companyId: deps.companyId,
        documentId: id,
        fileBuffer: buf,
        contentType: "image/jpeg",
        fileName,
      });
      return "ran";
    });
  let gateClosed = false;
  try {
    gateClosed = (await processDocument(documentId, Buffer.from(bytes))) === "off";
  } catch (err) {
    console.error("[telegram] photo processing failed", err);
  }

  // --- reply: what was stored, then the extraction state -------------
  const lines = [
    `Saved that photo as a document in your app (${fileName}) — filed under your company, not attached to a specific load or truck yet. You can file it against a record from More → Documents, and I can find it either way.`,
  ];
  const getStatus =
    deps.extractionStatus ??
    (async (id: string): Promise<DocumentExtractionStatus> =>
      gateClosed
        ? { state: "off" }
        : getDocumentExtractionStatus(deps.client, deps.companyId, id));
  try {
    lines.push(...extractionLines(await getStatus(documentId)));
  } catch (err) {
    console.error("[telegram] photo extraction status failed", err);
    lines.push("I couldn't check whether its text was read — the photo itself is saved either way.");
  }
  if (caption) lines.push(`Your note on it: "${caption}"`);
  return lines.join("\n");
}
