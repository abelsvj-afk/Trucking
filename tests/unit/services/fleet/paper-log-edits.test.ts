// Paper-log save -> edit trail (spec §2.2): the rows a paper save
// writes each get a kind='insert', source='paper' trail row whose
// reason is the paper day's own remark (PAPER_SAVE_REASON - the same
// text the rows carry as notes). The RPC replaces the day wholesale;
// no delete trail rows are invented for the replaced rows.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { savePaperLogDay } from "@/services/fleet/paper-log-review";
import { PAPER_SAVE_REASON } from "@/lib/paper-day";

type Row = Record<string, unknown>;

const COMPANY = "company-1";
const DOC_ID = "15151515-1515-4515-8515-151515151515";
// 2026-11-09 in America/New_York: day bounds 05:00Z -> next 05:00Z.
const SAVED_ROWS: Row[] = [
  { id: "row-1", company_id: COMPANY, duty_status: "off_duty", started_at: "2026-11-09T05:00:00.000Z", source: "paper_photo", source_document_id: DOC_ID, deleted_at: null },
  { id: "row-2", company_id: COMPANY, duty_status: "driving", started_at: "2026-11-09T17:00:00.000Z", source: "paper_photo", source_document_id: DOC_ID, deleted_at: null },
];

class SelectBuilder {
  private filters: { col: string; op: string; val: unknown }[] = [];
  constructor(private rows: Row[]) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, op: "is", val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ col, op: "lt", val });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    const out = this.rows.filter((row) =>
      this.filters.every((f) => {
        if (f.op === "eq") return row[f.col] === f.val;
        if (f.op === "is") return (row[f.col] ?? null) === f.val;
        if (f.op === "gte") return String(row[f.col]) >= String(f.val);
        return String(row[f.col]) < String(f.val);
      }),
    );
    resolve({ data: out, error: null });
  }
}

describe("savePaperLogDay edit trail", () => {
  it("writes one paper insert trail row per saved row, reason = the paper day's remark", async () => {
    const edits: Row[] = [];
    const client = {
      rpc: async () => ({ data: 2, error: null }),
      from: (table: string) => {
        if (table === "duty_log_edits") {
          return {
            insert: (payload: Row) => {
              edits.push(payload);
              return Promise.resolve({ error: null });
            },
          };
        }
        return new SelectBuilder(SAVED_ROWS);
      },
    } as unknown as SupabaseClient;

    const outcome = await savePaperLogDay(client, COMPANY, DOC_ID, "America/New_York", {
      log_date: "2026-11-09",
      segments: [
        { status: "off_duty", start_min: 0, end_min: 720 },
        { status: "driving", start_min: 720, end_min: 1440 },
      ],
      replace_ids: [],
    });

    expect(outcome).toEqual({ ok: true, inserted: 2 });
    expect(edits).toHaveLength(2);
    for (const [i, edit] of edits.entries()) {
      expect(edit.kind).toBe("insert");
      expect(edit.source).toBe("paper");
      expect(edit.reason).toBe(PAPER_SAVE_REASON);
      expect(edit.company_id).toBe(COMPANY);
      expect(edit.duty_log_id).toBe(SAVED_ROWS[i]!.id);
      expect(edit.before).toBeNull();
      expect((edit.after as Row).id).toBe(SAVED_ROWS[i]!.id);
    }
    // No delete trail rows are invented for a wholesale replacement.
    expect(edits.every((e) => e.kind === "insert")).toBe(true);
  });
});
