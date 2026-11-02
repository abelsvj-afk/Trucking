// GAP-01 (Fresh-Eyes Register 2026-11-02) — paperwork → records.
//
// Extraction already reads a document and pulls structured fields
// onto its row — and then stops: the driver still types the record
// himself. This module closes that loop through the SAME
// propose→yes discipline dispatch text uses (stage-recordables):
// the extracted fields are mapped, IN CODE, to write-tool items;
// the items are validated against the document's own extracted
// text by validateDumpItems (every claimed number must appear in
// the document, every quote is a verbatim span of it) and staged
// as one numbered batch. Nothing records until he says yes.
//
// Settlements are deliberately excluded — Abel Intelligence
// Phase D owns settlement ingestion and the pay pin.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore, type BotChannel } from "@/services/bot/store";
import { stageRecordables, type StageRecordablesResult } from "@/services/bot/stage-recordables";
import type { DumpItemInput } from "@/services/bot/dump-intake";
import { matchFacility } from "@/lib/facilities";
import type { Document, Facility, Load, Truck } from "@/types/entities";

export interface ProposalContext {
  // related_entity_type is a plain string here, not the entities
  // RelatedEntityType: Telegram photos are filed under "company",
  // which that type doesn't carry.
  document: Pick<Document, "id" | "doc_type" | "extracted_fields" | "extracted_text" | "related_entity_id"> & {
    related_entity_type: string;
  };
  trucks: Pick<Truck, "id" | "unit_number">[];
  /** Non-completed loads first — matching candidates for paperwork. */
  loads: Pick<Load, "id" | "origin" | "destination" | "status">[];
  facilities: Pick<Facility, "id" | "name" | "city">[];
}

type Fields = Record<string, string | number | null>;

function num(fields: Fields, key: string): number | null {
  const value = fields[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(fields: Fields, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stateCode(fields: Fields, key: string): string | null {
  const value = str(fields, key);
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

function isoDate(fields: Fields, key: string): string | null {
  const value = str(fields, key);
  // Only pass through dates already in ISO shape — extraction
  // copies what's printed ("10/05/2026"), and reformatting a date
  // in code is how a proposal quietly moves a pickup by a month.
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** A verbatim span of the document text carrying one of the needles. */
function quoteFor(text: string, needles: (string | number | null)[]): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const needle of needles) {
    if (needle == null) continue;
    const target = String(needle).toLowerCase();
    const hit = lines.find((l) => l.toLowerCase().includes(target));
    if (hit) return hit.slice(0, 300);
  }
  return (lines[0] ?? text.slice(0, 140)).slice(0, 300);
}

function cityMatches(loadText: string, city: string | null): boolean {
  return city != null && loadText.toLowerCase().includes(city.toLowerCase());
}

/** The one active load a piece of paperwork most plausibly belongs to. */
function matchLoad(ctx: ProposalContext, fields: Fields): ProposalContext["loads"][number] | null {
  const attached =
    ctx.document.related_entity_type === "load"
      ? ctx.loads.find((l) => l.id === ctx.document.related_entity_id)
      : undefined;
  if (attached) return attached;
  const originCity = str(fields, "origin_city");
  const destinationCity = str(fields, "destination_city");
  const candidates = ctx.loads.filter(
    (l) =>
      l.status !== "completed" &&
      (cityMatches(l.destination, destinationCity) || cityMatches(l.origin, originCity)),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * The pure mapping: extracted document → proposed record items.
 * Exported for tests; staging (validation + persistence) is
 * stageDocumentProposals below.
 */
export function buildDocumentProposalItems(ctx: ProposalContext): DumpItemInput[] {
  const { document } = ctx;
  const fields = (document.extracted_fields ?? {}) as Fields;
  const text = document.extracted_text ?? "";
  const items: DumpItemInput[] = [];
  const quote = (...needles: (string | number | null)[]) => quoteFor(text, needles);

  if (document.doc_type === "fuel_receipt") {
    const gallons = num(fields, "gallons");
    const total = num(fields, "total_amount");
    const perGallon = num(fields, "price_per_gallon");
    // The tool needs a total; a computed total that never appears
    // on the receipt would fail the number-trace check anyway, so
    // only stage when the receipt itself states one.
    if (gallons != null && total != null) {
      const args: Record<string, unknown> = { total_dollars: total, gallons };
      const station = str(fields, "station_name");
      if (station) args.location = station;
      const state = stateCode(fields, "state") ?? stateCode(fields, "station_state");
      if (state) args.state = state;
      const truckNumber = str(fields, "truck_number");
      const truck = truckNumber
        ? ctx.trucks.find((t) => t.unit_number.toLowerCase() === truckNumber.toLowerCase())
        : ctx.trucks.length === 1
          ? ctx.trucks[0]
          : undefined;
      if (truck) args.truck_id = truck.id;
      items.push({
        tool_name: "create_fuel_purchase",
        args,
        source_quote: quote(total, gallons, perGallon),
        confidence: truck || ctx.trucks.length <= 1 ? "high" : "medium",
      });
    }
    return items;
  }

  if (document.doc_type === "rate_confirmation") {
    const rate = num(fields, "rate_amount");
    const weight = num(fields, "weight_lbs");
    const originCity = str(fields, "origin_city");
    const destinationCity = str(fields, "destination_city");
    const originState = stateCode(fields, "origin_state");
    const destinationState = stateCode(fields, "destination_state");
    const shared: Record<string, unknown> = {};
    if (rate != null) shared.rate_dollars = rate;
    if (weight != null) shared.weight_lbs = Math.round(weight);
    if (originState) shared.origin_state = originState;
    if (destinationState) shared.destination_state = destinationState;
    const pickupDate = isoDate(fields, "pickup_date");
    const deliveryDate = isoDate(fields, "delivery_date");
    if (pickupDate) shared.pickup_date = pickupDate;
    if (deliveryDate) shared.delivery_date = deliveryDate;

    const existing = matchLoad(ctx, fields);
    if (existing) {
      items.push({
        tool_name: "update_load",
        args: { load_id: existing.id, ...shared },
        source_quote: quote(rate, originCity, destinationCity),
        confidence: "medium",
      });
    } else if (originCity || destinationCity) {
      const origin = [originCity, originState].filter(Boolean).join(", ");
      const destination = [destinationCity, destinationState].filter(Boolean).join(", ");
      if (origin && destination) {
        items.push({
          tool_name: "create_load",
          args: { origin, destination, ...shared },
          source_quote: quote(rate, originCity, destinationCity),
          confidence: "medium",
        });
      }
    }

    // GAP-03: the rate con names the places — remember them.
    const receiver = str(fields, "receiver");
    if (receiver && !matchFacility(ctx.facilities, receiver, destinationCity)) {
      items.push({
        tool_name: "create_facility",
        args: {
          name: receiver,
          ...(destinationCity ? { city: destinationCity } : {}),
          ...(destinationState ? { state: destinationState } : {}),
          kind: "receiver",
        },
        source_quote: quote(receiver),
        confidence: "medium",
      });
    }
    const shipper = str(fields, "shipper");
    if (shipper && !matchFacility(ctx.facilities, shipper, originCity)) {
      items.push({
        tool_name: "create_facility",
        args: {
          name: shipper,
          ...(originCity ? { city: originCity } : {}),
          ...(originState ? { state: originState } : {}),
          kind: "shipper",
        },
        source_quote: quote(shipper),
        confidence: "medium",
      });
    }
    return items;
  }

  if (document.doc_type === "bol") {
    const load = matchLoad(ctx, fields);
    if (load) {
      if (document.related_entity_type !== "load") {
        items.push({
          tool_name: "attach_document",
          args: {
            document_id: document.id,
            related_entity_type: "load",
            related_entity_id: load.id,
          },
          source_quote: quote(str(fields, "bol_number"), str(fields, "pro_number")),
          confidence: "medium",
        });
      }
      if (load.status !== "completed") {
        items.push({
          tool_name: "update_load",
          args: { load_id: load.id, status: "completed" },
          source_quote: quote(str(fields, "bol_number"), str(fields, "pro_number")),
          confidence: "medium",
        });
      }
    }
    return items;
  }

  if (document.doc_type === "scale_ticket") {
    const weight = num(fields, "weight_lbs");
    const load = matchLoad(ctx, fields);
    if (weight != null && load) {
      if (document.related_entity_type !== "load") {
        items.push({
          tool_name: "attach_document",
          args: {
            document_id: document.id,
            related_entity_type: "load",
            related_entity_id: load.id,
          },
          source_quote: quote(weight),
          confidence: "medium",
        });
      }
      items.push({
        tool_name: "update_load",
        args: { load_id: load.id, weight_lbs: Math.round(weight) },
        source_quote: quote(weight),
        confidence: "high",
      });
    }
    return items;
  }

  // settlement → Phase D owns it. other → nothing honest to propose.
  return items;
}

/**
 * Loads the processed document + matching context, builds the
 * items, and stages them through the shared propose→yes machinery.
 * Returns null when there is nothing to propose (unprocessed,
 * settlement, other, or no mappable fields) — callers stay silent
 * in that case, exactly as before GAP-01.
 */
export async function stageDocumentProposals(
  store: BotBrainStore,
  documentId: string,
): Promise<StageRecordablesResult | null> {
  const { client, companyId } = store;
  const { data: docData, error: docError } = await client
    .from("documents")
    .select(
      "id, doc_type, extracted_fields, extracted_text, related_entity_type, related_entity_id, extraction_status",
    )
    .eq("company_id", companyId)
    .eq("id", documentId)
    .maybeSingle();
  if (docError) throw new Error(docError.message);
  if (!docData) return null;
  const row = docData as ProposalContext["document"] & { extraction_status: string };
  if (row.extraction_status !== "done" || !row.doc_type || !row.extracted_text) return null;
  if (row.doc_type === "settlement" || row.doc_type === "other") return null;

  const [trucksResult, loadsResult, facilitiesResult] = await Promise.all([
    client.from("trucks").select("id, unit_number").eq("company_id", companyId).is("deleted_at", null),
    client
      .from("loads")
      .select("id, origin, destination, status")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    client.from("facilities").select("id, name, city").eq("company_id", companyId).is("deleted_at", null),
  ]);
  if (trucksResult.error) throw new Error(trucksResult.error.message);
  if (loadsResult.error) throw new Error(loadsResult.error.message);
  if (facilitiesResult.error) throw new Error(facilitiesResult.error.message);

  const loads = (loadsResult.data ?? []) as ProposalContext["loads"];
  // Active loads first for matching; completed loads still match
  // when the document is already attached to them.
  loads.sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"));

  const items = buildDocumentProposalItems({
    document: row,
    trucks: (trucksResult.data ?? []) as ProposalContext["trucks"],
    loads,
    facilities: (facilitiesResult.data ?? []) as ProposalContext["facilities"],
  });
  if (items.length === 0) return null;
  return stageRecordables(store, row.extracted_text, items);
}

/** Convenience for surfaces that hold a client + company, not a store. */
export async function stageDocumentProposalsForClient(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  channel: BotChannel,
): Promise<StageRecordablesResult | null> {
  return stageDocumentProposals(createBotStore(client, companyId, channel), documentId);
}
