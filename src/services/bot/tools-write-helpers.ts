// Shared building blocks for the bot's extended write tools (split out of
// tools-write.ts in the decomposition pass; behavior unchanged): the create /
// update tool shapes and the small helpers every section uses.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { fetchLiveRow, insertRow, isMissingColumnError, patchLiveRow, validateWith } from "./tool-helpers";

export type Row = Record<string, unknown>;

export const uuid = z.string().uuid();
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export function changedFields(
  args: Record<string, unknown>,
  idKey: string,
  exclude: string[] = [],
): string {
  const fields = Object.keys(args).filter(
    (k) => k !== idKey && !exclude.includes(k) && args[k] !== undefined,
  );
  return fields.length > 0 ? fields.join(", ") : "nothing";
}

/** Shared shape for a create tool: bot args -> row -> UI-schema check -> insert. */
export function makeCreateTool(
  store: BotBrainStore,
  spec: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    botSchema: z.ZodType;
    table: string;
    label: string;
    toRow: (args: Row) => Row;
    rowSchema: z.ZodType;
    summarize: (args: Row) => string;
    confirm: (args: Row, id: string) => string;
    /** Optional post-insert hook (mileage propagation, schedule completion): returns a sentence appended to the confirmation, or void. Runs after the row exists; its own failures must be reported in its sentence, never thrown over the landed write. */
    afterCreate?: (args: Row, id: string) => Promise<string | void>;
    /** Columns added by a migration that may not be applied yet: if the insert is refused for a missing column, the row is saved without them (their values folded into notes) and the reply says so. */
    newerColumns?: string[];
  },
): AgentTool {
  const { client, companyId } = store;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    access: "write",
    validateArgs: validateWith(spec.botSchema),
    summarize: (args) => spec.summarize(args as Row),
    // P0-3: a new record that points at another record (a load, truck, driver...) is only proposed when
    // that record really exists in his books - otherwise the model is told to look it up.
    async verifyProposal(args) {
      const parsed = spec.botSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid arguments" };
      let row: Row;
      try {
        row = spec.rowSchema.parse(spec.toRow(parsed.data as Row)) as Row;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "invalid record" };
      }
      const missing = await missingReferences(client, companyId, row);
      return missing ? { ok: false, error: missing } : { ok: true };
    },
    async run(args) {
      const parsed = spec.botSchema.parse(args) as Row;
      let row = spec.rowSchema.parse(spec.toRow(parsed)) as Row;
      let id: string;
      let note = "";
      try {
        id = await insertRow(client, spec.table, companyId, row);
      } catch (err) {
        const carried = (spec.newerColumns ?? []).filter((c) => row[c] !== undefined);
        if (carried.length === 0 || !isMissingColumnError({ message: err instanceof Error ? err.message : "" })) throw err;
        const folded = carried.map((c) => `${c.replace(/_/g, " ")}: ${String(row[c])}`).join("; ");
        const rest = { ...row };
        for (const c of carried) delete rest[c];
        row = { ...rest, notes: [typeof rest.notes === "string" ? rest.notes : "", folded].filter(Boolean).join("\n") };
        id = await insertRow(client, spec.table, companyId, row);
        note = " The database hasn't had the trip-fields update applied yet, so the trip details were saved in the notes instead of their own fields.";
      }
      if (spec.afterCreate) {
        try {
          note += (await spec.afterCreate(parsed, id)) ?? "";
        } catch (err) {
          console.error(`[tools-write] ${spec.name} afterCreate failed:`, err);
          note = " (One follow-on update didn't go through - the record itself is saved.)";
        }
      }
      return `${spec.confirm(args as Row, id)} Record id ${id}.${note}`;
    },
  };
}

/** Shared shape for an update tool: fetch -> merge -> UI-schema check -> patch only the named fields. */
export function makeUpdateTool(
  store: BotBrainStore,
  spec: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    botSchema: z.ZodType;
    table: string;
    label: string;
    idKey: string;
    toPatch: (args: Row) => Row;
    patchSchema: z.ZodType;
    /** Full-row schema re-checked against the merged row when the entity has cross-field rules. */
    mergedSchema?: z.ZodType;
    summarize: (args: Row) => string;
    confirm: (args: Row) => string;
  },
): AgentTool {
  const { client, companyId } = store;
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    access: "write",
    validateArgs: validateWith(spec.botSchema),
    summarize: (args) => spec.summarize(args as Row),
    async verifyProposal(args) {
      const parsed = spec.botSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid arguments" };
      const row = parsed.data as Row;
      const id = String(row[spec.idKey]);
      const { data, error } = await client
        .from(spec.table)
        .select("*")
        .eq("id", id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) return { ok: false, error: `couldn't check his records (${error.message})` };
      if (!data) return { ok: false, error: `there is no ${spec.label} with id ${id} in his records` };
      const before = data as Row;
      let patch: Row;
      try {
        patch = spec.patchSchema.parse(spec.toPatch(row)) as Row;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "invalid change" };
      }
      if (Object.keys(patch).length === 0) return { ok: false, error: "that change names no fields" };
      // P1-5: a load moving BACKWARD (completed -> confirmed/draft) is called out in the words he approves.
      const backward =
        spec.table === "loads" && typeof patch.status === "string" && before.status === "completed" && patch.status !== "completed"
          ? ` ⚠ this moves a COMPLETED load back to ${patch.status}`
          : "";
      return { ok: true, summary: `Update ${describeRecord(spec.label, before)}: ${changesInWords(patch, before)}${backward}` };
    },
    async run(args) {
      const parsed = spec.botSchema.parse(args) as Row;
      const id = String(parsed[spec.idKey]);
      const existing = await fetchLiveRow(client, spec.table, companyId, id, spec.label);
      const patch = spec.patchSchema.parse(spec.toPatch(parsed)) as Row;
      if (Object.keys(patch).length === 0) {
        throw new Error(`That ${spec.name} call named no fields to change.`);
      }
      if (spec.mergedSchema) {
        // Cross-field check on the would-be row. Stored nulls count
        // as absent: several UI schemas model a nullable column as
        // merely optional (e.g. loads.notes), so a legitimately
        // stored NULL must not fail the merged validation.
        const merged: Row = { ...existing, ...patch };
        for (const key of Object.keys(merged)) {
          if (merged[key] === null) delete merged[key];
        }
        spec.mergedSchema.parse(merged);
      }
      await patchLiveRow(client, spec.table, companyId, id, patch);
      // P1-8: say exactly which fields now hold which values, so the reply can only claim what changed.
      return `${spec.confirm(args as Row)} Now: ${changesInWords(patch, existing)}.`;
    },
  };
}

export const idParam = (key: string, entity: string) => ({
  type: "string",
  description: `The ${entity}'s id (uuid) - get it from the matching list tool first.`,
});

/** A saved record in words, for proposals (P0-3 / P2-2): what he would recognise, never a uuid. */
export function describeRecord(label: string, row: Row): string {
  const money = (c: unknown) =>
    typeof c === "number" ? `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : null);
  if (row.origin || row.destination) {
    const bits = [
      money(row.rate_cents),
      row.status ? String(row.status) : null,
      row.delivery_date ? `delivery ${day(row.delivery_date)}` : row.pickup_date ? `pickup ${day(row.pickup_date)}` : null,
    ].filter(Boolean);
    return `${label} ${row.origin ?? "?"} → ${row.destination ?? "?"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
  }
  if (typeof row.content === "string") return `${label} "${row.content.slice(0, 120)}"`;
  if (typeof row.file_name === "string") return `${label} "${row.file_name}"`;
  if (typeof row.name === "string") return `${label} ${row.name}`;
  if (typeof row.unit_number === "string") return `${label} ${row.unit_number}`;
  if (typeof row.description === "string") {
    return `${label} "${row.description.slice(0, 80)}"${money(row.amount_cents) ? ` ${money(row.amount_cents)}` : ""}`;
  }
  if (typeof row.amount_cents === "number") {
    return `${label} ${money(row.amount_cents)}${row.category ? ` (${row.category})` : ""}${day(row.expense_date) ? ` on ${day(row.expense_date)}` : ""}`;
  }
  if (typeof row.total_cost_cents === "number") return `${label} ${money(row.total_cost_cents)} on ${day(row.purchased_at)}`;
  if (typeof row.duty_status === "string") return `${label} ${row.duty_status} from ${row.started_at}`;
  if (typeof row.title === "string") return `${label} "${row.title}"`;
  return label;
}

function shownValue(key: string, v: unknown): string {
  if (key.endsWith("_cents") && typeof v === "number") return `$${(v / 100).toFixed(2)}`;
  if (v === null) return "(cleared)";
  return String(v).slice(0, 80);
}

/** The changed fields WITH their new values ("delivery date → 2026-11-06 (was 2026-11-05)"), for proposals and confirmations (P1-8). */
export function changesInWords(patch: Row, before: Row | null = null): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const name = k.replace(/_cents$/, "").replace(/_/g, " ");
    const prior = before ? before[k] : undefined;
    const was = prior !== undefined && prior !== null && prior !== v ? ` (was ${shownValue(k, prior)})` : "";
    parts.push(`${name} → ${shownValue(k, v)}${was}`);
  }
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

const REFERENCE_TABLES: Record<string, { table: string; label: string }> = {
  load_id: { table: "loads", label: "load" },
  truck_id: { table: "trucks", label: "truck" },
  trailer_id: { table: "trailers", label: "trailer" },
  driver_id: { table: "drivers", label: "driver" },
  broker_id: { table: "brokers", label: "broker" },
  customer_id: { table: "customers", label: "customer" },
};

/** The first referenced id that is not a live record of his, in words - or null when every reference exists. */
export async function missingReferences(
  client: { from: (t: string) => unknown },
  companyId: string,
  row: Row,
): Promise<string | null> {
  for (const [field, ref] of Object.entries(REFERENCE_TABLES)) {
    const id = row[field];
    if (typeof id !== "string" || id.length === 0) continue;
    const q = (client.from(ref.table) as {
      select: (c: string) => { eq: (a: string, b: string) => { eq: (a: string, b: string) => { is: (a: string, b: null) => { maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }> } } } };
    })
      .select("id")
      .eq("id", id)
      .eq("company_id", companyId)
      .is("deleted_at", null);
    const { data, error } = await q.maybeSingle();
    if (error) return `couldn't check his ${ref.label}s (${error.message})`;
    if (!data) return `there is no ${ref.label} with id ${id} in his records (${field})`;
  }
  return null;
}
