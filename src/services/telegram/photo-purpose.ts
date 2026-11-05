// Photo purpose (design: Trucking-Telegram-Image-Maintenance-
// Design-2026-11-02.md §3). The machinery behind the front door's
// third beat: a photo's purpose is settled - by the vision read,
// by his caption, or by the owner himself through a one-tap ask -
// and ONLY then does the purpose's pipeline run. Nothing is ever
// filed under a guessed purpose.
//
// The ask rides the existing bot_pending_actions machinery with a
// sentinel tool name (migration note, design §6): no schema
// change, the same 2-hour expiry, the same oldest-first resolution
// discipline. It is a QUESTION, not a write proposal - resolving it
// never executes a write tool; it stamps the document's purpose
// and runs that purpose's pipeline, which stages its own write
// proposals where a record change is implied (§3.3: buttons never
// bypass propose->approve for writes).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PHOTO_PURPOSE_THRESHOLDS,
  type PhotoClassification,
  type PhotoClassificationFields,
  type PhotoPurpose,
} from "@/services/ai/photo-classification";
import type { DocumentExtractionStatus } from "@/services/documents/extraction-hook";
import { isMissingColumnError } from "@/services/bot/tool-helpers";
import type { BotBrainStore, PendingAction } from "@/services/bot/store";
import type { ExtractedDocumentRead, TelegramPhotoAskOption } from "./photo-intake";
import {
  stageOdometerPhoto,
  stageTrailerPhoto,
  stageTruckPhoto,
} from "./vehicle-photos";
import type { PaperLogExtraction } from "@/services/ai/paper-log-extraction";
import { stagePaperLogDay } from "@/services/fleet/paper-logs";
import { persistPaperLogRead } from "@/services/fleet/paper-log-review";

/** Sentinel tool_name for a photo-purpose question in bot_pending_actions (design §6). */
export const PHOTO_PURPOSE_TOOL = "photo_purpose";

/** Same 2-hour expiry as every pending proposal - a stale tap must never settle a purpose late. */
export const PHOTO_ASK_EXPIRY_MS = 2 * 60 * 60 * 1000;

/** The ask's non-purpose choice: file it as a plain document, no purpose marked (§3.2). */
export const PHOTO_STORE_CHOICE = "store";

export type PhotoPurposeChoice = PhotoPurpose | typeof PHOTO_STORE_CHOICE;

export const PURPOSE_META: Record<PhotoPurpose, { label: string; emoji: string }> = {
  paperwork: { label: "Paperwork", emoji: "📄" },
  paper_log: { label: "Paper log sheet", emoji: "📋" },
  truck_exterior: { label: "The truck", emoji: "🚛" },
  trailer: { label: "The trailer", emoji: "🚚" },
  odometer_dash: { label: "Odometer / dash", emoji: "🔢" },
  pretrip: { label: "Pre-trip", emoji: "🔍" },
  other: { label: "Something else", emoji: "📷" },
};

export interface PhotoPurposeCandidate {
  purpose: PhotoPurpose;
  confidence: number;
}

/** The ask row's arguments: everything a later tap needs to settle without re-reading the photo. */
export interface PhotoPurposeAskArgs {
  document_id: string;
  headline: string;
  fields: PhotoClassificationFields;
  /** Per-field confidences from the read (Phase 2 pipelines stage fields on their own numbers). */
  field_confidences?: Record<string, number>;
  candidates: PhotoPurposeCandidate[];
  classifier_confidence: number;
}

/** Candidate purposes for an ask: the read's top purpose, then its alternates, deduped, at most 3. */
export function buildPurposeCandidates(classification: PhotoClassification): PhotoPurposeCandidate[] {
  const seen = new Set<PhotoPurpose>([classification.purpose]);
  const candidates: PhotoPurposeCandidate[] = [
    { purpose: classification.purpose, confidence: classification.confidence },
  ];
  for (const alt of classification.alternates) {
    if (seen.has(alt.purpose)) continue;
    seen.add(alt.purpose);
    candidates.push({ purpose: alt.purpose, confidence: alt.confidence });
    if (candidates.length >= 3) break;
  }
  return candidates;
}

/** Button/numbered options for an ask, in display order, with "Just file it" always last. */
export function askOptionsFor(candidates: PhotoPurposeCandidate[]): TelegramPhotoAskOption[] {
  return [
    ...candidates.map((c) => ({
      label: `${PURPOSE_META[c.purpose].emoji} ${PURPOSE_META[c.purpose].label}`,
      choice: c.purpose as string,
    })),
    { label: "🗂 Just file it", choice: PHOTO_STORE_CHOICE },
  ];
}

// ---------------------------------------------------------------------------
// Purpose stamping (migration 00045)
// ---------------------------------------------------------------------------

export type PhotoPurposeSource = "vision" | "caption" | "owner";

/**
 * Stamps the settled purpose on the document row. Graceful before
 * migration 00045 lands (the house pattern): a missing column logs
 * and reports false - the photo is still stored and the reply still
 * names its purpose; the stamp is provenance, not the filing.
 */
export async function stampPhotoPurpose(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  stamp: { purpose: PhotoPurpose; source: PhotoPurposeSource; confidence: number | null },
): Promise<boolean> {
  const { error } = await client
    .from("documents")
    .update({
      photo_purpose: stamp.purpose,
      photo_purpose_source: stamp.source,
      photo_purpose_confidence: stamp.confidence,
    })
    .eq("id", documentId)
    .eq("company_id", companyId);
  if (!error) return true;
  if (isMissingColumnError(error)) {
    console.error("[telegram] photo purpose stamp skipped - migration 00045 not applied yet");
    return false;
  }
  console.error("[telegram] photo purpose stamp failed", error.message);
  return false;
}

// ---------------------------------------------------------------------------
// The ask: staging + loading
// ---------------------------------------------------------------------------

/**
 * Stages a photo-purpose question as a pending-action row and
 * resolves its id (the buttons carry it). Direct insert - the
 * brain store's savePendingAction doesn't return the id, and the
 * id is the whole addressing scheme for callback taps. Resolves
 * null when the row can't be staged: the caller then degrades to
 * narration + "tell me what it is" (never a dead button).
 */
export async function stagePhotoPurposeAsk(
  client: SupabaseClient,
  companyId: string,
  args: PhotoPurposeAskArgs,
  summary: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("bot_pending_actions")
    .insert({
      company_id: companyId,
      channel: "telegram",
      tool_name: PHOTO_PURPOSE_TOOL,
      arguments: args,
      summary,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[telegram] failed to stage photo purpose ask", error.message);
    return null;
  }
  return (data as { id?: string } | null)?.id ?? null;
}

export interface LoadedPhotoAsk {
  id: string;
  args: PhotoPurposeAskArgs;
  summary: string;
  createdAt: string;
}

export async function loadPhotoPurposeAsk(
  client: SupabaseClient,
  companyId: string,
  id: string,
): Promise<LoadedPhotoAsk | null> {
  const { data, error } = await client
    .from("bot_pending_actions")
    .select("id, arguments, summary, created_at")
    .eq("id", id)
    .eq("company_id", companyId)
    .eq("tool_name", PHOTO_PURPOSE_TOOL)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[telegram] failed to load photo purpose ask", error.message);
    return null;
  }
  if (!data) return null;
  const row = data as { id: string; arguments: PhotoPurposeAskArgs; summary: string; created_at: string };
  return { id: row.id, args: row.arguments, summary: row.summary, createdAt: row.created_at };
}

export async function clearPhotoPurposeAsk(
  client: SupabaseClient,
  companyId: string,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("bot_pending_actions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (error) console.error("[telegram] failed to clear photo purpose ask", error.message);
}

/**
 * Doc-intake hunt DH-4: claims an ask ATOMICALLY and reports whether
 * THIS caller won. The conditional update only lands while the row
 * is still open, and the affected-row count names the winner: two
 * taps on the same question arrive as distinct updates (the
 * update_id dedup can't merge them), and the old load-then-clear
 * sequence let both taps load the ask before either cleared it -
 * settling twice, with duplicate staged proposals for one photo.
 * A client that reports no count keeps the historical proceed
 * behavior; PostgREST with count:"exact" always reports one.
 */
export async function claimPhotoPurposeAsk(
  client: SupabaseClient,
  companyId: string,
  id: string,
): Promise<boolean> {
  const { error, count } = await client
    .from("bot_pending_actions")
    .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (error) {
    console.error("[telegram] failed to claim photo purpose ask", error.message);
    return false;
  }
  return count !== 0;
}

// ---------------------------------------------------------------------------
// Answer parsing (the numbered-text spine, §3.3)
// ---------------------------------------------------------------------------

const PURPOSE_WORDS: { pattern: RegExp; purpose: PhotoPurpose }[] = [
  { purpose: "pretrip", pattern: /^(pre[-\s]?trip|walk[-\s]?around)$/ },
  { purpose: "paper_log", pattern: /^(paper[-\s]?logs?|log[-\s]?sheet|logs?)$/ },
  { purpose: "odometer_dash", pattern: /^(odometer|dash(board)?|mileage)$/ },
  { purpose: "trailer", pattern: /^trailer$/ },
  { purpose: "paperwork", pattern: /^(paperwork|document|bol|receipt)$/ },
  { purpose: "truck_exterior", pattern: /^(truck|the truck|cab)$/ },
  { purpose: "other", pattern: /^(other|something else)$/ },
];

function purposeFromWord(word: string): PhotoPurpose | null {
  const normalized = word.trim().toLowerCase().replace(/[.!]+$/, "");
  for (const entry of PURPOSE_WORDS) {
    if (entry.pattern.test(normalized)) return entry.purpose;
  }
  // A raw purpose slug or the exact button label also settles it.
  for (const [slug, meta] of Object.entries(PURPOSE_META)) {
    if (normalized === slug || normalized === meta.label.toLowerCase()) {
      return slug as PhotoPurpose;
    }
  }
  return null;
}

/**
 * Parses his reply to a photo-purpose ask, in code (§3.3: the
 * numbered text list resolves through the same grammar as every
 * other pending question). Accepts: a bare number over the shown
 * options (candidates in order, "store" last), a bare purpose word
 * or label, a "that's the trailer"-style naming, or a store
 * phrase. Anything else resolves null - the ask stays open and the
 * conversation proceeds (conversation never gets trapped by an
 * ask, and a purpose is never settled by a guess at his prose).
 */
export function parsePhotoPurposeAnswer(
  text: string,
  candidates: PhotoPurposeCandidate[],
): PhotoPurposeChoice | null {
  const options: PhotoPurposeChoice[] = [
    ...candidates.map((c) => c.purpose as PhotoPurposeChoice),
    PHOTO_STORE_CHOICE,
  ];
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");

  const bareNumber = normalized.match(/^(\d{1,2})$/);
  if (bareNumber) {
    const index = Number.parseInt(bareNumber[1]!, 10) - 1;
    return index >= 0 && index < options.length ? options[index]! : null;
  }

  if (
    normalized === "just file it" ||
    normalized === "file it" ||
    normalized === "store it" ||
    normalized === "none" ||
    normalized === "none of these" ||
    normalized === "skip"
  ) {
    return PHOTO_STORE_CHOICE;
  }

  const naming = normalized.match(/^(?:that'?s|it'?s|this is|it is)\s+(?:the\s+|a\s+|an\s+)?(.+)$/);
  const word = naming ? naming[1]! : normalized;
  const purpose = purposeFromWord(word);
  if (purpose && options.includes(purpose)) return purpose;
  return null;
}

// ---------------------------------------------------------------------------
// Settling: stamp + the purpose's pipeline
// ---------------------------------------------------------------------------

export interface SettlePhotoPurposeDeps {
  client: SupabaseClient;
  companyId: string;
  /** Present when a surface can stage follow-up write proposals (Phases 2+ pipelines). */
  brainStore?: BotBrainStore;
  /** Injectable for tests; defaults to the shared processor wiring (gate + processUploadedDocument). */
  processDocument?: (documentId: string, fileBuffer: Buffer) => Promise<"ran" | "off">;
  /** Injectable for tests; defaults to the §13 extraction seam reader. */
  extractionStatus?: (documentId: string) => Promise<DocumentExtractionStatus>;
  /** Injectable for tests; defaults to reading the stored document's structured extraction fields for the BOL read-back. */
  extractedDocument?: (documentId: string) => Promise<ExtractedDocumentRead | null>;
  /** Injectable for tests; defaults to downloading the sheet and running the §7 paper-log reader. */
  readPaperLog?: (documentId: string, knownBytes?: Buffer) => Promise<PaperLogExtraction>;
  /** UH-02 fix (injectable for tests): stage GAP-01 document proposals for a settled paperwork photo, exactly like the legacy intake does. Resolves the outcome line to append, or null. */
  stageProposals?: (documentId: string) => Promise<string | null>;
  /** UH-13 fix (injectable for tests): advisory clarity check on the photo bytes. Resolves true when the photo looks blurry. Never blocks filing. */
  clarityCheck?: (bytes: Buffer) => Promise<boolean>;
}

export interface SettlePhotoPurposeInput {
  documentId: string;
  choice: PhotoPurposeChoice;
  source: PhotoPurposeSource;
  /** The classifier's confidence for this purpose (null for caption-settled). */
  confidence?: number | null;
  headline?: string;
  fields?: PhotoClassificationFields;
  /** Per-field confidences from the classifier read (Phase 2 staging bars read these). */
  fieldConfidences?: Record<string, number>;
  /** The photo bytes, when the caller still holds them (intake act path) - saves a storage re-download. */
  knownBytes?: Buffer;
}

export interface SettlePhotoPurposeResult {
  reply: string;
}

function formatMiles(miles: number): string {
  return miles.toLocaleString("en-US");
}

function readLines(
  fields: PhotoClassificationFields | undefined,
  fieldConfidences?: Record<string, number>,
): string[] {
  if (!fields) return [];
  // Telegram repairs D8: a field whose own confidence is recorded
  // BELOW the ask bar is a candidate, not a read - it is not
  // narrated as fact here (the staging pipelines apply their own
  // bars separately). Fields with no recorded confidence (the
  // caption path carries none) narrate as before.
  const readable = (key: string): boolean => {
    const conf = fieldConfidences?.[key];
    return conf === undefined || conf >= PHOTO_PURPOSE_THRESHOLDS.ask;
  };
  const parts: string[] = [];
  if (fields.unit_number && readable("unit_number")) parts.push(`unit ${fields.unit_number}`);
  if (fields.make && readable("make")) {
    parts.push(fields.model && readable("model") ? `${fields.make} ${fields.model}` : fields.make);
  }
  if (fields.truck_type && readable("truck_type")) parts.push(fields.truck_type.replace(/_/g, " "));
  if (fields.trailer_unit_number && readable("trailer_unit_number")) {
    parts.push(`trailer ${fields.trailer_unit_number}`);
  }
  if (fields.trailer_type && readable("trailer_type")) parts.push(fields.trailer_type.replace(/_/g, " "));
  const lines: string[] = [];
  if (parts.length > 0) lines.push(`What I could read: ${parts.join(" · ")}.`);
  if (fields.seal_number && readable("seal_number")) {
    lines.push(
      `Seal #: ${fields.seal_number}${fields.seal_condition ? ` (${fields.seal_condition})` : ""}.`,
    );
  } else if (fields.seal_condition && readable("seal_condition")) {
    lines.push(`Seal condition: ${fields.seal_condition}.`);
  }
  if (fields.door_company_name && readable("door_company_name")) {
    lines.push(`The door says: ${fields.door_company_name}.`);
  }
  if (fields.description) lines.push(fields.description);
  return lines;
}

export * from "./photo-purpose-pipelines";
import { settlePaperwork, runVehiclePipeline, defaultReadPaperLog, pretripPhotoFollowUps } from "./photo-purpose-pipelines";

/**
 * Settles a photo's purpose: stamps the document (unless the
 * choice was "store" - his explicit "just file it" leaves the
 * purpose unmarked, per §3.2) and runs the purpose's pipeline:
 * paperwork hands off to the existing extraction pipeline
 * untouched; truck / trailer / dash run the Phase 2 staging
 * pipelines (§4.2-4.4) when a brain store is wired, and narrate
 * only when one isn't.
 */
export async function settlePhotoPurpose(
  deps: SettlePhotoPurposeDeps,
  input: SettlePhotoPurposeInput,
): Promise<SettlePhotoPurposeResult> {
  const { documentId, choice, source } = input;

  if (choice === PHOTO_STORE_CHOICE) {
    return {
      reply:
        "Filed as a plain document in your app — no purpose marked on it. It's under More → Documents, I can find it either way, and if you tell me later what it was for I'll re-file it.",
    };
  }

  await stampPhotoPurpose(deps.client, deps.companyId, documentId, {
    purpose: choice,
    source,
    confidence: input.confidence ?? null,
  });

  const headline = input.headline;
  const fields = input.fields;
  switch (choice) {
    case "paperwork":
      return { reply: await settlePaperwork(deps, documentId, input.knownBytes) };
    case "truck_exterior": {
      const outcome = await runVehiclePipeline(deps, (store) =>
        stageTruckPhoto(store, {
          documentId,
          fields: fields ?? {},
          fieldConfidences: input.fieldConfidences,
        }),
      );
      if (outcome) {
        return { reply: [headline ?? "That's the truck.", ...outcome.lines].join("\n") };
      }
      return {
        reply: [
          headline ?? "That's the truck.",
          ...readLines(fields, input.fieldConfidences),
          "Saved in your documents, marked as the truck.",
        ].join("\n"),
      };
    }
    case "trailer": {
      const outcome = await runVehiclePipeline(deps, (store) =>
        stageTrailerPhoto(store, {
          documentId,
          fields: fields ?? {},
          fieldConfidences: input.fieldConfidences,
        }),
      );
      if (outcome) {
        return {
          reply: [headline ?? "That's the trailer.", ...readLines(fields, input.fieldConfidences), ...outcome.lines].join("\n"),
        };
      }
      return {
        reply: [
          headline ?? "That's the trailer.",
          ...readLines(fields, input.fieldConfidences),
          "Saved in your documents, marked as the trailer — it doesn't touch the truck's profile.",
        ].join("\n"),
      };
    }
    case "odometer_dash": {
      const outcome = await runVehiclePipeline(deps, (store) =>
        stageOdometerPhoto(store, {
          documentId,
          fields: fields ?? {},
          fieldConfidences: input.fieldConfidences,
        }),
      );
      const lines = [headline ?? "That's the dash."];
      if (outcome) {
        lines.push(...outcome.lines);
      } else if (fields?.odometer_miles !== undefined) {
        lines.push(`Odometer reads ${formatMiles(fields.odometer_miles)} miles — that reading is saved with the photo.`);
      }
      // §4.4: warning lights are conversation starters only -
      // named as candidates, never filed as defects, either way.
      if (fields?.warning_lights && fields.warning_lights.length > 0) {
        lines.push(
          `Also looks lit: ${fields.warning_lights.join(", ")}. That's only what I could make out — I haven't filed anything about it.`,
        );
      }
      lines.push("Saved in your documents, marked as a dash photo.");
      return { reply: lines.join("\n") };
    }
    case "pretrip": {
      const lines = [headline ?? "That's a pre-trip photo.", ...readLines(fields, input.fieldConfidences)];
      if (deps.brainStore) {
        lines.push(...(await pretripPhotoFollowUps(deps, documentId, fields, input.headline)));
      }
      lines.push("Saved in your documents, marked as a pre-trip photo.");
      // §4.5: skip is first-class, forever - a photo never becomes
      // a toll booth on the inspection itself.
      lines.push(
        "The photo doesn't pass or fail anything: if the walk-around was clean, just say \"pre-trip passed\" and it completes exactly like always - or tell me what you found and I'll log it.",
      );
      return { reply: lines.join("\n") };
    }
    case "paper_log": {
      // §7: the grid reader runs now (Phase 5) - the sheet is
      // read by the dedicated paper-log contract, cross-checked
      // in code, and staged as a propose->approve batch. A failed
      // read stays honest: stored, marked, paper still the record.
      const lines = [headline ?? "That's a paper log sheet."];
      if (deps.brainStore) {
        try {
          const readPaperLog = deps.readPaperLog ?? defaultReadPaperLog(deps);
          const extraction = await readPaperLog(documentId, input.knownBytes);
          // Store the full read so the app's review screen shows every
          // segment, including any under the floor that isn't staged here.
          await persistPaperLogRead(deps.client, deps.companyId, documentId, extraction).catch((err) =>
            console.error("[telegram] paper log read not stored for review", err),
          );
          const staged = await stagePaperLogDay({ store: deps.brainStore, documentId, extraction });
          lines.push(...staged.lines);
        } catch (err) {
          console.error("[telegram] paper log read failed", err);
          lines.push(
            "I tried to read the grid and couldn't — the sheet is saved in your documents, marked as a paper log sheet, and your paper stays the legal record either way. A flatter, closer photo of the grid usually reads; or tell me the day in words and I'll log it from that.",
          );
        }
      } else {
        lines.push(
          "Saved in your documents, marked as a paper log sheet — the sheet itself is your stored copy, and your paper stays the legal record. Tell me the day's hours in words and I'll log them.",
        );
      }
      return { reply: lines.join("\n") };
    }
    case "other":
      return {
        reply: [
          headline ?? "Got it.",
          ...readLines(fields, input.fieldConfidences),
          "Saved in your documents, marked as a general photo. Tell me what it's for any time and I'll re-file it.",
        ].join("\n"),
      };
  }
  // Unreachable: the choice union is exhausted above (and button
  // choices are validated before they can reach this function).
  return { reply: "Saved in your documents." };
}

// ---------------------------------------------------------------------------
// Ask resolution: by button tap (id) and by text reply (oldest pending)
// ---------------------------------------------------------------------------

export const PHOTO_ASK_EXPIRED_REPLY =
  "That photo question expired — it was over 2 hours old, so I left the photo stored without a purpose on it rather than file it late. Send it again, or just tell me what it is and I'll file it right.";

/** Resolves a button tap: load the ask by id, honor expiry, clear it, settle. */
export async function resolvePhotoPurposeAskById(
  deps: SettlePhotoPurposeDeps,
  pendingId: string,
  choice: PhotoPurposeChoice,
): Promise<string> {
  // A callback's data is client-supplied: an unknown choice is a
  // dead button, never a purpose (the DB check would reject the
  // stamp, but the reply must be honest, not a crash).
  if (choice !== PHOTO_STORE_CHOICE && !(choice in PURPOSE_META)) {
    return "That button doesn't work anymore — the photo itself is saved in your documents either way.";
  }
  const ask = await loadPhotoPurposeAsk(deps.client, deps.companyId, pendingId);
  if (!ask) {
    return "That photo question is already settled (or it expired) — the photo itself is saved in your documents either way.";
  }
  // DH-4: claim before settling - the loser of a double-tap race
  // gets the settled reply here and never reaches the pipelines.
  const claimed = await claimPhotoPurposeAsk(deps.client, deps.companyId, pendingId);
  if (!claimed) {
    return "That photo question is already settled (or it expired) — the photo itself is saved in your documents either way.";
  }
  if (Date.now() - new Date(ask.createdAt).getTime() > PHOTO_ASK_EXPIRY_MS) {
    return PHOTO_ASK_EXPIRED_REPLY;
  }
  const classifierConfidence =
    ask.args.candidates.find((c) => c.purpose === choice)?.confidence ?? ask.args.classifier_confidence;
  const result = await settlePhotoPurpose(deps, {
    documentId: ask.args.document_id,
    choice,
    source: "owner",
    confidence: typeof classifierConfidence === "number" ? classifierConfidence : null,
    headline: ask.args.headline,
    fields: ask.args.fields,
    fieldConfidences: ask.args.field_confidences,
  });
  return result.reply;
}

/**
 * The agent turn's step-1 interception (called from agent-turn.ts
 * when the oldest pending row is a photo-purpose question):
 * resolves in code when his reply names the answer; returns null
 * when it doesn't - the ask stays open and the turn proceeds to
 * the model with the question in context. An expired ask resolves
 * with the honest expiry reply (acceptance A5).
 */
export async function tryResolvePhotoPurposeAsk(
  store: BotBrainStore,
  pending: PendingAction,
  userText: string,
): Promise<{ reply: string } | null> {
  // Telegram repairs D6 (§3.4): the capability gate applies to
  // text answers too, not only button taps - with photo
  // understanding OFF the question settles nothing and stays
  // open, exactly as a tap is refused in handleCallbackQuery.
  if (typeof store.isPhotoIntelligenceEnabled === "function") {
    const enabled = await store.isPhotoIntelligenceEnabled().catch(() => false);
    if (!enabled) return null;
  }
  const args = pending.arguments as unknown as PhotoPurposeAskArgs;
  if (Date.now() - new Date(pending.created_at).getTime() > PHOTO_ASK_EXPIRY_MS) {
    await store.clearPendingAction(pending.id);
    return { reply: PHOTO_ASK_EXPIRED_REPLY };
  }
  const choice = parsePhotoPurposeAnswer(userText, args.candidates ?? []);
  if (!choice) return null;
  await store.clearPendingAction(pending.id);
  const classifierConfidence =
    args.candidates?.find((c) => c.purpose === choice)?.confidence ?? args.classifier_confidence;
  const result = await settlePhotoPurpose(
    { client: store.client, companyId: store.companyId, brainStore: store },
    {
      documentId: args.document_id,
      choice,
      source: "owner",
      confidence: typeof classifierConfidence === "number" ? classifierConfidence : null,
      headline: args.headline,
      fields: args.fields,
      fieldConfidences: args.field_confidences,
    },
  );
  return { reply: result.reply };
}
