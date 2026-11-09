// Deterministic reference resolution (Telegram fix round, brief
// fixes 10 / 11 / 11A / 11B). Before this module, "attach it to load
// 1874" reached the model as raw text and the model guessed a record
// by browsing list_loads - on 2026-11-09 it guessed a completed load
// from days earlier over the trip created minutes before. Now CODE
// resolves the owner's words first:
//
//  1. Extract the references he actually used: a trip number, a
//     broker reference, a trailer/truck unit number, a pickup #,
//     or a deictic "this load" / "that trip".
//  2. Consult the thread's durable entity index FIRST (migration
//     00083 - it survives the ~20-turn live context window), then
//     the wider database (loads by trip_number / broker_reference,
//     trailers and trucks by unit number, documents by the
//     identifiers read from them).
//  3. Decide by the wisdom rules: exactly one record = resolved,
//     stated in words in the turn context; a trip/unit reference
//     that matches TWO records = ambiguous - the caller asks ONE
//     question naming both and stages nothing; a named trip number
//     that matches NOTHING = not_found - Abel must say so, never
//     substitute a different load.
//
// Everything returned is grounded in rows actually read. Labels are
// always in words (trip number + lane + dates) - never a raw UUID.

import type { BotBrainStore } from "./store";
import type { ThreadEntityRow } from "./store-entities";

export interface ExtractedReferences {
  tripNumbers: string[];
  brokerReferences: string[];
  unitNumbers: string[];
  pickupNumbers: string[];
  /** "this load", "that trip", "attach it to it" - the thread's current subject. */
  deictic: boolean;
}

export interface ResolvedRecord {
  entityType: "load" | "document" | "truck" | "trailer" | "driver";
  entityId: string | null;
  /** The record in words, as the owner would say it. */
  label: string;
  source: "index" | "database" | "current";
}

export type ResolutionOutcome =
  | { kind: "none" }
  | { kind: "resolved"; records: ResolvedRecord[]; block: string }
  | { kind: "ambiguous"; question: string; candidates: ResolvedRecord[] }
  | { kind: "not_found"; note: string; block: string };

const uniq = (values: string[]): string[] => [...new Set(values)];

export function extractReferences(text: string): ExtractedReferences {
  const tripNumbers: string[] = [];
  for (const m of text.matchAll(/\btrip\s+#?\s*(\d{3,7})\b/gi)) tripNumbers.push(m[1]!);
  for (const m of text.matchAll(/\bload\s+#?\s*(\d{3,7})\b/gi)) tripNumbers.push(m[1]!);
  const brokerReferences: string[] = [];
  for (const m of text.matchAll(/\bref(?:erence)?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})\b/gi)) brokerReferences.push(m[1]!);
  const unitNumbers: string[] = [];
  for (const m of text.matchAll(/\b(?:trailer|truck|unit)\s+#?\s*([A-Za-z]{0,3}\d[A-Za-z0-9-]{2,})\b/gi)) unitNumbers.push(m[1]!);
  const pickupNumbers: string[] = [];
  for (const m of text.matchAll(/\bpickup\s+#?\s*(\d{3,})\b/gi)) pickupNumbers.push(m[1]!);
  const deictic = /\b(this|that)\s+(load|trip)\b/i.test(text) || /\battach it to it\b/i.test(text);
  return {
    tripNumbers: uniq(tripNumbers),
    brokerReferences: uniq(brokerReferences),
    unitNumbers: uniq(unitNumbers),
    pickupNumbers: uniq(pickupNumbers),
    deictic,
  };
}

interface LoadRow {
  id: string;
  origin: string | null;
  destination: string | null;
  status: string | null;
  pickup_date: string | null;
  delivery_date: string | null;
  trip_number: string | null;
  broker_reference: string | null;
}

export function loadLabel(row: LoadRow): string {
  const bits = [
    row.trip_number ? `Trip ${row.trip_number}` : "Load",
    `${row.origin ?? "?"} → ${row.destination ?? "?"}`,
    row.delivery_date ? `delivery ${row.delivery_date}` : row.pickup_date ? `pickup ${row.pickup_date}` : null,
    row.status && row.status !== "confirmed" ? row.status : null,
  ].filter(Boolean);
  return bits.join(", ");
}

const norm = (v: string) => v.trim().toLowerCase();

function indexMatches(entities: ThreadEntityRow[], kind: string, value: string): ThreadEntityRow[] {
  return entities.filter((e) => e.keys.some((k) => k.kind === kind && norm(k.value) === norm(value)));
}

/**
 * Resolves the references in one owner message for one chat thread.
 * `chatId` is the Telegram chat id as a string. Store failures
 * degrade to { kind: "none" } (the turn proceeds as it did before -
 * resolution is an upgrade, never a new way to break a turn), except
 * that a swallowed failure is logged loudly.
 */
export async function resolveReferences(
  store: BotBrainStore,
  chatId: string,
  text: string,
): Promise<ResolutionOutcome> {
  const refs = extractReferences(text);
  const hasExplicit = refs.tripNumbers.length + refs.brokerReferences.length + refs.unitNumbers.length + refs.pickupNumbers.length > 0;
  if (!hasExplicit && !refs.deictic) return { kind: "none" };

  let entities: ThreadEntityRow[] = [];
  try {
    entities = await store.listThreadEntities(chatId);
  } catch (err) {
    console.error("[bot] thread entity list failed during resolution", err);
  }
  const { client, companyId } = store;

  const resolved: ResolvedRecord[] = [];
  const ambiguous: ResolvedRecord[] = [];
  const missingTrips: string[] = [];

  const pushUnique = (list: ResolvedRecord[], rec: ResolvedRecord) => {
    if (!list.some((r) => r.entityType === rec.entityType && r.entityId === rec.entityId && r.label === rec.label)) list.push(rec);
  };

  // --- trip numbers + broker references -> loads ------------------
  const loadRefs: { kind: "trip_number" | "broker_reference"; value: string }[] = [
    ...refs.tripNumbers.map((value) => ({ kind: "trip_number" as const, value })),
    ...refs.brokerReferences.map((value) => ({ kind: "broker_reference" as const, value })),
  ];
  for (const ref of loadRefs) {
    const candidates: ResolvedRecord[] = [];
    // Index first (fix 11A): it knows loads this conversation staged
    // before they were ever saved, and ones from long ago in it.
    for (const e of indexMatches(entities, ref.kind, ref.value)) {
      if (e.entityType === "load") pushUnique(candidates, { entityType: "load", entityId: e.entityId, label: e.label, source: "index" });
    }
    try {
      const column = ref.kind === "trip_number" ? "trip_number" : "broker_reference";
      const { data } = await client
        .from("loads")
        .select("id, origin, destination, status, pickup_date, delivery_date, trip_number, broker_reference")
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .eq(column, ref.value)
        .order("created_at", { ascending: false })
        .limit(5);
      for (const row of (data ?? []) as LoadRow[]) {
        pushUnique(candidates, { entityType: "load", entityId: row.id, label: loadLabel(row), source: "database" });
      }
    } catch (err) {
      console.error("[bot] load lookup failed during resolution", err);
    }
    // The same load found via index AND database is one candidate.
    const distinct = candidates.filter(
      (c, i) => candidates.findIndex((o) => (c.entityId && o.entityId ? o.entityId === c.entityId : o.label === c.label)) === i,
    );
    if (distinct.length === 1) pushUnique(resolved, distinct[0]!);
    else if (distinct.length > 1) for (const c of distinct) pushUnique(ambiguous, c);
    else if (ref.kind === "trip_number") missingTrips.push(ref.value);
  }

  // --- unit numbers -> trailers / trucks --------------------------
  for (const unit of refs.unitNumbers) {
    const candidates: ResolvedRecord[] = [];
    for (const e of entities) {
      if ((e.entityType === "trailer" || e.entityType === "truck") && e.keys.some((k) => k.kind === "unit_number" && norm(k.value) === norm(unit))) {
        pushUnique(candidates, { entityType: e.entityType, entityId: e.entityId, label: e.label, source: "index" });
      }
    }
    for (const [table, type] of [["trailers", "trailer"], ["trucks", "truck"]] as const) {
      try {
        const { data } = await client
          .from(table)
          .select("id, unit_number")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .ilike("unit_number", unit)
          .limit(3);
        for (const row of (data ?? []) as { id: string; unit_number: string }[]) {
          pushUnique(candidates, { entityType: type, entityId: row.id, label: `${type} ${row.unit_number}`, source: "database" });
        }
      } catch (err) {
        console.error(`[bot] ${table} lookup failed during resolution`, err);
      }
    }
    const distinct = candidates.filter(
      (c, i) => candidates.findIndex((o) => (c.entityId && o.entityId ? o.entityId === c.entityId : o.label === c.label)) === i,
    );
    if (distinct.length === 1) pushUnique(resolved, distinct[0]!);
    else if (distinct.length > 1) for (const c of distinct) pushUnique(ambiguous, c);
  }

  // --- pickup numbers -> documents --------------------------------
  for (const pickup of refs.pickupNumbers) {
    for (const e of indexMatches(entities, "pickup_number", pickup)) {
      if (e.entityType === "document") pushUnique(resolved, { entityType: "document", entityId: e.entityId, label: e.label, source: "index" });
    }
  }

  // --- deictic: the thread's current subject ----------------------
  if (refs.deictic && resolved.length === 0 && ambiguous.length === 0) {
    const current = entities.find((e) => e.isCurrent);
    if (current) {
      pushUnique(resolved, { entityType: current.entityType, entityId: current.entityId, label: current.label, source: "current" });
    }
  }

  if (ambiguous.length > 0) {
    const names = ambiguous.slice(0, 3).map((c) => `the ${c.label}`).join(", or ");
    return {
      kind: "ambiguous",
      candidates: ambiguous,
      question:
        `Before I touch the wrong one — do you mean ${names}? ` +
        "I haven't staged anything; tell me which and I'll go from there.",
    };
  }
  if (resolved.length > 0) {
    const lines = resolved.map((r) => {
      const via =
        r.source === "current"
          ? "the record this conversation is about right now"
          : r.source === "index"
            ? "from this conversation's records"
            : "from his books";
      return `- ${r.label} (${via})${r.entityId ? ` [id ${r.entityId}]` : " [not saved yet - being set up]"}`;
    });
    return {
      kind: "resolved",
      records: resolved,
      block:
        "RECORDS HE IS REFERRING TO (resolved in code from his words - use these, do not browse for a different record):\n" +
        lines.join("\n") +
        "\nState the match in words in your reply before any yes (\"Attaching it to Trip 1874, Panama City, FL → Seminole, OK\"), and stage ONLY what he asked for about this record - nothing extra rides along.",
    };
  }
  if (missingTrips.length > 0) {
    const note = `He named trip ${missingTrips.join(", ")} but no load with that trip number exists in his records or in this conversation.`;
    return {
      kind: "not_found",
      note,
      block:
        `REFERENCE CHECK (in code): ${note} Tell him plainly that you can't find it - do NOT pick a different load in its place, and do not stage anything against another record.`,
    };
  }
  return { kind: "none" };
}
