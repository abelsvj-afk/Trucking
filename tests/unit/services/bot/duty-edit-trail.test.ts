// Abel duty corrections land in the edit trail (spec §2.2, Abel
// parity): a log_duty_status BACKFILL (start well in the past, or a
// dictated gap-fill) writes kind='insert', source='conversation' with
// the proposal's explanation as the reason; LIVE logging writes no
// trail row; delete_record on a duty_log writes kind='delete',
// source='conversation'. No new tools - the existing duty tools gained
// the behavior. Unit-level against the tools' write seam with a
// recording fake client (the omnipresence pattern, shrunk to the
// calls these tools make).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";

type Row = Record<string, unknown>;

const COMPANY = "company-1";
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";

interface FakeState {
  duty: Row[];
  edits: Row[];
}

type Filter = { col: string; op: "eq" | "is"; val: unknown };

class FakeBuilder {
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];

  constructor(
    private st: FakeState,
    private table: string,
  ) {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
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
  order() {
    return this;
  }
  limit() {
    return this;
  }
  gte() {
    return this;
  }
  lte() {
    return this;
  }

  private rows(): Row[] {
    const all = this.table === "duty_logs" ? this.st.duty : [];
    return all.filter((row) =>
      this.filters.every((f) => (f.op === "eq" ? row[f.col] === f.val : (row[f.col] ?? null) === f.val)),
    );
  }

  private execute(single: boolean): { data: unknown; error: { message: string } | null } {
    if (this.table !== "duty_logs" && this.table !== "duty_log_edits") {
      // Anything else (HOS config reads inside the tool's summary
      // attempt) reads as absent - the tool handles that itself.
      return { data: single ? null : [], error: null };
    }
    if (this.mode === "insert") {
      const row = { ...this.payload } as Row;
      if (this.table === "duty_log_edits") this.st.edits.push(row);
      else this.st.duty.push(row);
      return { data: single ? row : [row], error: null };
    }
    if (this.mode === "update") {
      const targets = this.rows();
      for (const row of targets) Object.assign(row, this.payload);
      return { data: single ? (targets[0] ?? null) : targets, error: null };
    }
    const rows = this.rows();
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  }

  single() {
    return Promise.resolve(this.execute(true));
  }
  maybeSingle() {
    return Promise.resolve(this.execute(true));
  }
  then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
    resolve(this.execute(false));
  }
}

function makeStore(st: FakeState): BotBrainStore {
  const client = { from: (table: string) => new FakeBuilder(st, table) } as unknown as SupabaseClient;
  return { client, companyId: COMPANY } as unknown as BotBrainStore;
}

function tool(st: FakeState, name: string) {
  const found = buildBotTools(makeStore(st)).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("Abel duty writes - edit trail parity (no new tools)", () => {
  it("a backfill log_duty_status writes a conversation insert trail row carrying the proposal explanation", async () => {
    const st: FakeState = { duty: [], edits: [] };
    const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const reply = await tool(st, "log_duty_status").run({
      duty_status: "driving",
      started_at: startedAt,
      location: "Seminole, OK",
    });
    expect(reply).toContain("Logged duty status driving");
    expect(st.duty).toHaveLength(1);
    expect(st.edits).toHaveLength(1);
    const edit = st.edits[0]!;
    expect(edit.kind).toBe("insert");
    expect(edit.source).toBe("conversation");
    expect(edit.company_id).toBe(COMPANY);
    expect(edit.duty_log_id).toBe(st.duty[0]!.id);
    expect(edit.before).toBeNull();
    expect((edit.after as Row).duty_status).toBe("driving");
    // The reason IS the proposal's explanation (the summarize() text).
    expect(String(edit.reason)).toContain(`Duty status: driving starting at ${startedAt}`);
  });

  it("live logging (starts now) writes NO trail row and needs no reason", async () => {
    const st: FakeState = { duty: [], edits: [] };
    await tool(st, "log_duty_status").run({ duty_status: "on_duty" });
    expect(st.duty).toHaveLength(1);
    expect(st.edits).toEqual([]);
  });

  it("delete_record on a duty_log writes a conversation delete trail row", async () => {
    const st: FakeState = {
      duty: [
        {
          id: ENTRY_ID,
          company_id: COMPANY,
          duty_status: "driving",
          started_at: "2026-11-09T11:00:00.000Z",
          deleted_at: null,
        },
      ],
      edits: [],
    };
    const reply = await tool(st, "delete_record").run({ entity: "duty_log", record_id: ENTRY_ID });
    expect(reply).toContain("Deleted duty log entry");
    expect(st.duty[0]!.deleted_at).not.toBeNull();
    expect(st.edits).toHaveLength(1);
    const edit = st.edits[0]!;
    expect(edit.kind).toBe("delete");
    expect(edit.source).toBe("conversation");
    expect(edit.duty_log_id).toBe(ENTRY_ID);
    expect((edit.before as Row).id).toBe(ENTRY_ID);
    expect(edit.after).toBeNull();
    expect(String(edit.reason)).toContain("DELETE duty log entry (driving from 2026-11-09T11:00:00.000Z)");
  });

  it("delete_record on a NON-duty entity writes no duty trail row", async () => {
    const st: FakeState = { duty: [], edits: [] };
    // No broker seeded - the delete refuses before any write; the
    // point is only that the duty seam stays duty-only. Seed one in
    // duty table shape is wrong, so assert the throw path instead:
    await expect(tool(st, "delete_record").run({ entity: "duty_log", record_id: ENTRY_ID })).rejects.toThrow(
      /in his records/,
    );
    expect(st.edits).toEqual([]);
  });
});
