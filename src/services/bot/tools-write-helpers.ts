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
      return spec.confirm(args as Row);
    },
  };
}

export const idParam = (key: string, entity: string) => ({
  type: "string",
  description: `The ${entity}'s id (uuid) - get it from the matching list tool first.`,
});

