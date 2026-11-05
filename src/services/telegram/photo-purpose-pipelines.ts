// Pretrip-ask matching plus the paperwork / vehicle pipelines a settled photo
// purpose runs. Split out of photo-purpose.ts (file decomposition, 2026-11-06);
// behavior unchanged, and photo-purpose.ts re-exports this file so existing
// imports resolve.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PhotoClassificationFields } from "@/services/ai/photo-classification";
import {
  getDocumentExtractionStatus,
  type DocumentExtractionStatus,
} from "@/services/documents/extraction-hook";
import { isExtractionEnabled, processUploadedDocument } from "@/services/documents/process-document";
import type { BotBrainStore } from "@/services/bot/store";
import { extractionLines, type ExtractedDocumentRead } from "./photo-intake";
import { formatExtractedFieldsForReply } from "@/services/ai/document-extraction";
import type { VehicleStageOutcome } from "./vehicle-photos";
import type { PaperLogExtraction } from "@/services/ai/paper-log-extraction";
import { readPaperLogFromDocument } from "@/services/fleet/paper-log-review";
import type { SettlePhotoPurposeDeps } from "./photo-purpose";

// ---------------------------------------------------------------------------
// UH-03 fix: research-request fulfilment MATCHING. A queued
// pretrip_photo ask is fulfilled ONLY by a matching photo: the ask's
// load must match the photo's load (when the ask carries one), and
// the photo's evidence must cover EVERY item the ask requested. One
// tire photo no longer discharges a BOL ask or a four-item ask.
// ---------------------------------------------------------------------------

const ITEM_PATTERNS: { match: RegExp; evidence: RegExp }[] = [
  { match: /bol|bill of lading/i, evidence: /\bbol\b|bill of lading/i },
  { match: /tire|tyre|wheel/i, evidence: /tire|tyre|wheel|tread/i },
  { match: /light|lamp/i, evidence: /light|lamp|headlight|brake light/i },
  { match: /secure|strap|chain|tarp/i, evidence: /secure|strap|chain|tarp|binder/i },
  { match: /brake/i, evidence: /brake/i },
  { match: /mirror/i, evidence: /mirror/i },
  { match: /fluid|leak/i, evidence: /fluid|leak/i },
  { match: /coupling|fifth|gladhand/i, evidence: /coupling|fifth wheel|gladhand/i },
];

/** True when the evidence text covers every requested item. Unknown items require their first word in the evidence. */
export function pretripItemsCovered(items: string[], evidenceText: string): boolean {
  // An ask that names NO items asked only for "a pre-trip photo" —
  // coverage is vacuous. (The writer always records items; this is
  // for degenerate rows.) An ask WITH items requires every one.
  if (items.length === 0) return true;
  return items.every((item) => {
    const known = ITEM_PATTERNS.find((p) => p.match.test(item));
    if (known) return known.evidence.test(evidenceText);
    const word = item.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return word.length >= 3 && evidenceText.toLowerCase().includes(word);
  });
}

export interface PretripAskRow {
  id: string;
  load_id: string | null;
  detail: Record<string, unknown> | null;
}

/** The matching rule, pure: load match (when the ask is load-scoped) + full item coverage. */
export function pretripAskMatches(
  ask: PretripAskRow,
  input: { evidenceText: string; loadId: string | null },
): boolean {
  if (ask.load_id && input.loadId !== ask.load_id) return false;
  const itemsRaw = (ask.detail as { items?: unknown } | null)?.items;
  const items = Array.isArray(itemsRaw)
    ? itemsRaw.filter((i): i is string => typeof i === "string" && i.length > 0)
    : [];
  return pretripItemsCovered(items, input.evidenceText);
}

/**
 * Stamps the OLDEST queued pretrip_photo ask that MATCHES this photo.
 * Failure-isolated by design (CL-09): any error is logged by callers'
 * try/catch and never fails the settle. Returns the fulfilled id.
 */
export async function fulfilMatchingPretripAsk(
  client: SupabaseClient,
  companyId: string,
  input: { evidenceText: string; loadId: string | null },
): Promise<string | null> {
  const { data: requests } = await client
    .from("research_requests")
    .select("id, load_id, detail")
    .eq("company_id", companyId)
    .eq("kind", "pretrip_photo")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(5);
  const rows = (requests ?? []) as PretripAskRow[];
  const match = rows.find((r) => pretripAskMatches(r, input));
  if (!match) return null;
  await client
    .from("research_requests")
    .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
    .eq("id", match.id)
    .eq("company_id", companyId);
  return match.id;
}

/** Paperwork settling: the EXISTING pipeline, run on the stored photo (§4.1 - byte for byte the web door's read). */
export async function settlePaperwork(
  deps: SettlePhotoPurposeDeps,
  documentId: string,
  knownBytes?: Buffer,
): Promise<string> {
  const { data: row, error } = await deps.client
    .from("documents")
    .select("file_name, storage_path")
    .eq("id", documentId)
    .eq("company_id", deps.companyId)
    .maybeSingle();
  if (error || !row) {
    return "I marked it as paperwork, but I couldn't pull the stored photo back up to read it — it's saved in your documents either way.";
  }
  const doc = row as { file_name: string; storage_path: string };

  let buffer = knownBytes;
  if (!buffer) {
    const { data: blob, error: downloadError } = await deps.client.storage
      .from("documents")
      .download(doc.storage_path);
    if (downloadError || !blob) {
      return `I marked it as paperwork, but I couldn't pull the stored photo back up to read it — it's saved as ${doc.file_name} in your documents either way.`;
    }
    buffer = Buffer.from(await blob.arrayBuffer());
  }

  const processDocument =
    deps.processDocument ??
    (async (id: string, buf: Buffer): Promise<"ran" | "off"> => {
      if (!(await isExtractionEnabled(deps.client, deps.companyId))) return "off";
      await processUploadedDocument(deps.client, {
        companyId: deps.companyId,
        documentId: id,
        fileBuffer: buf,
        contentType: "image/jpeg",
        fileName: doc.file_name,
      });
      return "ran";
    });

  let gateClosed = false;
  try {
    gateClosed = (await processDocument(documentId, buffer)) === "off";
  } catch (err) {
    console.error("[telegram] photo paperwork processing failed", err);
  }

  const lines = [
    `Saved that photo as a document in your app (${doc.file_name}) — filed under your company, not attached to a specific load or truck yet. You can file it against a record from More → Documents, and I can find it either way.`,
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

  // UH-13 fix: ADVISORY clarity check — warns with retake guidance,
  // NEVER blocks the filing above.
  try {
    const blurry = deps.clarityCheck
      ? await deps.clarityCheck(buffer)
      : await (async () => {
          const { assessPhotoClarity } = await import("@/services/documents/scan-image");
          const verdict = await assessPhotoClarity(buffer, "image/jpeg");
          return verdict?.blurry ?? false;
        })();
    if (blurry) {
      lines.push(
        "Heads up: that photo looks blurry — if the text on it matters, a flatter, closer retake in good light will read better. I filed this one either way.",
      );
    }
  } catch (err) {
    console.error("[telegram] photo clarity check failed", err);
  }

  // UH-02 fix: GAP-01 proposal staging on the intelligent path, the
  // same call the legacy intake makes — when extraction is done,
  // stage the record proposals (fuel / rate-con / BOL) for his yes.
  // A staging failure never costs him the stored photo or its reply.
  if (status?.state === "done") {
    try {
      const stageProposals =
        deps.stageProposals ??
        (async (id: string): Promise<string | null> => {
          // The proposals module is GAP-owned: present in the union,
          // absent on this lane's tip — a non-literal specifier keeps
          // this tip compiling standalone; a missing module lands in
          // the catch below and the settle continues without staging.
          const proposalsSpecifier: string = ["@/services/documents", "document-proposals"].join("/");
          const { stageDocumentProposalsForClient } = await import(proposalsSpecifier);
          const { formatRecordableOutcome } = await import("@/services/bot/stage-recordables");
          const result = await stageDocumentProposalsForClient(
            deps.client,
            deps.companyId,
            id,
            "telegram",
          );
          return result ? formatRecordableOutcome(result) || null : null;
        });
      const proposalText = await stageProposals(documentId);
      if (proposalText) lines.push(proposalText.trim());
    } catch (err) {
      console.error("[telegram] document proposal staging failed", err);
    }

    // UH-03 fix (paperwork half): a BOL read through this path can
    // fulfil a MATCHING pretrip_photo ask (BOL is a default ask item
    // but settles as paperwork, so the pretrip branch never sees it).
    if (deps.brainStore && status.docType && /bol/i.test(status.docType)) {
      try {
        const { data: docRow } = await deps.client
          .from("documents")
          .select("related_entity_type, related_entity_id")
          .eq("id", documentId)
          .eq("company_id", deps.companyId)
          .maybeSingle();
        const rel = docRow as { related_entity_type?: string; related_entity_id?: string } | null;
        await fulfilMatchingPretripAsk(deps.client, deps.companyId, {
          evidenceText: "BOL bill of lading",
          loadId: rel?.related_entity_type === "load" ? (rel.related_entity_id ?? null) : null,
        });
      } catch (err) {
        console.error("[telegram] BOL research-request fulfilment failed", err);
      }
    }
  }
  return lines.join("\n");
}

/**
 * The §7 reader's default wiring: pull the stored sheet back down
 * (the scan rendition when one exists - the crisper read) and run
 * the dedicated paper-log contract over it.
 */
export function defaultReadPaperLog(
  deps: SettlePhotoPurposeDeps,
): (documentId: string, knownBytes?: Buffer) => Promise<PaperLogExtraction> {
  // One grid-reader entry point for Telegram and the app
  // (services/fleet/paper-log-review.ts).
  return (documentId, knownBytes) => readPaperLogFromDocument(deps.client, deps.companyId, documentId, knownBytes);
}

const DAMAGE_WORDS = /\b(damage|damaged|bent|crack|cut|leak|broken|flat|dent|torn|missing|scrape|gouge)\b/i;

/**
 * The pre-trip photo's follow-ups (§4.5 + §5.5 + the R-6 hook),
 * each best-effort and none allowed to fail the settle:
 * - name the inspection it pairs with, when one exists today for
 *   the vehicle in the photo (the documents table's related-entity
 *   enum has no inspection value, so the pairing is spoken and
 *   rides the defect links below rather than a row rewrite);
 * - a damage read stages ONE defect proposal (source: this photo);
 * - a pending research pretrip_photo request (R-6's ask) is
 *   marked fulfilled - the arrival half of that feature; when
 *   Abel ASKS is R-6's own business.
 */
export async function pretripPhotoFollowUps(
  deps: SettlePhotoPurposeDeps,
  documentId: string,
  fields: PhotoClassificationFields | undefined,
  headline?: string,
): Promise<string[]> {
  const store = deps.brainStore!;
  const lines: string[] = [];
  try {
    // Pairing: the newest inspection in the last 36 hours.
    const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const { data: inspections } = await store.client
      .from("pretrip_inspections")
      .select("id, truck_id, trailer_id, passed, inspected_at")
      .eq("company_id", deps.companyId)
      .is("deleted_at", null)
      .gte("inspected_at", since)
      .order("inspected_at", { ascending: false })
      .limit(5);
    const rows = (inspections ?? []) as {
      id: string;
      truck_id: string | null;
      trailer_id: string | null;
      passed: boolean;
    }[];
    if (rows.length > 0) {
      lines.push(
        "It goes with the pre-trip already logged in the last day and a half - the photo and the inspection stay linked through your documents and any defects that come out of it.",
      );
    }
  } catch (err) {
    console.error("[telegram] pretrip photo pairing failed", err);
  }

  try {
    const description = fields?.description?.trim();
    if (description && DAMAGE_WORDS.test(description)) {
      // Resolve the vehicle: a read unit number, else the only truck.
      let truckId: string | null = null;
      let trailerId: string | null = null;
      if (fields?.trailer_unit_number) {
        const { data } = await store.client
          .from("trailers")
          .select("id")
          .eq("company_id", deps.companyId)
          .eq("unit_number", fields.trailer_unit_number)
          .is("deleted_at", null)
          .maybeSingle();
        trailerId = (data as { id: string } | null)?.id ?? null;
      }
      if (!trailerId) {
        const { data } = await store.client
          .from("trucks")
          .select("id, unit_number")
          .eq("company_id", deps.companyId)
          .is("deleted_at", null)
          .limit(5);
        const trucks = (data ?? []) as { id: string; unit_number: string }[];
        const matched = fields?.unit_number
          ? trucks.find((t) => t.unit_number === fields.unit_number)
          : trucks.length === 1
            ? trucks[0]
            : undefined;
        truckId = matched?.id ?? null;
      }
      if (truckId || trailerId) {
        const { stageDefectProposals } = await import("@/services/fleet/defects");
        const staged = await stageDefectProposals(
          store,
          [{ truckId, trailerId, description, source: "photo", sourceDocumentId: documentId }],
          "from the pre-trip photo you just sent",
        );
        if (staged > 0) {
          lines.push(
            `That reads like damage, so I staged a defect to track: "${description}" - say yes to track it, or no and it's just the photo.`,
          );
        }
      }
    }
  } catch (err) {
    console.error("[telegram] pretrip damage staging failed", err);
  }

  try {
    // R-6 fulfilment hook, UH-03 fix: only a MATCHING photo fulfils
    // an ask — load must match when the ask is load-scoped, and the
    // photo's evidence must cover every requested item.
    // The photo's load linkage is best-effort: a surface whose
    // client can't read it back just means "no load scope known".
    let photoLoadId: string | null = null;
    try {
      const { data: docRow } = await store.client
        .from("documents")
        .select("related_entity_type, related_entity_id")
        .eq("id", documentId)
        .eq("company_id", deps.companyId)
        .maybeSingle();
      const rel = docRow as { related_entity_type?: string; related_entity_id?: string } | null;
      photoLoadId = rel?.related_entity_type === "load" ? (rel.related_entity_id ?? null) : null;
    } catch {
      photoLoadId = null;
    }
    const evidenceText = [fields?.description ?? "", fields?.unit_number ?? "", headline ?? ""].join(" ");
    await fulfilMatchingPretripAsk(store.client, deps.companyId, {
      evidenceText,
      loadId: photoLoadId,
    });
  } catch (err) {
    console.error("[telegram] pretrip research-request fulfilment failed", err);
  }

  return lines;
}

/**
 * Runs a Phase 2 vehicle pipeline when the surface wired a brain
 * store. A pipeline failure never fails the settle - the purpose
 * is already stamped and the photo stored; the reply falls back
 * to plain narration and says nothing was staged.
 */
export async function runVehiclePipeline(
  deps: SettlePhotoPurposeDeps,
  run: (store: BotBrainStore) => Promise<VehicleStageOutcome>,
): Promise<VehicleStageOutcome | null> {
  if (!deps.brainStore) return null;
  try {
    return await run(deps.brainStore);
  } catch (err) {
    console.error("[telegram] vehicle photo pipeline failed", err);
    return null;
  }
}

