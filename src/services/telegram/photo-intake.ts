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
import { formatExtractedFieldsForReply } from "@/services/ai/document-extraction";

export interface ExtractedDocumentRead {
  docType: string | null;
  fields: Record<string, string | number | null>;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** One button choice on a photo-purpose ask (design §3.3). `choice` is a purpose slug or "store". */
export interface TelegramPhotoAskOption {
  label: string;
  choice: string;
}

/**
 * A photo reply that may carry a one-tap purpose ask: the text plus,
 * when a question is staged, the pending row's id and its button
 * choices (in display order; the numbered-text fallback numbers
 * them in this same order). Plain-string replies stay plain strings
 * everywhere else in the intake.
 */
export interface TelegramPhotoReply {
  text: string;
  ask?: { pendingId: string; options: TelegramPhotoAskOption[] };
  /**
   * Telegram fix round (brief fixes 7-9): when the reply's photo was
   * filed as a document, what it became - so a burst flush working a
   * photo TOGETHER with load text can stage the attach in the same
   * proposal instead of the photo vanishing into unattached storage.
   */
  filed?: FiledPhotoInfo;
}

/** A photo that intake stored as a document, with the identifiers read from it. */
export interface FiledPhotoInfo {
  documentId: string;
  fileName: string;
  identifiers: {
    trailerNumber?: string;
    pickupNumber?: string;
    sealNumber?: string;
  };
}

export type TelegramPhotoResult = string | TelegramPhotoReply;

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
  /** Injectable for tests; defaults to reading the stored document's structured extraction fields for the BOL read-back. */
  extractedDocument?: (documentId: string) => Promise<ExtractedDocumentRead | null>;
  /**
   * Injectable for tests; defaults to the real post-store processing
   * (the extraction gate + document-scan's processor, §13). Resolves
   * "ran" when the processor ran, "off" when the gate is verifiably
   * closed for this company.
   */
  processDocument?: (documentId: string, fileBuffer: Buffer) => Promise<"ran" | "off">;
  /**
   * GAP-01: after processing, stage record proposals from the
   * extracted fields (fuel receipt → fuel purchase, rate con →
   * load, …) and return the reply text for them, or null when
   * there's nothing to propose. Injectable for tests; defaults to
   * the real staging through the bot store.
   */
  stageProposals?: (documentId: string) => Promise<string | null>;
  now?: () => Date;
  /** UH-14 fix (injectable for tests): album grouping hooks; defaults wire ./album against the client. */
  album?: {
    findPrimary: (mediaGroupId: string) => Promise<import("./album").AlbumPrimary | null>;
    attachPage: (
      primary: import("./album").AlbumPrimary,
      bytes: ArrayBuffer,
    ) => Promise<number | null>;
    markPrimary: (documentId: string, mediaGroupId: string) => Promise<void>;
  };
  /** UH-03 fix (injectable for tests): matching pretrip-ask fulfilment for the legacy path; defaults to photo-purpose's matcher. */
  fulfilPretripAsks?: (input: { evidenceText: string; loadId: string | null }) => Promise<void>;
}

const TOO_BIG_REPLY =
  "That photo is bigger than the 25MB limit for documents, so I couldn't store it — nothing was saved. Try sending it again (Telegram usually compresses it), or upload it from More → Documents in the app.";

const DOWNLOAD_FAILED_REPLY =
  "I couldn't download that photo from Telegram, so nothing was stored. Send it again and I'll retry.";

const STORE_FAILED_REPLY =
  "I got the photo but couldn't save it into your documents — nothing was stored. Try again in a moment.";

/**
 * Telegram sends several renditions; the readable one is the
 * highest-RESOLUTION one. (Repairs D7: byte size and pixel area
 * used to be compared per-rendition in mixed units, so a
 * higher-resolution but better-compressed rendition could lose
 * to a smaller, denser file - the worse choice for extraction.
 * Pixel area decides when dimensions are known; declared byte
 * size breaks ties and is the fallback when they aren't.)
 */
export function pickLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  const area = (p: TelegramPhotoSize) =>
    p.width && p.height ? p.width * p.height : 0;
  return photos.reduce((best, candidate) => {
    const areaDiff = area(candidate) - area(best);
    if (areaDiff !== 0) return areaDiff > 0 ? candidate : best;
    return (candidate.file_size ?? 0) > (best.file_size ?? 0) ? candidate : best;
  }, photos[0]!);
}

export function photoFileName(now: Date): string {
  // Doc-intake hunt DH-7: the stamp is quoted back to the owner in
  // the intake reply, so it is built on his wall clock
  // (America/New_York) - never a UTC stamp on a user-facing surface
  // (standing rule; src/lib/eastern-date.ts is the date-only kin).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const stamp = `${part("year")}${part("month")}${part("day")}${part("hour")}${part("minute")}${part("second")}`;
  return `telegram-photo-${stamp}.jpg`;
}

export function extractionLines(status: DocumentExtractionStatus): string[] {
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

export type TelegramPhotoDownload =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; reply: string };

/**
 * Downloads one Telegram photo rendition with the pipeline's
 * triple oversize check (declared size, getFile size, actual
 * bytes). Shared by the legacy intake and the photo-intelligence
 * front door (§3) - one download path, one set of honest failures.
 */
export async function downloadTelegramPhoto(
  deps: { botToken: string; fetchFn?: typeof fetch },
  photo: TelegramPhotoSize,
): Promise<TelegramPhotoDownload> {
  const fetchFn = deps.fetchFn ?? fetch;
  if (photo.file_size && photo.file_size > MAX_DOCUMENT_BYTES) {
    return { ok: false, reply: TOO_BIG_REPLY };
  }
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
    if (!filePath) return { ok: false, reply: DOWNLOAD_FAILED_REPLY };
    if (fileJson.result?.file_size && fileJson.result.file_size > MAX_DOCUMENT_BYTES) {
      return { ok: false, reply: TOO_BIG_REPLY };
    }
    const downloadRes = await fetchFn(
      `https://api.telegram.org/file/bot${deps.botToken}/${filePath}`,
    );
    if (!downloadRes.ok) return { ok: false, reply: DOWNLOAD_FAILED_REPLY };
    bytes = await downloadRes.arrayBuffer();
  } catch {
    return { ok: false, reply: DOWNLOAD_FAILED_REPLY };
  }
  if (bytes.byteLength === 0) return { ok: false, reply: DOWNLOAD_FAILED_REPLY };
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, reply: TOO_BIG_REPLY };
  return { ok: true, bytes };
}

export type TelegramPhotoStore =
  | { ok: true; documentId: string; fileName: string }
  | { ok: false; reply: string };

/** Stores downloaded photo bytes through the shared documents pipeline (filed under the company, caption on the row). */
export async function storeTelegramPhoto(
  deps: TelegramPhotoIntakeDeps,
  bytes: ArrayBuffer,
  caption?: string,
): Promise<TelegramPhotoStore> {
  const storeFile = deps.storeFile ?? storeDocumentFile;
  const now = deps.now ?? (() => new Date());
  const fileName = photoFileName(now());
  try {
    const row = await storeFile(deps.client, {
      companyId: deps.companyId,
      relatedEntityType: "company",
      relatedEntityId: deps.companyId,
      fileName,
      body: new Blob([bytes], { type: "image/jpeg" }),
      contentType: "image/jpeg",
      size: bytes.byteLength,
      // Lane 1 (audit B-6): his caption is stored on the document
      // row itself (searchable), not only echoed in this reply.
      caption,
    });
    return { ok: true, documentId: row.id, fileName };
  } catch (err) {
    if (err instanceof StoreDocumentError && err.kind === "validation") {
      return { ok: false, reply: `I couldn't store that photo: ${err.message} Nothing was saved.` };
    }
    console.error("[telegram] photo store failed", err);
    return { ok: false, reply: STORE_FAILED_REPLY };
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
  mediaGroupId?: string,
): Promise<string> {
  const photo = pickLargestPhoto(photos);
  const download = await downloadTelegramPhoto(deps, photo);
  if (!download.ok) return download.reply;

  // --- UH-14 fix: album pages attach to the group's ONE document --
  const album = deps.album ?? {
    findPrimary: async (gid: string) => {
      const { findAlbumPrimary } = await import("./album");
      return findAlbumPrimary(deps.client, deps.companyId, gid);
    },
    attachPage: async (primary: import("./album").AlbumPrimary, b: ArrayBuffer) => {
      const { attachAlbumPage } = await import("./album");
      return attachAlbumPage(deps.client, deps.companyId, primary, b);
    },
    markPrimary: async (documentId: string, gid: string) => {
      const { markAlbumPrimary } = await import("./album");
      const { data: row } = await deps.client
        .from("documents")
        .select("storage_path, extracted_fields")
        .eq("id", documentId)
        .eq("company_id", deps.companyId)
        .maybeSingle();
      const r = row as { storage_path: string; extracted_fields: Record<string, unknown> | null } | null;
      if (r) await markAlbumPrimary(deps.client, deps.companyId, documentId, gid, r.storage_path, r.extracted_fields);
    },
  };
  if (mediaGroupId) {
    try {
      const primary = await album.findPrimary(mediaGroupId);
      if (primary) {
        const pageCount = await album.attachPage(primary, download.bytes);
        if (pageCount != null) {
          // DH-6: honest scope - the pages are stored together, but
          // extraction reads page 1; don't claim a combined read.
          return `Added that as page ${pageCount} of the document you just sent — all its pages are stored together under that one document. I read the first page for its details; the rest are kept with it.`;
        }
        // Attach failed — fall through and store it as its own
        // document rather than losing the photo.
        console.error("[telegram] album attach failed; storing page as its own document");
      }
    } catch (err) {
      console.error("[telegram] album grouping failed; storing as single document", err);
    }
  }

  // --- store through the shared documents pipeline -------------------
  const stored = await storeTelegramPhoto(deps, download.bytes, caption);
  if (!stored.ok) return stored.reply;
  const documentId = stored.documentId;
  const fileName = stored.fileName;
  const bytes = download.bytes;
  if (mediaGroupId) {
    try {
      await album.markPrimary(documentId, mediaGroupId);
    } catch (err) {
      console.error("[telegram] album primary marking failed", err);
    }
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
  let status: DocumentExtractionStatus | null = null;
  try {
    status = await getStatus(documentId);
    lines.push(...extractionLines(status));
    if (status.state === "done" && status.docType === "bol") {
      try {
        const extracted =
          (await (deps.extractedDocument ??
            (async (id: string): Promise<ExtractedDocumentRead | null> => {
              const { data, error } = await deps.client
                .from("documents")
                .select("doc_type, extracted_fields")
                .eq("id", id)
                .eq("company_id", deps.companyId)
                .maybeSingle();
              if (error || !data) return null;
              const row = data as {
                doc_type: string | null;
                extracted_fields: Record<string, string | number | null> | null;
              };
              return { docType: row.doc_type, fields: row.extracted_fields ?? {} };
            }))(documentId)) ?? null;
        if (extracted) {
          lines.push(...formatExtractedFieldsForReply(extracted.docType ?? status.docType, extracted.fields));
        }
      } catch (err) {
        console.error("[telegram] photo extracted-field read-back failed", err);
      }
    }
  } catch (err) {
    console.error("[telegram] photo extraction status failed", err);
    lines.push("I couldn't check whether its text was read — the photo itself is saved either way.");
  }
  // GAP-01: the read document becomes the record it describes —
  // staged as a proposal batch for his yes, never recorded silently.
  // A staging failure never costs him the stored photo or its reply.
  try {
    const stageProposals =
      deps.stageProposals ??
      (async (id: string): Promise<string | null> => {
        const { stageDocumentProposalsForClient } = await import(
          "@/services/documents/document-proposals"
        );
        const { formatRecordableOutcome } = await import("@/services/bot/stage-recordables");
        const result = await stageDocumentProposalsForClient(deps.client, deps.companyId, id, "telegram");
        return result ? formatRecordableOutcome(result) || null : null;
      });
    const proposalText = await stageProposals(documentId);
    if (proposalText) lines.push(proposalText.trim());
  } catch (err) {
    console.error("[telegram] document proposal staging failed", err);
  }
  // UH-03 fix: the legacy path also fulfils MATCHING pretrip_photo
  // asks (it never fired before). Evidence = the read doc type plus
  // his caption; the matcher requires load + full item coverage.
  try {
    const fulfil =
      deps.fulfilPretripAsks ??
      (async (input: { evidenceText: string; loadId: string | null }) => {
        const brain = (deps as { brainStore?: import("@/services/bot/store").BotBrainStore }).brainStore;
        const client = brain?.client ?? deps.client;
        const { fulfilMatchingPretripAsk } = await import("./photo-purpose");
        await fulfilMatchingPretripAsk(client, deps.companyId, input);
      });
    const statusForEvidence = status ?? (await getStatus(documentId).catch(() => null));
    const evidenceText = [
      statusForEvidence?.state === "done" ? (statusForEvidence.docType ?? "") : "",
      caption ?? "",
    ].join(" ");
    if (evidenceText.trim().length > 0) {
      await fulfil({ evidenceText, loadId: null });
    }
  } catch (err) {
    console.error("[telegram] legacy pretrip fulfilment failed", err);
  }
  if (caption) lines.push(`Your note on it: "${caption}"`);
  return lines.join("\n");
}
