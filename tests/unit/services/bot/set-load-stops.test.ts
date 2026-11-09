// Brief fixes 13 / 16 / 16A - the correction path for a saved load's
// stops. load_stops is written only inside create_load and update_load
// strips stops, so before set_load_stops a load saved with wrong stops
// (Trip 1874: Panama City → Panama City, the Seminole leg lost) could
// never be repaired in chat. Against an in-memory fake Supabase client
// (same pattern as agent-turn.test.ts, plus delete()):
// - set_load_stops replaces ALL stops and its run() result is the
//   READ-BACK from the database, in words, with no raw id anywhere;
// - verifyProposal refuses a load that doesn't exist, in plain words;
// - a correction composes: set_load_stops + save_memory superseding
//   the memory saved from the wrong values;
// - attach_document's summarize (fix 13) carries no raw ids either.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "@/services/ai/agent-loop";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import { buildExtendedWriteTools } from "@/services/bot/tools-write";

const COMPANY = "company-1";
// Trip 1874's real load id from the brief - the summaries/results are
// asserted to never contain it (or any uuid-shaped substring of it).
const LOAD_ID = "50dde25b-6aed-42e5-b63f-fffa64fd7b56";
const MISSING_LOAD_ID = "99999999-9999-4999-8999-999999999999";
const DOC_ID = "15151515-1515-4515-8515-151515151515";
const OLD_MEMORY_ID = "77777777-7777-4777-8777-777777777777";
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "in"; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq":
        return value === f.val;
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      case "is":
        return f.val === null ? value === null || value === undefined : value === f.val;
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private nextId: () => string,
  ) {}

  select() {
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: "is", col, val });
    return this;
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const made = items.map((item) => ({ id: this.nextId(), ...item }));
      rows.push(...made);
      return { data: single || maybe ? (made[0] ?? null) : null, error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
      return { data: null, error: null, count: null };
    }
    if (this.op === "delete") {
      this.db[this.table] = rows.filter((row) => !matches(row, this.filters));
      return { data: null, error: null, count: null };
    }
    let matched = rows.filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""), undefined, { numeric: true });
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    if (single) {
      return matched[0]
        ? { data: matched[0], error: null, count: null }
        : { data: null, error: { message: "no rows found" }, count: null };
    }
    if (maybe) return { data: matched[0] ?? null, error: null, count: null };
    return { data: matched, error: null, count: null };
  }

  single() {
    return Promise.resolve(this.execute(true, false));
  }
  maybeSingle() {
    return Promise.resolve(this.execute(false, true));
  }
  then<TResult1, TResult2>(
    onFulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute(false, false)).then(onFulfilled, onRejected);
  }
}

function fakeClient(seed: Record<string, Row[]>): { client: SupabaseClient; db: Record<string, Row[]> } {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  let n = 0;
  const client = {
    from: (table: string) => new FakeQuery(db, table, () => `fake-row-${++n}`),
  } as unknown as SupabaseClient;
  return { client, db };
}

/** The store the write tools need (client + company scope), plus a saveMemory spy for the composition test. */
function stubStore(client: SupabaseClient) {
  const saveMemory = vi.fn(async () => "new-memory-id");
  const store = { client, companyId: COMPANY, channel: "telegram", saveMemory } as unknown as BotBrainStore;
  return { store, saveMemory };
}

function tool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

const LOAD_ROW: Row = {
  id: LOAD_ID,
  company_id: COMPANY,
  origin: "Panama City, FL",
  destination: "Seminole, OK",
  trip_number: "1874",
  status: "confirmed",
  deleted_at: null,
};

// The wrong stops Trip 1874 was saved with: both legs in Panama City,
// the Seminole delivery lost.
const OLD_STOPS: Row[] = [
  {
    id: "old-stop-1", company_id: COMPANY, load_id: LOAD_ID, seq: 1, kind: "pickup",
    name: "Kontoor Panama City", address: "Panama City, FL",
    appointment_at: "2026-11-10T14:00:00.000Z", appointment_tz: "America/Chicago", deleted_at: null,
  },
  {
    id: "old-stop-2", company_id: COMPANY, load_id: LOAD_ID, seq: 2, kind: "delivery",
    name: "Panama City warehouse", address: "Panama City, FL",
    appointment_at: null, appointment_tz: null, deleted_at: null,
  },
];

const NEW_STOPS = [
  {
    seq: 1, kind: "pickup", name: "Kontoor Panama City", address: "Panama City, FL",
    appointment_at: "2026-11-10T14:00:00.000Z", appointment_tz: "America/Chicago",
  },
  {
    seq: 2, kind: "delivery", name: "Seminole Foods", address: "Seminole, OK",
    appointment_at: "2026-11-11T13:00:00.000Z", appointment_tz: "America/Chicago",
  },
  { seq: 3, kind: "other", name: "Drop lot", address: "Seminole, OK" },
];

describe("set_load_stops (fixes 16 / 16A)", () => {
  it("replaces all stops; the proposal and the read-back result name everything in words, never an id", async () => {
    const { client, db } = fakeClient({ loads: [LOAD_ROW], load_stops: OLD_STOPS });
    const { store } = stubStore(client);
    const setStops = tool(buildExtendedWriteTools(store), "set_load_stops");
    expect(setStops.access).toBe("write");

    const args = { load_id: LOAD_ID, stops: NEW_STOPS };
    expect(setStops.summarize!(args)).not.toMatch(UUID_SHAPE);

    const verified = await setStops.verifyProposal!(args);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.error);
    expect(verified.summary).toContain("Trip 1874");
    expect(verified.summary).toContain("Panama City, FL → Seminole, OK");
    expect(verified.summary).toContain("now 2 stops");
    expect(verified.summary).toContain("becomes 3 stops");
    expect(verified.summary).toContain("PICKUP Kontoor Panama City, Panama City, FL — appt 2026-11-10 08:00 America/Chicago");
    expect(verified.summary).toContain("DELIVERY Seminole Foods, Seminole, OK — appt 2026-11-11 07:00 America/Chicago");
    expect(verified.summary).not.toContain(LOAD_ID);
    expect(verified.summary).not.toMatch(UUID_SHAPE);

    const result = await setStops.run(args);
    const saved = (db.load_stops ?? []).filter((s) => s.load_id === LOAD_ID);
    expect(saved).toHaveLength(3);
    expect(saved.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [1, "pickup", "Kontoor Panama City"],
      [2, "delivery", "Seminole Foods"],
      [3, "other", "Drop lot"],
    ]);
    expect(saved.every((s) => s.company_id === COMPANY)).toBe(true);
    expect(result).toContain("Now the stops are:");
    expect(result).toContain("1. PICKUP Kontoor Panama City, Panama City, FL — appt 2026-11-10 08:00 America/Chicago");
    expect(result).toContain("2. DELIVERY Seminole Foods, Seminole, OK — appt 2026-11-11 07:00 America/Chicago");
    expect(result).toContain("3. OTHER Drop lot, Seminole, OK");
    expect(result).toContain("Trip 1874");
    expect(result).not.toContain(LOAD_ID);
    expect(result).not.toMatch(UUID_SHAPE);
    expect(result).not.toMatch(/⚠/); // read-back count matches what was written
  });

  it("verifyProposal rejects a missing load in plain words that point at list_loads", async () => {
    const { client } = fakeClient({ loads: [LOAD_ROW], load_stops: OLD_STOPS });
    const { store } = stubStore(client);
    const setStops = tool(buildExtendedWriteTools(store), "set_load_stops");
    const verified = await setStops.verifyProposal!({ load_id: MISSING_LOAD_ID, stops: NEW_STOPS });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("expected rejection");
    expect(verified.error).toContain("list_loads");
    expect(verified.error).not.toContain(MISSING_LOAD_ID);
  });

  it("validateArgs refuses an empty stop list and a bad kind", async () => {
    const { client } = fakeClient({ loads: [LOAD_ROW], load_stops: [] });
    const { store } = stubStore(client);
    const setStops = tool(buildExtendedWriteTools(store), "set_load_stops");
    expect(setStops.validateArgs!({ load_id: LOAD_ID, stops: [] }).ok).toBe(false);
    expect(setStops.validateArgs!({ load_id: LOAD_ID, stops: [{ seq: 1, kind: "dropoff" }] }).ok).toBe(false);
    expect(setStops.validateArgs!({ load_id: LOAD_ID, stops: NEW_STOPS }).ok).toBe(true);
  });
});

describe("the correction batch composes (fix 16)", () => {
  it("set_load_stops fixes the stops and save_memory supersedes the memory saved from the wrong ones", async () => {
    const { client, db } = fakeClient({ loads: [LOAD_ROW], load_stops: OLD_STOPS, bot_memories: [] });
    const { store, saveMemory } = stubStore(client);
    // The full registry over the same fake store: both halves of the
    // correction are invocable side by side.
    const tools = buildBotTools(store);
    const setStops = tool(tools, "set_load_stops");
    const saveMem = tool(tools, "save_memory");

    const result = await setStops.run({ load_id: LOAD_ID, stops: NEW_STOPS });
    expect(result).toContain("Now the stops are:");
    expect((db.load_stops ?? []).filter((s) => s.load_id === LOAD_ID)).toHaveLength(3);

    await saveMem.run({
      kind: "fact",
      content: "Trip 1874 delivers in Seminole, OK (corrected - it was saved as Panama City)",
      supersedes_id: OLD_MEMORY_ID,
    });
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(saveMemory).toHaveBeenCalledWith(
      "fact",
      "Trip 1874 delivers in Seminole, OK (corrected - it was saved as Panama City)",
      { supersedesId: OLD_MEMORY_ID },
    );
  });

  it("the real store closes the superseded memory (valid_to + superseded_by)", async () => {
    // Guard against the stub hiding a wiring break: run the SAME
    // correction through createBotStore's real saveMemory and check
    // the memory saved from the wrong stops is actually closed.
    const { client, db } = fakeClient({
      loads: [LOAD_ROW],
      load_stops: OLD_STOPS,
      bot_memories: [
        { id: OLD_MEMORY_ID, company_id: COMPANY, kind: "fact", content: "Trip 1874 delivers in Panama City, FL", deleted_at: null, valid_to: null },
      ],
      bot_pending_actions: [],
    });
    const store = createBotStore(client, COMPANY, "telegram");
    const tools = buildBotTools(store);
    await tool(tools, "set_load_stops").run({ load_id: LOAD_ID, stops: NEW_STOPS });
    await tool(tools, "save_memory").run({
      kind: "fact",
      content: "Trip 1874 delivers in Seminole, OK (corrected - it was saved as Panama City)",
      supersedes_id: OLD_MEMORY_ID,
    });
    const memories = db.bot_memories!;
    expect(memories).toHaveLength(2);
    const closed = memories.find((m) => m.id === OLD_MEMORY_ID)!;
    const fresh = memories.find((m) => m.id !== OLD_MEMORY_ID)!;
    expect(closed.valid_to).toBeTruthy();
    expect(closed.superseded_by).toBe(fresh.id);
    expect(fresh.valid_to ?? null).toBeNull();
  });
});

describe("attach_document (fix 13)", () => {
  it("summarize contains no uuid-shaped substring for sample args", async () => {
    const { client } = fakeClient({ loads: [LOAD_ROW], documents: [] });
    const { store } = stubStore(client);
    const attach = tool(buildExtendedWriteTools(store), "attach_document");
    const summary = attach.summarize!({
      document_id: DOC_ID,
      related_entity_type: "load",
      related_entity_id: LOAD_ID,
    });
    expect(summary).not.toMatch(UUID_SHAPE);
    expect(summary).not.toContain(DOC_ID);
    expect(summary).not.toContain(LOAD_ID);
    expect(summary).toContain("load");
  });

  it("run() names the target in words instead of echoing its raw id", async () => {
    const { client, db } = fakeClient({
      loads: [LOAD_ROW],
      documents: [{ id: DOC_ID, company_id: COMPANY, file_name: "bol-photo.jpg", related_entity_type: "company", related_entity_id: null }],
    });
    const { store } = stubStore(client);
    const attach = tool(buildExtendedWriteTools(store), "attach_document");
    const result = await attach.run({
      document_id: DOC_ID,
      related_entity_type: "load",
      related_entity_id: LOAD_ID,
    });
    expect(result).toContain('"bol-photo.jpg"');
    expect(result).toContain("load Panama City, FL → Seminole, OK");
    expect(result).not.toContain(LOAD_ID);
    expect(result).not.toMatch(UUID_SHAPE);
    expect(db.documents![0]).toMatchObject({ related_entity_type: "load", related_entity_id: LOAD_ID });
  });
});
