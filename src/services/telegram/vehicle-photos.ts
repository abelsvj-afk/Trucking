// Vehicle photo pipelines (Image Intelligence design §4.2-4.4):
// what a truck / trailer / dash photo DOES once its purpose is
// settled. The shape is always the same - the photo itself may
// become the vehicle's profile picture on the strength of the
// purpose tap, but every FACT it carries (unit number, make,
// model, mileage) lands only as a staged proposal he approves
// item by item (acceptance B1: a partial yes records exactly the
// accepted items and nothing else).
//
// The honesty rules, in code:
// - Read fields stage separately, each with its own confidence;
//   nothing stages below the §3.2 act bar (0.85).
// - Make/model come from badging (the classifier's contract says
//   so); a read that conflicts with what's on file names BOTH
//   values in the proposal instead of overwriting quietly.
// - A unit number that matches no truck is the §5.7 conflict:
//   staged against the only truck (named as a possible
//   re-lettering) or asked about - never silently attached.
// - An odometer below the recorded mileage stages NOTHING (B2);
//   a jump past the plausible daily rate stages flagged.
// - The name lettered on the door is the carrier's, not his
//   company's: it is proposed as a memory, never written to a
//   trucks table (§4.2).

import { randomUUID } from "node:crypto";
import type { BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import { formatBatchProposal } from "@/services/bot/dump-intake";
import {
  assessOdometerReading,
  MILEAGE_SOURCE_LABELS,
  type MileageSource,
} from "@/services/fleet/mileage";
import {
  PHOTO_PURPOSE_THRESHOLDS,
  type PhotoClassificationFields,
} from "@/services/ai/photo-classification";

/** Fields match a vehicle at the ask bar; they STAGE at the act bar. */
const MATCH_BAR = PHOTO_PURPOSE_THRESHOLDS.ask;
const STAGE_BAR = PHOTO_PURPOSE_THRESHOLDS.act;

export interface StagedItemView {
  summary: string;
  sourceQuote?: string | null;
  confidence?: string | null;
}

export interface VehicleStageOutcome {
  /** Narration lines for Abel's reply (before the proposal list). */
  lines: string[];
  /** The staged batch, when anything was staged. */
  items: StagedItemView[];
}

interface StageItem {
  toolName: string;
  args: Record<string, unknown>;
  sourceQuote?: string;
  confidence?: string;
}

interface TruckRow {
  id: string;
  unit_number: string;
  make: string | null;
  model: string | null;
  truck_type: string | null;
  status: string;
  current_mileage: number | null;
  current_mileage_at: string | null;
}

interface TrailerRow {
  id: string;
  unit_number: string;
  trailer_type: string | null;
  status: string;
}

function fieldConf(
  confidences: Record<string, number> | undefined,
  key: string,
): number | null {
  const value = confidences?.[key];
  return typeof value === "number" ? value : null;
}

function confWord(confidence: number | null): string | undefined {
  if (confidence == null) return undefined;
  return confidence >= STAGE_BAR ? "high" : "medium";
}

/**
 * Validates each item against the real tool registry (the same
 * validation the agent loop applies), stages the batch, and
 * returns what should be shown. An item that fails validation is
 * dropped with a plain line - code-built args failing validation
 * is a bug, and it is surfaced, never hidden.
 */
async function stageItems(
  store: BotBrainStore,
  items: StageItem[],
): Promise<{ views: StagedItemView[]; dropped: string[] }> {
  const tools = buildBotTools(store);
  const views: StagedItemView[] = [];
  const dropped: string[] = [];
  const batchId = randomUUID();
  let itemNumber = 0;
  for (const item of items) {
    const tool = tools.find((t) => t.name === item.toolName);
    if (!tool?.validateArgs || !tool.summarize) {
      dropped.push(item.toolName);
      continue;
    }
    const validation = tool.validateArgs(item.args);
    if (!validation.ok) {
      console.error(
        `[vehicle-photos] staged item ${item.toolName} failed validation: ${validation.error}`,
      );
      dropped.push(item.toolName);
      continue;
    }
    itemNumber += 1;
    const summary = tool.summarize(validation.args);
    await store.savePendingAction({
      toolName: item.toolName,
      args: validation.args,
      summary,
      batchId,
      itemNumber,
      sourceQuote: item.sourceQuote,
      confidence: item.confidence,
    });
    views.push({ summary, sourceQuote: item.sourceQuote ?? null, confidence: item.confidence ?? null });
  }
  return { views, dropped };
}

function proposalText(outcome: { views: StagedItemView[]; dropped: string[] }): string[] {
  const lines: string[] = [];
  if (outcome.views.length > 0) lines.push(formatBatchProposal(outcome.views).trim());
  if (outcome.dropped.length > 0) {
    lines.push(
      `One thing I read wouldn't stage cleanly (${outcome.dropped.join(", ")}) - tell me the value and I'll record it from your words instead.`,
    );
  }
  return lines;
}

async function loadTrucks(store: BotBrainStore): Promise<TruckRow[]> {
  const { data, error } = await store.client
    .from("trucks")
    .select("id, unit_number, make, model, truck_type, status, current_mileage, current_mileage_at")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .order("unit_number", { ascending: true });
  if (error) {
    // Pre-00045 the provenance column is absent - read without it.
    if (/current_mileage_at/.test(error.message)) {
      const retry = await store.client
        .from("trucks")
        .select("id, unit_number, make, model, truck_type, status, current_mileage")
        .eq("company_id", store.companyId)
        .is("deleted_at", null)
        .order("unit_number", { ascending: true });
      if (retry.error) throw new Error(retry.error.message);
      return ((retry.data ?? []) as Omit<TruckRow, "current_mileage_at">[]).map((row) => ({
        ...row,
        current_mileage_at: null,
      }));
    }
    throw new Error(error.message);
  }
  return (data ?? []) as TruckRow[];
}

async function loadTrailers(store: BotBrainStore): Promise<TrailerRow[]> {
  const { data, error } = await store.client
    .from("trailers")
    .select("id, unit_number, trailer_type, status")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .order("unit_number", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TrailerRow[];
}

function fmtMiles(miles: number): string {
  return Math.round(miles).toLocaleString("en-US");
}

// ---------------------------------------------------------------------
// §4.2 - the truck
// ---------------------------------------------------------------------

export async function stageTruckPhoto(
  store: BotBrainStore,
  input: {
    documentId: string;
    fields: PhotoClassificationFields;
    fieldConfidences?: Record<string, number>;
  },
): Promise<VehicleStageOutcome> {
  const { fields, fieldConfidences } = input;
  const trucks = await loadTrucks(store);
  const lines: string[] = [];

  if (trucks.length === 0) {
    lines.push(
      "There's no truck on file yet, so I couldn't attach this photo to one. Say the word and I'll add the truck first, then make this its picture.",
    );
    return { lines, items: [] };
  }

  const readUnit = fields.unit_number?.trim() || null;
  const unitConf = fieldConf(fieldConfidences, "unit_number");
  const matched =
    readUnit && (unitConf == null || unitConf >= MATCH_BAR)
      ? trucks.find((t) => t.unit_number === readUnit)
      : undefined;

  let subject: TruckRow;
  let unitConflict: string | null = null;
  if (matched) {
    subject = matched;
  } else if (trucks.length === 1) {
    subject = trucks[0]!;
    if (readUnit && readUnit !== subject.unit_number) {
      unitConflict =
        `the door in the photo says ${readUnit}, but the only truck on file is ${subject.unit_number} - ` +
        "if it's been re-lettered, approving item 2 fixes the number; if it's a different truck, say no and tell me";
    }
  } else {
    lines.push(
      readUnit
        ? `The door says ${readUnit}, and that doesn't match any truck on file (${trucks.map((t) => t.unit_number).join(", ")}). Which truck is this - or is it a new one? I haven't attached the photo to any of them.`
        : `I couldn't read a unit number, and there's more than one truck on file (${trucks.map((t) => t.unit_number).join(", ")}). Which truck is this photo of? I haven't attached it to any of them.`,
    );
    return { lines, items: [] };
  }

  lines.push(`This is truck ${subject.unit_number}${subject.make ? ` (${subject.make}${subject.model ? ` ${subject.model}` : ""})` : ""}.`);

  const items: StageItem[] = [
    {
      toolName: "update_truck",
      args: { truck_id: subject.id, photo_document_id: input.documentId },
      sourceQuote: "the photo you just sent becomes this truck's profile picture",
      confidence: "high",
    },
  ];

  // A re-lettered unit number rides its own item, above the act
  // bar, with the conflict named (§5.7).
  if (unitConflict && unitConf != null && unitConf >= STAGE_BAR) {
    items.push({
      toolName: "update_truck",
      args: { truck_id: subject.id, unit_number: readUnit },
      sourceQuote: unitConflict,
      confidence: confWord(unitConf),
    });
  } else if (unitConflict) {
    lines.push(
      `Heads-up: ${unitConflict}. I didn't stage the number change - the read wasn't clear enough; tell me the right number and I'll take your word.`,
    );
  }

  const fieldSpecs: { key: "make" | "model" | "truck_type"; label: string }[] = [
    { key: "make", label: "make" },
    { key: "model", label: "model" },
    { key: "truck_type", label: "type" },
  ];
  for (const spec of fieldSpecs) {
    const value = fields[spec.key]?.trim();
    if (!value) continue;
    const conf = fieldConf(fieldConfidences, spec.key);
    // A field stages only on its OWN confidence (§4.2) - a read
    // with no confidence recorded for it doesn't stage either.
    if (conf == null || conf < STAGE_BAR) continue;
    const current = subject[spec.key];
    if (current && current.toLowerCase() === value.toLowerCase()) continue;
    items.push({
      toolName: "update_truck",
      args: { truck_id: subject.id, [spec.key]: value },
      sourceQuote: current
        ? `the photo's badging reads ${value}; the app currently says ${current} - approving changes it`
        : `read off the truck in the photo`,
      confidence: confWord(conf),
    });
  }

  // §4.2: the door name is the carrier's - a memory, never a
  // trucks column, so his own company is never overwritten by the
  // company he's leased to.
  const doorName = fields.door_company_name?.trim();
  if (doorName) {
    items.push({
      toolName: "save_memory",
      args: {
        kind: "business_fact",
        content:
          `BUSINESS — Truck ${subject.unit_number} door lettering | The name lettered on the door is "${doorName}" - ` +
          "that is the carrier this truck is leased to, not his own company.",
      },
      sourceQuote: "lettered on the door in the photo",
      confidence: confWord(fieldConf(fieldConfidences, "door_company_name")),
    });
    lines.push(
      `The door is lettered "${doorName}" - that's the carrier's name, not yours, so I staged it as something for me to remember, not as the truck's company.`,
    );
  }

  const outcome = await stageItems(store, items);
  lines.push(...proposalText(outcome));
  return { lines, items: outcome.views };
}

// ---------------------------------------------------------------------
// §4.3 - the trailer (deliberately shallow)
// ---------------------------------------------------------------------

export async function stageTrailerPhoto(
  store: BotBrainStore,
  input: {
    documentId: string;
    fields: PhotoClassificationFields;
    fieldConfidences?: Record<string, number>;
  },
): Promise<VehicleStageOutcome> {
  const { fields, fieldConfidences } = input;
  const trailers = await loadTrailers(store);
  const lines: string[] = [];

  const readUnit = fields.trailer_unit_number?.trim() || null;
  const unitConf = fieldConf(fieldConfidences, "trailer_unit_number");
  const typeValue = fields.trailer_type?.trim() || null;
  const typeConf = fieldConf(fieldConfidences, "trailer_type");
  const matched =
    readUnit && (unitConf == null || unitConf >= MATCH_BAR)
      ? trailers.find((t) => t.unit_number === readUnit)
      : undefined;

  if (matched) {
    lines.push(`This is trailer ${matched.unit_number}.`);
    const items: StageItem[] = [
      {
        toolName: "update_trailer",
        args: { trailer_id: matched.id, photo_document_id: input.documentId },
        sourceQuote: "the photo you just sent becomes this trailer's picture",
        confidence: "high",
      },
    ];
    if (typeValue && typeConf != null && typeConf >= STAGE_BAR && typeValue !== matched.trailer_type) {
      items.push({
        toolName: "update_trailer",
        args: { trailer_id: matched.id, trailer_type: typeValue },
        sourceQuote: matched.trailer_type
          ? `the photo reads ${typeValue}; the app currently says ${matched.trailer_type}`
          : "read off the trailer in the photo",
        confidence: confWord(typeConf),
      });
    }
    const outcome = await stageItems(store, items);
    lines.push(...proposalText(outcome));
    return { lines, items: outcome.views };
  }

  if (readUnit && (unitConf == null || unitConf >= MATCH_BAR)) {
    // §4.3: an unmatched trailer number proposes CREATING the
    // trailer - a photo of a trailer he doesn't have yet is how
    // new iron enters the app.
    lines.push(`Trailer ${readUnit} isn't on file yet.`);
    const args: Record<string, unknown> = {
      unit_number: readUnit,
      photo_document_id: input.documentId,
    };
    if (typeValue && (typeConf == null || typeConf >= STAGE_BAR)) args.trailer_type = typeValue;
    const outcome = await stageItems(store, [
      {
        toolName: "create_trailer",
        args,
        sourceQuote: "from the photo you just sent - approving adds this trailer with the photo as its picture",
        confidence: confWord(unitConf),
      },
    ]);
    lines.push(...proposalText(outcome));
    return { lines, items: outcome.views };
  }

  if (trailers.length === 1) {
    const only = trailers[0]!;
    lines.push(`I couldn't read its number, and trailer ${only.unit_number} is the only one on file - staging this as its picture.`);
    const outcome = await stageItems(store, [
      {
        toolName: "update_trailer",
        args: { trailer_id: only.id, photo_document_id: input.documentId },
        sourceQuote: "the photo you just sent becomes this trailer's picture",
        confidence: "high",
      },
    ]);
    lines.push(...proposalText(outcome));
    return { lines, items: outcome.views };
  }

  lines.push(
    trailers.length === 0
      ? "There's no trailer on file and I couldn't read a number off this one. Tell me its unit number and I'll add it with this photo."
      : `I couldn't read a unit number, and there's more than one trailer on file (${trailers.map((t) => t.unit_number).join(", ")}). Which trailer is this? I haven't attached the photo to any of them.`,
  );
  return { lines, items: [] };
}

// ---------------------------------------------------------------------
// §4.4 - the dash (odometer + warning lights)
// ---------------------------------------------------------------------

export async function stageOdometerPhoto(
  store: BotBrainStore,
  input: {
    documentId: string;
    fields: PhotoClassificationFields;
    fieldConfidences?: Record<string, number>;
  },
): Promise<VehicleStageOutcome> {
  const { fields, fieldConfidences } = input;
  const lines: string[] = [];
  const miles = fields.odometer_miles;

  if (miles == null) {
    lines.push(
      "I couldn't read the odometer digits off that dash photo. Tell me the number and I'll record it from your word.",
    );
    return { lines, items: [] };
  }

  const trucks = await loadTrucks(store);
  if (trucks.length === 0) {
    lines.push("There's no truck on file to put that mileage on yet.");
    return { lines, items: [] };
  }
  const readUnit = fields.unit_number?.trim() || null;
  const matched = readUnit ? trucks.find((t) => t.unit_number === readUnit) : undefined;
  const subject = matched ?? (trucks.length === 1 ? trucks[0]! : undefined);
  if (!subject) {
    lines.push(
      `That dash reads ${fmtMiles(miles)} miles, but there's more than one truck on file (${trucks.map((t) => t.unit_number).join(", ")}) and I couldn't tell whose dash it is. Which truck? I haven't recorded it anywhere.`,
    );
    return { lines, items: [] };
  }

  const assessment = assessOdometerReading({
    currentMiles: subject.current_mileage,
    currentAt: subject.current_mileage_at,
    candidateMiles: miles,
  });

  if (assessment.verdict === "below_current") {
    // B2: below the recorded mileage, NOTHING is staged - the two
    // numbers are shown and he arbitrates.
    lines.push(
      `The dash reads ${fmtMiles(miles)}, but truck ${subject.unit_number} already shows ${fmtMiles(subject.current_mileage!)} - ` +
        "I didn't stage anything, because mileage doesn't run backwards. If the number on the truck is wrong, tell me the right one and I'll take your word for it.",
    );
    return { lines, items: [] };
  }
  if (assessment.verdict === "invalid") {
    lines.push("That odometer read didn't come through as a usable number - tell me the mileage and I'll record it from your word.");
    return { lines, items: [] };
  }

  const flagged = assessment.verdict === "suspicious_jump";
  lines.push(
    flagged
      ? `That dash puts truck ${subject.unit_number} at ${fmtMiles(miles)} - that's ${fmtMiles(assessment.delta ?? 0)} miles past the last reading, a big jump, so I flagged the item below. If it's right, approve it and it's recorded.`
      : `That dash puts truck ${subject.unit_number} at ${fmtMiles(miles)}.`,
  );
  const outcome = await stageItems(store, [
    {
      toolName: "update_truck",
      args: {
        truck_id: subject.id,
        current_mileage: Math.round(miles),
        mileage_source: "odometer_photo" satisfies MileageSource,
      },
      sourceQuote: flagged
        ? `read off the dash photo - flagged: +${fmtMiles(assessment.delta ?? 0)} miles since the last reading`
        : `read off the dash photo you just sent (counts as ${MILEAGE_SOURCE_LABELS.odometer_photo})`,
      confidence: confWord(fieldConf(fieldConfidences, "odometer_miles")),
    },
  ]);
  lines.push(...proposalText(outcome));
  return { lines, items: outcome.views };
}
