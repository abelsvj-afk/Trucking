// Vehicle defects (Image Intelligence design §5.5): the shared
// helpers behind the third maintenance noun. A defect is staged
// as a proposal from three feeds - a failed pre-trip (one per
// distinct defect text), a damage photo at the act threshold, and
// the owner's own words (the model stages those itself) - and it
// closes only by another proposal, when a matching maintenance
// event lands. Dismissal is forever: the watcher never re-asks
// about a dismissed defect.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import type { VehicleDefect } from "@/types/entities";

/**
 * Splits a pre-trip's free-text defects_found into one defect per
 * distinct problem ("steer tire cut; mirror cracked" → two).
 * Splits on newlines and semicolons, strips list numbering and
 * bullets; commas do NOT split (one problem is often a sentence
 * with commas in it).
 */
export function splitDefectTexts(defectsFound: string): string[] {
  return defectsFound
    .split(/[\n;]+/)
    .map((part) => part.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((part) => part.length > 0);
}

export interface DefectDraft {
  truckId?: string | null;
  trailerId?: string | null;
  description: string;
  source: "pretrip" | "photo" | "conversation";
  sourceInspectionId?: string | null;
  sourceDocumentId?: string | null;
}

/**
 * Stages create_vehicle_defect proposals as ONE batch and
 * returns how many landed. Validation runs against the real tool
 * registry, like every other code-staged batch in this system.
 */
export async function stageDefectProposals(
  store: BotBrainStore,
  drafts: DefectDraft[],
  sourceQuote: string,
): Promise<number> {
  if (drafts.length === 0) return 0;
  const tool = buildBotTools(store).find((t) => t.name === "create_vehicle_defect");
  if (!tool?.validateArgs || !tool.summarize) return 0;
  const batchId = randomUUID();
  let staged = 0;
  for (const draft of drafts) {
    const args: Record<string, unknown> = {
      description: draft.description,
      source: draft.source,
    };
    if (draft.truckId) args.truck_id = draft.truckId;
    if (draft.trailerId) args.trailer_id = draft.trailerId;
    if (draft.sourceInspectionId) args.source_inspection_id = draft.sourceInspectionId;
    if (draft.sourceDocumentId) args.source_document_id = draft.sourceDocumentId;
    const validation = tool.validateArgs(args);
    if (!validation.ok) {
      console.error(`[defects] defect proposal failed validation: ${validation.error}`);
      continue;
    }
    staged += 1;
    await store.savePendingAction({
      toolName: "create_vehicle_defect",
      args: validation.args,
      summary: tool.summarize(validation.args),
      batchId,
      itemNumber: staged,
      sourceQuote,
      confidence: "high",
    });
  }
  return staged;
}

/** Open + acknowledged defects (the ones that still matter), oldest first. */
export async function listActiveDefects(
  client: SupabaseClient,
  companyId: string,
): Promise<{ defects: VehicleDefect[]; available: boolean }> {
  const { data, error } = await client
    .from("vehicle_defects")
    .select("*")
    .eq("company_id", companyId)
    .in("status", ["open", "acknowledged"])
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    // Pre-00042 the table doesn't exist - say so via the flag,
    // never by inventing an empty answer that looks authoritative.
    if (/does not exist/i.test(error.message)) return { defects: [], available: false };
    throw new Error(error.message);
  }
  return { defects: (data ?? []) as VehicleDefect[], available: true };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "on", "in", "at", "to", "of", "is", "was",
  "with", "side", "front", "rear", "left", "right",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  );
}

/**
 * §5.5's closure matching: does a recorded maintenance event
 * sound like the fix for this defect? Deliberately crude (shared
 * significant words on the same truck) - it only ever powers a
 * SUGGESTION in the event's confirmation text; the closure itself
 * is staged and approved separately.
 */
export function defectMatchesWork(defect: VehicleDefect, workDescription: string): boolean {
  const work = significantWords(workDescription);
  for (const word of significantWords(defect.description)) {
    if (work.has(word)) return true;
  }
  return false;
}
