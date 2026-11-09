// Telegram fix round (brief fixes 7-9, 11B-b): the burst package
// and the contradiction path in stageRecordables.
// - A photo forwarded WITH a trip rides the SAME proposal batch as
//   the create_load (one yes): attach_document by trip number, and
//   a trailer read from the photo links onto the load itself when
//   that trailer is on file.
// - A forward naming a trip ALREADY on file never stages a second
//   create: identical = nothing staged, said plainly; different =
//   ONE correction batch (update_load + set_load_stops).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { stageRecordables } from "@/services/bot/stage-recordables";
import { parseDispatchTrip, tripToCreateLoadArgs } from "@/lib/dispatch-trip";
import type { FiledPhotoInfo } from "@/services/telegram/photo-intake";

type Row = Record<string, unknown>;

const COMPANY = "44444444-4444-4444-8444-444444444444";
const LOAD_ID = "11111111-1111-4111-8111-111111111111";
const TRAILER_ID = "33333333-3333-4333-8333-333333333333";
const DOC_ID = "55555555-5555-4555-8555-555555555555";

export const TRIP_1874_TEXT = `🚛 NEW TRIP 1874 HAS BEEN ASSIGNED

🏁 STOP 1
SHIPPER/CONSIGNEE: Kontoor Panama City
📍 ADDRESS: 1 Seaport Drive, Panama City, FL 32401
APPT: 11/10/2026 08:00 CST-11/10/2026 16:00 CST
TYPE: Pickup Stop

=======================

🏁 STOP 2
SHIPPER/CONSIGNEE: Kontoor Seminole
📍 ADDRESS: 1400 Wrangler Boulevard West, Seminole, OK 74868
APPT: 11/12/2026 12:00 CST
TYPE: Delivery Stop

=======================

LOT TO
SHIPPER/CONSIGNEE: Kontoor Panama City
📍 ADDRESS: 1 Seaport Drive, Panama City, FL 32401
APPT: 11/16/2026 12:00 CST
TYPE: Delivery Stop

=======================

🧾 TRIP DETAILS

BROKER: ITS Logistics LLC
REF #: 5113964
DEADHEAD: 220.29 mi
LOADED DISTANCE: 890.98 mi
TOTAL DISTANCE: 1,178.27 mi
===================================
❗️Send Picture of trailer in PU/DEL
❗️SEND SEAL PICTURE
❗️SIGNED BOL - should be sent to the group.
❗️Update us in EVERY STOPS.
❗️Do not leave the facility before dispatcher APPROVAL

📵NO TEXTING While driving
🚫NO SPEEDING at any time
✅ PLEASE CHECK AND CONFIRM`;

/** Generic chainable fake over in-memory tables (eq/is filters, insert/update writes). */
class FakeQuery {
  private filters: [string, unknown][] = [];
  private isNulls: string[] = [];
  constructor(
    private readonly table: string,
    private readonly tables: Record<string, Row[]>,
  ) {}
  private rows(): Row[] {
    return (this.tables[this.table] ?? []).filter(
      (r) => this.filters.every(([c, v]) => r[c] === v) && this.isNulls.every((c) => r[c] === null || r[c] === undefined),
    );
  }
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  is(col: string): this {
    this.isNulls.push(col);
    return this;
  }
  ilike(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  insert(row: Row | Row[]): Promise<{ error: null }> {
    const list = this.tables[this.table] ?? (this.tables[this.table] = []);
    for (const r of Array.isArray(row) ? row : [row]) {
      list.push({ ...r, id: r.id ?? `${this.table}-${list.length + 1}`, created_at: new Date().toISOString(), deleted_at: null });
    }
    return Promise.resolve({ error: null });
  }
  update(patch: Row): this & Promise<{ error: null }> {
    const self = this as this & Promise<{ error: null }>;
    const run = () => {
      for (const r of this.rows()) Object.assign(r, patch);
      return { error: null };
    };
    (self as unknown as { __p?: Promise<{ error: null }> }).__p = Promise.resolve().then(run);
    return new Proxy(self, {
      get: (target, prop) => {
        if (prop === "then") {
          return (f?: (v: { error: null }) => unknown, r?: (e: unknown) => unknown) =>
            (target as unknown as { __p: Promise<{ error: null }> }).__p.then(f, r);
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as this & Promise<{ error: null }>;
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onFulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows(), error: null }).then(onFulfilled, onRejected);
  }
}

function makeStore(tables: Record<string, Row[]>): { store: BotBrainStore; tables: Record<string, Row[]> } {
  const client = {
    from: (table: string) => new FakeQuery(table, tables),
  } as unknown as SupabaseClient;
  return { store: createBotStore(client, COMPANY, "telegram"), tables };
}

const FILED_PHOTO: FiledPhotoInfo = {
  documentId: DOC_ID,
  fileName: "telegram-photo-1.jpg",
  identifiers: { trailerNumber: "H11887", pickupNumber: "94405" },
};

describe("stageRecordables - burst package (fixes 7-9)", () => {
  it("photo forwarded with the trip rides the same batch: create + attach, trailer linked, one batchId", async () => {
    const { store, tables } = makeStore({
      bot_pending_actions: [],
      brokers: [],
      loads: [],
      trailers: [{ company_id: COMPANY, id: TRAILER_ID, unit_number: "H11887", deleted_at: null }],
      bot_thread_entities: [],
    });

    const result = await stageRecordables(store, TRIP_1874_TEXT, [], {
      chatId: "4242",
      documents: [FILED_PHOTO],
    });

    const create = result.proposals.find((p) => p.tool === "create_load");
    const attach = result.proposals.find((p) => p.tool === "attach_document");
    expect(create).toBeDefined();
    expect(attach).toBeDefined();
    expect(attach?.args).toMatchObject({
      document_id: DOC_ID,
      related_entity_type: "load",
      related_trip_number: "1874",
    });
    expect(attach?.batchId).toBe(create?.batchId);
    // The trailer read from the photo is on file, so it links onto
    // the create itself - no extra proposal needed.
    expect(create?.args.trailer_id).toBe(TRAILER_ID);
    expect(result.review).toContain("attached to this load in the same yes");
    expect(result.review).toContain("Trailer H11887 is on file");
    // The thread index learned the trip (fix 11A).
    const entities = tables["bot_thread_entities"] ?? [];
    const loadEntity = entities.find((e) => e.entity_type === "load");
    expect(loadEntity).toBeDefined();
    expect(JSON.stringify(loadEntity?.keys)).toContain("1874");
    expect(loadEntity?.is_current).toBe(true);
  });

  it("a trailer NOT on file is named as unlinked, never silently attached", async () => {
    const { store } = makeStore({
      bot_pending_actions: [],
      brokers: [],
      loads: [],
      trailers: [],
      bot_thread_entities: [],
    });
    const result = await stageRecordables(store, TRIP_1874_TEXT, [], {
      chatId: "4242",
      documents: [FILED_PHOTO],
    });
    const create = result.proposals.find((p) => p.tool === "create_load");
    expect(create?.args.trailer_id).toBeUndefined();
    expect(result.review).toContain("no trailer with that number is on file");
  });
});

describe("stageRecordables - already-on-file trips (fix 11B-b)", () => {
  it("a DIFFERENT forward of trip 1874 stages ONE correction: update_load + set_load_stops", async () => {
    // The live failure's shape: the saved load is Panama City ->
    // Panama City with the lot-to stop merged wrong.
    const { store } = makeStore({
      bot_pending_actions: [],
      brokers: [],
      loads: [
        {
          company_id: COMPANY,
          id: LOAD_ID,
          origin: "Panama City, FL",
          destination: "Panama City, FL",
          status: "confirmed",
          pickup_date: "2026-11-10",
          delivery_date: "2026-11-16",
          trip_number: "1874",
          broker_reference: "5113964",
          deleted_at: null,
        },
      ],
      load_stops: [
        { company_id: COMPANY, load_id: LOAD_ID, seq: 1, kind: "pickup", name: "Kontoor Panama City", appointment_at: "2026-11-10T14:00:00.000Z", deleted_at: null },
        { company_id: COMPANY, load_id: LOAD_ID, seq: 2, kind: "delivery", name: "Kontoor Panama City", appointment_at: "2026-11-16T18:00:00.000Z", deleted_at: null },
      ],
      bot_thread_entities: [],
    });

    const result = await stageRecordables(store, TRIP_1874_TEXT, [], { chatId: "4242" });
    const tools = result.proposals.map((p) => p.tool);
    expect(tools).not.toContain("create_load");
    expect(tools).toContain("update_load");
    expect(tools).toContain("set_load_stops");
    const update = result.proposals.find((p) => p.tool === "update_load");
    expect(update?.args.destination).toBe("Seminole, OK");
    expect(update?.args.delivery_date).toBe("2026-11-12");
    const stops = result.proposals.find((p) => p.tool === "set_load_stops");
    expect(stops?.batchId).toBe(update?.batchId);
    expect((stops?.args.stops as unknown[]).length).toBe(3);
    expect(result.review).toContain("CORRECTED TRIP 1874");
    expect(result.review).toContain("On file now: Trip 1874, Panama City, FL → Panama City, FL");
  });

  it("an IDENTICAL forward stages nothing and says the load is already on file", async () => {
    const trip = parseDispatchTrip(TRIP_1874_TEXT);
    expect(trip).not.toBeNull();
    const args = tripToCreateLoadArgs(trip!)!;
    expect(args).not.toBeNull();
    const stops = (args.stops as { seq: number; kind: string; name?: string; appointment_at?: string }[]).map((s) => ({
      company_id: COMPANY,
      load_id: LOAD_ID,
      seq: s.seq,
      kind: s.kind,
      name: s.name ?? null,
      appointment_at: s.appointment_at ?? null,
      deleted_at: null,
    }));
    const { store } = makeStore({
      bot_pending_actions: [],
      brokers: [],
      loads: [
        {
          company_id: COMPANY,
          id: LOAD_ID,
          origin: args.origin,
          destination: args.destination,
          status: "confirmed",
          pickup_date: args.pickup_date,
          delivery_date: args.delivery_date,
          trip_number: "1874",
          broker_reference: "5113964",
          pickup_window_start: args.pickup_window_start ?? null,
          pickup_window_end: args.pickup_window_end ?? null,
          delivery_window_start: args.delivery_window_start ?? null,
          delivery_window_end: args.delivery_window_end ?? null,
          miles: args.miles ?? null,
          loaded_miles: args.loaded_miles ?? null,
          deadhead_miles: args.deadhead_miles ?? null,
          deleted_at: null,
        },
      ],
      load_stops: stops,
      bot_thread_entities: [],
    });

    const result = await stageRecordables(store, TRIP_1874_TEXT, [], { chatId: "4242" });
    expect(result.proposals).toHaveLength(0);
    expect(result.review).toContain("already on file exactly like this");
  });
});
