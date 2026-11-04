// Vehicle photo pipelines (Image Intelligence §4.2-4.4): a
// settled truck / trailer / dash photo stages its facts as a
// proposal batch - each field its own item, each on its own
// confidence (B1) - and the odometer sanity rules hold in code
// (B2). A trailer photo never touches a truck row (B4).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import {
  stageOdometerPhoto,
  stageTrailerPhoto,
  stageTruckPhoto,
} from "@/services/telegram/vehicle-photos";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const TRUCK2_ID = "22222222-2222-4222-8222-222222222222";
const TRAILER_ID = "33333333-3333-4333-8333-333333333333";
const DOC_ID = "15151515-1515-4515-8515-151515151515";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is"; col: string; val: unknown };

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
  ) {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
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
  order(col: string) {
    this.orderCol = col;
    return this;
  }
  limit() {
    return this;
  }

  private matching(): Row[] {
    return (this.db[this.table] ?? []).filter((row) =>
      this.filters.every((f) =>
        f.op === "eq" ? row[f.col] === f.val : f.val === null ? row[f.col] == null : row[f.col] === f.val,
      ),
    );
  }

  private execute(): { data: unknown; error: null } {
    if (this.op === "insert") {
      const row = { id: `row-${(this.db[this.table] ?? []).length + 1}`, ...this.payload };
      (this.db[this.table] ??= []).push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      for (const row of this.matching()) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    let rows = this.matching();
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => String(a[col]) < String(b[col]) ? -1 : 1);
    }
    return { data: rows, error: null };
  }

  async single() {
    const out = this.execute();
    return { data: out.data, error: null };
  }
  async maybeSingle() {
    const out = this.execute();
    const rows = out.data as Row[];
    return { data: Array.isArray(rows) ? (rows[0] ?? null) : out.data, error: null };
  }
  then<TResult>(resolve: (v: { data: unknown; error: null }) => TResult) {
    return Promise.resolve(this.execute()).then(resolve);
  }
}

function fakeWorld(seed: { trucks?: Row[]; trailers?: Row[] }) {
  const db: Record<string, Row[]> = {
    trucks: (seed.trucks ?? []).map((t) => ({ deleted_at: null, ...t })),
    trailers: (seed.trailers ?? []).map((t) => ({ deleted_at: null, ...t })),
    bot_pending_actions: [],
  };
  const client = { from: (table: string) => new FakeQuery(db, table) };
  const store = createBotStore(client as unknown as SupabaseClient, COMPANY, "telegram");
  return { db, store: store as BotBrainStore };
}

const TRUCK_214 = {
  id: TRUCK_ID,
  company_id: COMPANY,
  unit_number: "214",
  make: null,
  model: null,
  truck_type: null,
  status: "active",
  current_mileage: 514_020,
  current_mileage_at: "2026-11-01T12:00:00Z",
};

function staged(db: Record<string, Row[]>) {
  return (db.bot_pending_actions ?? []).map((r) => ({
    tool: r.tool_name as string,
    args: r.arguments as Row,
    item: r.item_number as number,
    batch: r.batch_id as string,
    quote: r.source_quote as string | null,
  }));
}

describe("stageTruckPhoto — §4.2", () => {
  it("stages photo first, then each confident field as its own item (B1)", async () => {
    const { db, store } = fakeWorld({ trucks: [TRUCK_214] });
    const out = await stageTruckPhoto(store, {
      documentId: DOC_ID,
      fields: { unit_number: "214", make: "Freightliner", model: "Cascadia", truck_type: "sleeper" },
      fieldConfidences: { unit_number: 0.97, make: 0.95, model: 0.9, truck_type: 0.6 },
    });
    const items = staged(db);
    // truck_type at 0.6 stays home - only photo, make, model land.
    expect(items.map((i) => i.item)).toEqual([1, 2, 3]);
    expect(items[0]!.args).toMatchObject({ truck_id: TRUCK_ID, photo_document_id: DOC_ID });
    expect(items[1]!.args).toMatchObject({ truck_id: TRUCK_ID, make: "Freightliner" });
    expect(items[2]!.args).toMatchObject({ truck_id: TRUCK_ID, model: "Cascadia" });
    expect(new Set(items.map((i) => i.batch)).size).toBe(1);
    expect(out.lines.join("\n")).toContain("I have NOT recorded any of this yet");
  });

  it("the door name stages as a MEMORY, never a trucks write (§4.2)", async () => {
    const { db, store } = fakeWorld({ trucks: [TRUCK_214] });
    await stageTruckPhoto(store, {
      documentId: DOC_ID,
      fields: { unit_number: "214", door_company_name: "Acme Logistics LLC" },
      fieldConfidences: { unit_number: 0.97, door_company_name: 0.9 },
    });
    const items = staged(db);
    const memory = items.find((i) => i.tool === "save_memory");
    expect(memory).toBeDefined();
    expect(String(memory!.args.content)).toContain("Acme Logistics LLC");
    expect(String(memory!.args.content)).toContain("not his own company");
    // No staged item writes a company name onto the truck.
    for (const item of items) {
      expect(JSON.stringify(item.args)).not.toContain("company_name");
    }
  });

  it("a unit number matching no truck stages against the only truck with the conflict named (§5.7)", async () => {
    const { db, store } = fakeWorld({ trucks: [TRUCK_214] });
    const out = await stageTruckPhoto(store, {
      documentId: DOC_ID,
      fields: { unit_number: "317" },
      fieldConfidences: { unit_number: 0.95 },
    });
    const items = staged(db);
    const unit = items.find((i) => i.args.unit_number === "317");
    expect(unit).toBeDefined();
    expect(unit!.args.truck_id).toBe(TRUCK_ID);
    expect(unit!.quote).toContain("re-lettered");
    expect(out.lines.join("\n")).toContain("317");
  });

  it("two trucks and an unmatched number: nothing staged, the question is asked", async () => {
    const { db, store } = fakeWorld({
      trucks: [TRUCK_214, { ...TRUCK_214, id: TRUCK2_ID, unit_number: "88" }],
    });
    const out = await stageTruckPhoto(store, {
      documentId: DOC_ID,
      fields: { unit_number: "317" },
      fieldConfidences: { unit_number: 0.95 },
    });
    expect(staged(db)).toHaveLength(0);
    expect(out.lines.join("\n")).toContain("Which truck is this");
  });

  it("a read conflicting with the filed make names both values", async () => {
    const { db, store } = fakeWorld({ trucks: [{ ...TRUCK_214, make: "Kenworth" }] });
    await stageTruckPhoto(store, {
      documentId: DOC_ID,
      fields: { unit_number: "214", make: "Freightliner" },
      fieldConfidences: { unit_number: 0.97, make: 0.95 },
    });
    const make = staged(db).find((i) => i.args.make === "Freightliner");
    expect(make!.quote).toContain("the app currently says Kenworth");
  });
});

describe("stageTrailerPhoto — §4.3", () => {
  it("an unmatched trailer number proposes creating the trailer", async () => {
    const { db, store } = fakeWorld({ trailers: [] });
    const out = await stageTrailerPhoto(store, {
      documentId: DOC_ID,
      fields: { trailer_unit_number: "5831", trailer_type: "dry_van" },
      fieldConfidences: { trailer_unit_number: 0.93, trailer_type: 0.9 },
    });
    const items = staged(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.tool).toBe("create_trailer");
    expect(items[0]!.args).toMatchObject({ unit_number: "5831", photo_document_id: DOC_ID });
    expect(out.lines.join("\n")).toContain("isn't on file yet");
  });

  it("a matched trailer stages its photo - and never touches a truck (B4)", async () => {
    const { db, store } = fakeWorld({
      trucks: [TRUCK_214],
      trailers: [{ id: TRAILER_ID, company_id: COMPANY, unit_number: "5831", trailer_type: null, status: "active" }],
    });
    await stageTrailerPhoto(store, {
      documentId: DOC_ID,
      fields: { trailer_unit_number: "5831" },
      fieldConfidences: { trailer_unit_number: 0.95 },
    });
    const items = staged(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.tool).toBe("update_trailer");
    expect(items.every((i) => !("truck_id" in i.args))).toBe(true);
  });
});

describe("stageOdometerPhoto — §4.4", () => {
  it("a plausible reading stages update_truck with provenance", async () => {
    const { db, store } = fakeWorld({ trucks: [TRUCK_214] });
    await stageOdometerPhoto(store, {
      documentId: DOC_ID,
      fields: { odometer_miles: 514_400 },
      fieldConfidences: { odometer_miles: 0.96 },
    });
    const items = staged(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.tool).toBe("update_truck");
    expect(items[0]!.args).toMatchObject({
      truck_id: TRUCK_ID,
      current_mileage: 514_400,
      mileage_source: "odometer_photo",
    });
  });

  it("a below-current reading stages NOTHING and shows both numbers (B2)", async () => {
    const { db, store } = fakeWorld({ trucks: [TRUCK_214] });
    const out = await stageOdometerPhoto(store, {
      documentId: DOC_ID,
      fields: { odometer_miles: 512_300 },
      fieldConfidences: { odometer_miles: 0.96 },
    });
    expect(staged(db)).toHaveLength(0);
    const text = out.lines.join("\n");
    expect(text).toContain("512,300");
    expect(text).toContain("514,020");
    expect(text).toContain("didn't stage anything");
  });

  it("a big jump stages flagged, not waved through", async () => {
    const { db, store } = fakeWorld({
      trucks: [{ ...TRUCK_214, current_mileage_at: new Date().toISOString() }],
    });
    await stageOdometerPhoto(store, {
      documentId: DOC_ID,
      fields: { odometer_miles: 520_000 },
      fieldConfidences: { odometer_miles: 0.96 },
    });
    const items = staged(db);
    expect(items).toHaveLength(1);
    expect(items[0]!.quote).toContain("flagged");
  });
});
