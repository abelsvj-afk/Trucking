// Photo intelligence front door (design: Trucking-Telegram-Image-
// Maintenance-Design-2026-11-02.md §3). The beats, in order:
//
// 0. Kill switch: photo_intelligence off (or the global AI switch)
//    and a photo behaves EXACTLY as it did before this feature -
//    the legacy intake runs untouched (§3.4, acceptance A3).
// 1. Store first, always (a photo is evidence; losing it because
//    classification failed would be the worst outcome) - but
//    stored UNFILED: no purpose, no pipeline, until purpose settles.
// 2. Caption first (free): a caption naming a purpose settles it
//    with no vision call at all.
// 3. Classify: one small vision call on the scan rendition returns
//    purpose + confidence + the read.
// 4. Act or ask on the §3.2 thresholds: confident reads narrate
//    and settle; anything less stages a one-tap question (buttons
//    with a numbered-text spine) and files NOTHING under the
//    guessed purpose. A classifier failure is honest: the photo
//    stays stored and the reply says he can name its purpose
//    whenever - a photo is never silently filed blind (§3.1).

import type { SupabaseClient } from "@supabase/supabase-js";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import type { AiVisionProvider } from "@/services/ai/provider";
import {
  classifyPhoto,
  purposeFromCaption,
  PHOTO_PURPOSE_THRESHOLDS,
  type PhotoClassification,
} from "@/services/ai/photo-classification";
import { createScanRendition } from "@/services/documents/scan-image";
import type { BotBrainStore } from "@/services/bot/store";
import {
  downloadTelegramPhoto,
  handleTelegramPhoto,
  pickLargestPhoto,
  storeTelegramPhoto,
  type TelegramPhotoIntakeDeps,
  type TelegramPhotoResult,
  type TelegramPhotoSize,
} from "./photo-intake";
import {
  askOptionsFor,
  buildPurposeCandidates,
  settlePhotoPurpose,
  stagePhotoPurposeAsk,
  type PhotoPurposeAskArgs,
} from "./photo-purpose";

export interface TelegramPhotoIntelligenceDeps extends TelegramPhotoIntakeDeps {
  /** The shared brain store: the capability check and (Phase 2+) proposal staging. */
  brainStore: BotBrainStore;
  /** Injectable for tests; defaults to the real OpenAI provider. */
  createVisionProvider?: () => AiVisionProvider;
}

const CLASSIFIER_FAILED_REPLY =
  "I saved that photo in your documents, but I couldn't tell what it is — so I just stored it rather than guess. Tell me what it's for whenever and I'll file it right.";

function defaultVisionProvider(): AiVisionProvider {
  return new OpenAiProvider();
}

/**
 * Handles one photo message through the intelligent front door.
 * Return shape matches the legacy intake's reply, widened: an ask
 * comes back as { text, ask } so the caller can attach Telegram
 * buttons (with the numbered-text fallback when it can't).
 */
export async function handleTelegramPhotoIntelligent(
  deps: TelegramPhotoIntelligenceDeps,
  photos: TelegramPhotoSize[],
  caption?: string,
): Promise<TelegramPhotoResult> {
  // Beat 0 - the kill switch (§3.4). A failed check degrades to
  // the legacy path too: the photo must never be lost to a
  // settings-read error, and the legacy path's own behavior is the
  // honest pre-feature behavior either way.
  let enabled = false;
  try {
    enabled = await deps.brainStore.isPhotoIntelligenceEnabled();
  } catch (err) {
    console.error("[telegram] photo intelligence capability check failed", err);
  }
  if (!enabled) {
    return handleTelegramPhoto(deps, photos, caption);
  }

  // Beat 1 - store first, unfiled.
  const photo = pickLargestPhoto(photos);
  const download = await downloadTelegramPhoto(deps, photo);
  if (!download.ok) return download.reply;
  const stored = await storeTelegramPhoto(deps, download.bytes, caption);
  if (!stored.ok) return stored.reply;
  const documentId = stored.documentId;
  const bytes = Buffer.from(download.bytes);

  const settleDeps = {
    client: deps.client as SupabaseClient,
    companyId: deps.companyId,
    brainStore: deps.brainStore,
    // The §13 processing wiring, when a caller injects it (tests);
    // in production these stay undefined and settling runs the
    // shared gate + processor itself.
    processDocument: deps.processDocument,
    extractionStatus: deps.extractionStatus,
  };

  // Beat 2 - caption first (free, no vision call).
  const captionPurpose = purposeFromCaption(caption);
  if (captionPurpose) {
    const result = await settlePhotoPurpose(settleDeps, {
      documentId,
      choice: captionPurpose,
      source: "caption",
      confidence: null,
      knownBytes: bytes,
    });
    return caption ? `${result.reply}\nYour note on it: "${caption}"` : result.reply;
  }

  // Beat 3 - classify on the scan rendition when one can be made
  // (the crisp small read), the original bytes otherwise.
  let classification: PhotoClassification;
  try {
    const scan = await createScanRendition(bytes, "image/jpeg");
    const provider = (deps.createVisionProvider ?? defaultVisionProvider)();
    classification = await classifyPhoto(provider, {
      imageBase64: (scan ?? bytes).toString("base64"),
      mediaType: scan ? "image/png" : "image/jpeg",
    });
  } catch (err) {
    console.error("[telegram] photo classification failed", err);
    return caption
      ? `${CLASSIFIER_FAILED_REPLY}\nYour note on it: "${caption}"`
      : CLASSIFIER_FAILED_REPLY;
  }

  // Beat 4 - act or ask (§3.2 thresholds).
  const { act, ask } = PHOTO_PURPOSE_THRESHOLDS;
  if (classification.confidence >= act) {
    const result = await settlePhotoPurpose(settleDeps, {
      documentId,
      choice: classification.purpose,
      source: "vision",
      confidence: classification.confidence,
      headline: classification.headline,
      fields: classification.fields,
      fieldConfidences: classification.field_confidences,
      knownBytes: bytes,
    });
    return caption ? `${result.reply}\nYour note on it: "${caption}"` : result.reply;
  }

  const candidates = buildPurposeCandidates(classification);
  const askArgs: PhotoPurposeAskArgs = {
    document_id: documentId,
    headline: classification.headline,
    fields: classification.fields,
    field_confidences: classification.field_confidences,
    candidates,
    classifier_confidence: classification.confidence,
  };
  const summary =
    classification.confidence >= ask
      ? `Photo purpose question: it looks like ${classification.purpose} - "${classification.headline}"`
      : `Photo purpose question: an unidentified photo - "${classification.headline}"`;
  const pendingId = await stagePhotoPurposeAsk(deps.client, deps.companyId, askArgs, summary);
  if (!pendingId) {
    // The question couldn't be staged (pending-actions trouble):
    // narrate the read and leave the photo stored-unfiled rather
    // than show buttons that resolve nothing.
    const lines = [
      classification.headline,
      "I saved the photo, but I couldn't line up the tap-to-file question for it — tell me what it's for and I'll file it right.",
    ];
    if (caption) lines.push(`Your note on it: "${caption}"`);
    return lines.join("\n");
  }

  const options = askOptionsFor(candidates);
  const text =
    classification.confidence >= ask
      ? `${classification.headline}\n\nAm I right about what this photo is? Tap one — nothing is filed under it until you pick.`
      : `I saved that photo, but I'm not sure what it is. What should I file it as?`;
  return { text: caption ? `${text}\nYour note on it: "${caption}"` : text, ask: { pendingId, options } };
}
