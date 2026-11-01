// Agent omnipresence (docs/design/driver-mvp.md §9). The full
// tool registry + dump intake against an in-memory fake Supabase
// client (same pattern as agent-turn.test.ts):
// - read tools answer for every entity, including document CONTENT
//   (extracted_text) when the column exists, and say so plainly
//   when the column isn't in the database yet (graceful absence);
// - write tools create/update across the tabs, validated end to end;
// - delete_record NEVER executes inside the loop, even on a direct
//   order - it stages a proposal and only the owner's yes deletes;
// - a dump becomes ONE numbered batch: nothing writes before
//   approval, approval by number writes exactly the chosen items,
//   a correction rewrites the stored proposal (and only the later
//   yes records it), and an extracted value that appears nowhere
//   in the dump is rejected before staging.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { buildBotTools, executeWriteTool } from "@/services/bot/tools";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type {
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const TRAILER_ID = "12121212-1212-4212-8212-121212121212";
const DRIVER_ID = "13131313-1313-4313-8313-131313131313";
const BROKER_ID = "14141414-1414-4414-8414-141414141414";
const DOC_ID = "15151515-1515-4515-8515-151515151515";
const LOAD_ID = "16161616-1616-4616-8616-161616161616";
const SCHEDULE_ID = "17171717-1717-4717-8717-171717171717";
const CHECKLIST_ID = "18181818-1818-4818-8818-181818181818";
const EXPENSE_ID = "19191919-1919-4919-8919-191919191919";
const FUEL_ID = "20202020-2020-4020-8020-202020202020";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "gte" | "in" | "ilike"; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq":
        return value === f.val;
      case "is":
        return f.val === null ? value === null || value === undefined : value === f.val;
      case "gte":
        return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      case "ilike": {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        return typeof value === "string" && value.toLowerCase().includes(needle);
      }
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private countHead = false;
  private wantCount = false;
  private forcedError: { message: string } | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private nextStamp: () => string,
    private missingColumns: Record<string, string[]>,
  ) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    // Simulate a migration that hasn't landed: selecting a column
    // listed as missing for this table errors like PostgREST would.
    const missing = (this.missingColumns[this.table] ?? []).find(
      (token) => typeof cols === "string" && cols.includes(token),
    );
    if (missing && this.op === "select") {
      this.forcedError = { message: `column ${this.table}.${missing} does not exist` };
    }
    if (opts?.head) this.countHead = true;
    if (opts?.count) this.wantCount = true;
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
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  ilike(col: string, val: unknown) {
    this.filters.push({ op: "ilike", col, val });
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
    if (this.forcedError && this.op === "select") {
      return { data: null, error: this.forcedError, count: null };
    }
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const row: Row = {
        id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: this.nextStamp(),
        ...this.payload,
      };
      rows.push(row);
      return { data: single || maybe ? row : null, error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) {
        if (matches(row, this.filters)) Object.assign(row, this.payload);
      }
      return { data: null, error: null, count: null };
    }
    let matched = rows.filter((row) => matches(row, this.filters));
    if (this.countHead) return { data: null, error: null, count: matched.length };
    if (this.orderCol) {
      const col = this.orderCol;
      matched = [...matched].sort((a, b) => {
        const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
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
    return { data: matched, error: null, count: this.wantCount ? matched.length : null };
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

function fakeClient(
  seed: Record<string, Row[]>,
  missingColumns: Record<string, string[]> = {},
): { client: SupabaseClient; db: Record<string, Row[]> } {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  let tick = 0;
  const base = Date.now();
  const nextStamp = () => new Date(base + tick++ * 1000).toISOString();
  const client = {
    from: (table: string) => new FakeQuery(db, table, nextStamp, missingColumns),
  } as unknown as SupabaseClient;
  return { client, db };
}

function baseSeed(): Record<string, Row[]> {
  const today = new Date().toISOString().slice(0, 10);
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false, deleted_at: null }],
    ai_capability_settings: [
      { id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null },
    ],
    telegram_messages: [],
    bot_memories: [],
    bot_pending_actions: [],
    loads: [
      {
        id: LOAD_ID, company_id: COMPANY, origin: "Melbourne, FL", destination: "Atlanta, GA",
        status: "confirmed", pickup_date: today, delivery_date: today, rate_cents: 180000,
        miles: 460, notes: null, truck_id: null, driver_id: null, broker_id: null,
        customer_id: null, deleted_at: null,
      },
    ],
    duty_logs: [
      {
        id: "duty-1", company_id: COMPANY, duty_status: "driving",
        started_at: new Date().toISOString(), location: "I-95", notes: null, deleted_at: null,
      },
    ],
    expenses: [
      {
        id: EXPENSE_ID, company_id: COMPANY, category: "repairs", amount_cents: 8800,
        expense_date: today, description: "tire repair", load_id: null, truck_id: null,
        driver_id: null, deleted_at: null,
      },
    ],
    fuel_purchases: [
      {
        id: FUEL_ID, company_id: COMPANY, truck_id: TRUCK_ID, location: "Pilot, Jacksonville",
        gallons: 50, price_per_gallon_cents: 589, total_cost_cents: 29450,
        purchased_at: new Date().toISOString(), deleted_at: null,
      },
    ],
    trucks: [
      {
        id: TRUCK_ID, company_id: COMPANY, unit_number: "101", vin: "1XKAD49X", make: "Kenworth",
        model: "T680", year: 2021, status: "active", current_mileage: 512000, deleted_at: null,
        height_in: 162, length_in: 860, weight_lbs: 80000, governed_speed_mph: 68,
        tank_capacity_gallons: 120, avg_mpg: 6.5, appliances: null, appliance_notes: null,
      },
    ],
    trailers: [
      { id: TRAILER_ID, company_id: COMPANY, unit_number: "T-7", trailer_type: "dry van", status: "active", deleted_at: null },
    ],
    drivers: [
      {
        id: DRIVER_ID, company_id: COMPANY, name: "Sajacous Smith", cdl_number: "S520-000-00",
        assigned_truck_id: TRUCK_ID, status: "active", deleted_at: null,
      },
    ],
    brokers: [
      { id: BROKER_ID, company_id: COMPANY, name: "Steven (owner)", mc_number: null, contact_email: null, contact_phone: null, notes: null, deleted_at: null },
    ],
    customers: [],
    documents: [
      {
        id: DOC_ID, company_id: COMPANY, related_entity_type: "load", related_entity_id: LOAD_ID,
        file_name: "bol-melbourne.jpg", storage_path: "docs/bol.jpg",
        uploaded_at: new Date().toISOString(), created_at: new Date().toISOString(),
        extracted_text: "BILL OF LADING. Pickup number PU-88412. Gate code 4417. Pieces: 22 pallets.",
      },
    ],
    dispatch_exchanges: [],
    pretrip_inspections: [
      {
        id: "insp-1", company_id: COMPANY, truck_id: TRUCK_ID, trailer_id: null, driver_id: null,
        inspected_at: new Date().toISOString(), passed: true, defects_found: null, deleted_at: null,
      },
    ],
    equipment_checklist_items: [
      {
        id: CHECKLIST_ID, company_id: COMPANY, truck_id: TRUCK_ID, trailer_id: null,
        item_name: "Spare fuses", quantity_on_hand: 4, last_checked_date: twentyDaysAgo,
        notes: null, deleted_at: null,
      },
    ],
    maintenance_events: [
      {
        id: "maint-1", company_id: COMPANY, truck_id: TRUCK_ID, description: "Oil change",
        cost_cents: 32000, service_date: twentyDaysAgo, mileage_at_service: 505000, deleted_at: null,
      },
    ],
    maintenance_schedules: [
      {
        id: SCHEDULE_ID, company_id: COMPANY, truck_id: TRUCK_ID, trailer_id: null,
        description: "Inspect trailer pigtail", interval_miles: null, interval_days: 30,
        last_done_date: twentyDaysAgo, last_done_mileage: null, status: "active", deleted_at: null,
      },
    ],
    industry_briefings: [
      {
        id: "brief-1", company_id: COMPANY, summary: "Diesel up 15 cents in the Southeast.",
        confidence: "high", generated_at: new Date().toISOString(), dismissed_at: null,
      },
    ],
  };
}

function store(client: SupabaseClient): BotBrainStore {
  return createBotStore(client, COMPANY, "telegram");
}

function tool(store_: BotBrainStore, name: string) {
  const found = buildBotTools(store_).find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing from the registry`);
  return found;
}

function scriptedProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const runToolTurn = vi.fn(async () => {
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    return turn;
  });
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent turn");
    },
    runToolTurn,
  };
  return { provider, runToolTurn };
}

function neverCalledProvider() {
  const runToolTurn = vi.fn(async (): Promise<AiToolTurnResult> => {
    throw new Error("the model must not be called on this path");
  });
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("the model must not be called on this path");
    },
    runToolTurn,
  };
  return { provider, runToolTurn };
}

function input(userText: string): BotChatInput {
  return { userText, history: [], snapshotText: null, instructions: [], memories: [] };
}

describe("extended read tools - happy paths (§9)", () => {
  it("answers across the fleet, money, and compliance tabs from real rows", async () => {
    const { client } = fakeClient(baseSeed());
    const s = store(client);

    const trucks = await tool(s, "list_trucks").run({});
    expect(trucks).toContain("Truck 101");
    expect(trucks).toContain(TRUCK_ID);

    const truck = await tool(s, "get_truck").run({ truck_id: TRUCK_ID });
    expect(truck).toContain("governed 68 mph");
    expect(truck).toContain("Appliances in the truck: none captured yet");

    const trailers = await tool(s, "list_trailers").run({});
    expect(trailers).toContain("dry van");

    const drivers = await tool(s, "list_drivers").run({});
    expect(drivers).toContain("Sajacous Smith");
    expect(drivers).toContain("CDL on file: yes");
    expect(drivers).not.toContain("S520"); // the CDL number itself is never quoted

    const expenses = await tool(s, "list_expenses").run({});
    expect(expenses).toContain("tire repair");
    expect(expenses).toContain("$88.00");

    const fuel = await tool(s, "list_fuel_purchases").run({});
    expect(fuel).toContain("Pilot, Jacksonville");
    expect(fuel).toContain("$294.50");

    const duty = await tool(s, "list_duty_logs").run({});
    expect(duty).toContain("driving");

    const inspections = await tool(s, "list_inspections").run({});
    expect(inspections).toContain("PASSED");

    const checklist = await tool(s, "list_checklist_items").run({});
    expect(checklist).toContain("Spare fuses");

    const events = await tool(s, "list_maintenance_events").run({});
    expect(events).toContain("Oil change");
    expect(events).toContain("$320.00");

    const schedules = await tool(s, "list_maintenance_schedules").run({});
    expect(schedules).toContain("Inspect trailer pigtail");
    expect(schedules).toContain("DUE-SOON");

    const briefings = await tool(s, "list_industry_briefings").run({});
    expect(briefings).toContain("Diesel up 15 cents");
  });

  it("reads a document's extracted text, and searches inside it", async () => {
    const { client } = fakeClient(baseSeed());
    const s = store(client);

    const doc = await tool(s, "get_document").run({ document_id: DOC_ID });
    expect(doc).toContain("PU-88412");
    expect(doc).toContain("Gate code 4417");

    const hits = await tool(s, "search_documents").run({ query: "PU-88412" });
    expect(hits).toContain("bol-melbourne.jpg");
    expect(hits).toContain(DOC_ID);
  });

  it("degrades honestly when extracted_text isn't in the database yet (graceful absence)", async () => {
    const { client } = fakeClient(baseSeed(), { documents: ["extracted_text"] });
    const s = store(client);

    const doc = await tool(s, "get_document").run({ document_id: DOC_ID });
    expect(doc).toContain("bol-melbourne.jpg");
    expect(doc).toContain("not available yet");
    expect(doc).not.toContain("PU-88412");

    const hits = await tool(s, "search_documents").run({ query: "bol" });
    expect(hits).toContain("bol-melbourne.jpg");
    expect(hits).toContain("matched file names only");
  });

  it("degrades honestly when the truck profile columns aren't in the database yet", async () => {
    const { client } = fakeClient(baseSeed(), { trucks: ["appliances", "height_in"] });
    const s = store(client);
    const truck = await tool(s, "get_truck").run({ truck_id: TRUCK_ID });
    expect(truck).toContain("Truck 101");
    expect(truck).toContain("aren't in the database yet");
  });
});

describe("extended write tools - happy paths (§9)", () => {
  it("creates and updates across the tabs, validated end to end", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);

    // Loads: create + status change via update.
    const created = await executeWriteTool(s, "create_load", {
      origin: "Jacksonville, FL", destination: "Savannah, GA", rate_dollars: 950, status: "draft",
    });
    expect(created).toContain("Created load");
    expect(db.loads).toHaveLength(2);
    const newLoad = db.loads!.find((r) => r.origin === "Jacksonville, FL")!;
    expect(newLoad).toMatchObject({ rate_cents: 95000, status: "draft" });

    const updated = await executeWriteTool(s, "update_load", { load_id: LOAD_ID, status: "completed" });
    expect(updated).toContain("status");
    expect(db.loads!.find((r) => r.id === LOAD_ID)!.status).toBe("completed");

    // Contacts.
    await executeWriteTool(s, "create_broker", { name: "BlueBridge Logistics", mc_number: "MC-104422" });
    expect(db.brokers).toHaveLength(2);
    await executeWriteTool(s, "update_broker", { broker_id: BROKER_ID, notes: "Pays Fridays" });
    expect(db.brokers!.find((r) => r.id === BROKER_ID)!.notes).toBe("Pays Fridays");
    await executeWriteTool(s, "create_customer", { name: "Peach State Foods" });
    expect(db.customers).toHaveLength(1);
    await executeWriteTool(s, "create_driver", { name: "Marcus Reed", status: "active" });
    expect(db.drivers).toHaveLength(2);

    // Fleet: truck incl. appliances, trailer.
    await executeWriteTool(s, "update_truck", { truck_id: TRUCK_ID, appliances: ["fridge", "microwave"] });
    expect(db.trucks![0]!.appliances).toEqual(["fridge", "microwave"]);
    await executeWriteTool(s, "create_trailer", { unit_number: "T-9", trailer_type: "reefer" });
    expect(db.trailers).toHaveLength(2);

    // Money corrections.
    await executeWriteTool(s, "update_expense", { expense_id: EXPENSE_ID, amount_dollars: 92.5 });
    expect(db.expenses![0]!.amount_cents).toBe(9250);
    await executeWriteTool(s, "update_fuel_purchase", { fuel_purchase_id: FUEL_ID, total_dollars: 300 });
    expect(db.fuel_purchases![0]).toMatchObject({ total_cost_cents: 30000, price_per_gallon_cents: 600 });

    // Maintenance: event, schedule, completion.
    await executeWriteTool(s, "create_maintenance_event", {
      truck_id: TRUCK_ID, description: "Brake pads", cost_dollars: 210, service_date: "2026-10-30",
    });
    expect(db.maintenance_events).toHaveLength(2);
    await executeWriteTool(s, "complete_maintenance_schedule", { schedule_id: SCHEDULE_ID, done_date: "2026-10-31" });
    expect(db.maintenance_schedules![0]!.last_done_date).toBe("2026-10-31");

    // Checklist + inspection.
    await executeWriteTool(s, "create_checklist_item", { truck_id: TRUCK_ID, item_name: "Zip ties" });
    expect(db.equipment_checklist_items).toHaveLength(2);
    await executeWriteTool(s, "update_checklist_item", { item_id: CHECKLIST_ID, mark_checked: true });
    expect(db.equipment_checklist_items![0]!.last_checked_date).toBe(new Date().toISOString().slice(0, 10));
    await executeWriteTool(s, "log_pretrip_inspection", {
      truck_id: TRUCK_ID, passed: false, defects_found: "Left marker light out",
    });
    expect(db.pretrip_inspections).toHaveLength(2);
    expect(db.pretrip_inspections![1]).toMatchObject({ passed: false, defects_found: "Left marker light out" });

    // Documents: attach the BOL to the load (it already is - re-point to the truck proves the write).
    const attach = await executeWriteTool(s, "attach_document", {
      document_id: DOC_ID, related_entity_type: "truck", related_entity_id: TRUCK_ID,
    });
    expect(attach).toContain("bol-melbourne.jpg");
    expect(db.documents![0]).toMatchObject({ related_entity_type: "truck", related_entity_id: TRUCK_ID });
  });

  it("refuses to write a row the UI's own schema rejects", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    // delivery before pickup violates loads' cross-field rule.
    await expect(
      executeWriteTool(s, "create_load", {
        origin: "A", destination: "B", pickup_date: "2026-11-05", delivery_date: "2026-11-01",
      }),
    ).rejects.toThrow();
    expect(db.loads).toHaveLength(1);
  });
});

describe("delete_record - always confirms (§9)", () => {
  it("stages a proposal even on a direct order; only the owner's yes deletes", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "delete_record",
            arguments: JSON.stringify({ entity: "broker", record_id: BROKER_ID, confirmation: "execute" }),
          },
        ],
      },
      { text: "That's staged - it deletes only if you say yes.", toolCalls: [] },
    ]);

    const first = await runAgentTurn(provider, s, input("Delete that broker record"));
    expect(first.reply).toContain("NOT recorded");
    expect(db.brokers![0]!.deleted_at).toBeNull();
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(1);

    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const second = await runAgentTurn(noModel, s, input("yes"));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(second.reply).toContain("deleted broker Steven (owner)");
    expect(db.brokers![0]!.deleted_at).not.toBeNull();
  });
});

const DUMP_TEXT =
  "Picked up in Melbourne, load going to Atlanta. Steven said fuel on his card. Gate code 4417 at the receiver. Fridge and microwave in the truck.";

function dumpProvider(): AgentCapableProvider {
  const { provider } = scriptedProvider([
    {
      text: null,
      toolCalls: [
        {
          id: "c1",
          name: "stage_dump_items",
          arguments: JSON.stringify({
            confirmation: "propose",
            items: [
              {
                tool_name: "create_load",
                args: { origin: "Melbourne", destination: "Atlanta", notes: "Gate code 4417" },
                source_quote: "Gate code 4417 at the receiver",
                confidence: "high",
              },
              {
                tool_name: "update_truck",
                args: { truck_id: TRUCK_ID, appliances: ["fridge", "microwave"] },
                source_quote: "Fridge and microwave in the truck",
                confidence: "high",
              },
              {
                tool_name: "save_memory",
                args: { kind: "fact", content: "Fuel on Steven's card for this run" },
                source_quote: "Steven said fuel on his card",
                confidence: "medium",
              },
              {
                tool_name: "create_expense",
                args: { category: "other", amount_dollars: 999, description: "tolls" },
                source_quote: "Steven said fuel on his card",
                confidence: "low",
              },
            ],
          }),
        },
      ],
    },
    { text: "Pulled what I could from that - one item didn't check out and I left it out.", toolCalls: [] },
  ]);
  return provider;
}

describe("dump intake (§9)", () => {
  it("stages ONE numbered batch, writes nothing, and rejects the ungrounded item", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);

    const out = await runAgentTurn(dumpProvider(), s, input(DUMP_TEXT));

    expect(out.reply).toContain("NOT recorded any of this yet");
    expect(out.reply).toContain("1. Load: Melbourne → Atlanta");
    expect(out.reply).toContain("2. Update truck");
    expect(out.reply).toContain("3. Memory (fact)");
    // Nothing written anywhere.
    expect(db.loads).toHaveLength(1);
    expect(db.trucks![0]!.appliances).toBeNull();
    expect(db.bot_memories).toHaveLength(0);
    expect(db.expenses).toHaveLength(1);
    // Three staged items (the $999 expense was rejected in code),
    // sharing one batch with stable numbers.
    const pending = db.bot_pending_actions!.filter((r) => !r.deleted_at);
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((r) => r.batch_id)).size).toBe(1);
    expect(pending.map((r) => r.item_number).sort()).toEqual([1, 2, 3]);
  });

  it("approve by number writes exactly the chosen items; the rest stays pending until dropped", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    await runAgentTurn(dumpProvider(), s, input(DUMP_TEXT));

    const { provider: noModel, runToolTurn } = neverCalledProvider();
    const picked = await runAgentTurn(noModel, s, input("approve 1, 3"));
    expect(runToolTurn).not.toHaveBeenCalled();
    expect(picked.reply).toContain("recorded 2");
    expect(picked.reply).toContain("Still waiting");
    expect(db.loads).toHaveLength(2);
    expect(db.loads!.find((r) => r.origin === "Melbourne")).toMatchObject({ destination: "Atlanta" });
    expect(db.bot_memories).toHaveLength(1);
    expect(db.trucks![0]!.appliances).toBeNull(); // item 2 NOT written
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(1);

    const dropped = await runAgentTurn(noModel, s, input("drop the rest"));
    expect(dropped.reply).toContain("Dropped");
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
    expect(db.trucks![0]!.appliances).toBeNull();
  });

  it("approve all writes the whole batch, including the truck's appliances", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    await runAgentTurn(dumpProvider(), s, input(DUMP_TEXT));

    const { provider: noModel } = neverCalledProvider();
    const done = await runAgentTurn(noModel, s, input("yes"));
    expect(done.reply).toContain("recorded all 3");
    expect(db.loads).toHaveLength(2);
    expect(db.bot_memories).toHaveLength(1);
    expect(db.trucks![0]!.appliances).toEqual(["fridge", "microwave"]);
    expect(db.bot_pending_actions!.filter((r) => !r.deleted_at)).toHaveLength(0);
  });

  it("a correction rewrites the stored proposal; only the later yes records the corrected value", async () => {
    const { client, db } = fakeClient(baseSeed());
    const s = store(client);
    await runAgentTurn(dumpProvider(), s, input(DUMP_TEXT));

    const { provider } = scriptedProvider([
      {
        text: null,
        toolCalls: [
          {
            id: "c1",
            name: "revise_pending_item",
            arguments: JSON.stringify({
              item_number: 1,
              patch: { origin: "Melbourne, FL" },
              confirmation: "execute",
            }),
          },
        ],
      },
      { text: "Fixed - item 1 now says Melbourne, FL. Still not recorded until you approve.", toolCalls: [] },
    ]);
    const corrected = await runAgentTurn(provider, s, input("1 is wrong, origin is Melbourne, FL"));
    expect(corrected.reply).toContain("Melbourne, FL");
    expect(db.loads).toHaveLength(1); // the correction itself wrote nothing

    const pendingItem = db.bot_pending_actions!.find((r) => !r.deleted_at && r.item_number === 1)!;
    expect((pendingItem.arguments as Row).origin).toBe("Melbourne, FL");
    expect(String(pendingItem.summary)).toContain("Melbourne, FL");

    const { provider: noModel } = neverCalledProvider();
    await runAgentTurn(noModel, s, input("yes"));
    expect(db.loads!.find((r) => r.destination === "Atlanta")).toMatchObject({ origin: "Melbourne, FL" });
  });
});
