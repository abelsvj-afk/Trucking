// D10 (Telegram review 2026-11-12): raw UUIDs + ISO timestamps must never
// reach the owner. The render layer (plainSummary) strips them, but the
// summarize / confirm / run-return sites are fixed at source too, so a
// model quoting a tool result verbatim still can't leak an id. Every
// proposal summary and every run result below is asserted id-free even
// when the arguments carry real UUIDs.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import { buildExtendedWriteTools } from "@/services/bot/tools-write";

const COMPANY = "company-1";
const LOAD_ID = "50dde25b-6aed-42e5-b63f-fffa64fd7b56";
const TRUCK_ID = "11111111-2222-4333-8444-555555555555";
const TRAILER_ID = "22222222-3333-4444-8555-666666666666";
const EXPENSE_ID = "33333333-4444-4555-8666-777777777777";
const FUEL_ID = "44444444-5555-4666-8777-888888888888";
const BROKER_ID = "55555555-6666-4777-8888-999999999999";
const CUSTOMER_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const FACILITY_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const EVENT_ID = "88888888-9999-4aaa-8bbb-cccccccccccc";
const SCHEDULE_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const DEFECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ITEM_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const CREDENTIAL_ID = "cccccccc-dddd-4eee-8fff-000000000000";
const INVOICE_ID = "dddddddd-eeee-4fff-8000-111111111111";
const OBLIGATION_ID = "eeeeeeee-ffff-4000-8111-222222222222";
const FOLLOWUP_ID = "ffffffff-0000-4111-8222-333333333333";
const DRIVER_ID = "00000000-1111-4222-8333-444444444444";
const REQUEST_ID = "11111111-0000-4333-8444-555555555555";
const DRAFT_ID = "22222222-0000-4444-8555-666666666666";
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
      // Unlike the set-load-stops copy of this fake, updates return the
      // matched rows: dismissResearchRequest decides "dismissed" from
      // the returned row count.
      const matched = rows.filter((row) => matches(row, this.filters));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null, count: null };
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

function stubStore(client: SupabaseClient) {
  const store = { client, companyId: COMPANY, channel: "telegram", saveMemory: vi.fn(async () => "new-memory-id") } as unknown as BotBrainStore;
  return store;
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

const TRUCK_ROW: Row = {
  id: TRUCK_ID,
  company_id: COMPANY,
  unit_number: "101",
  deleted_at: null,
};

/** Every update/confirm proposal: args carry a real UUID, the summary must not. */
const SUMMARIZE_CASES: Array<{ tool: string; args: Record<string, unknown>; from: "write" | "bot" }> = [
  { tool: "update_load", args: { load_id: LOAD_ID, status: "completed" }, from: "write" },
  { tool: "complete_load", args: { load_id: LOAD_ID, delivery_date: "2026-11-12" }, from: "write" },
  { tool: "update_expense", args: { expense_id: EXPENSE_ID, amount_dollars: 25 }, from: "write" },
  { tool: "update_fuel_purchase", args: { fuel_purchase_id: FUEL_ID, gallons: 40 }, from: "write" },
  { tool: "update_broker", args: { broker_id: BROKER_ID, name: "Acme Freight" }, from: "write" },
  { tool: "update_customer", args: { customer_id: CUSTOMER_ID, name: "Kontoor" }, from: "write" },
  { tool: "update_facility", args: { facility_id: FACILITY_ID, name: "DC 8" }, from: "write" },
  { tool: "update_truck", args: { truck_id: TRUCK_ID, unit_number: "101" }, from: "write" },
  { tool: "update_trailer", args: { trailer_id: TRAILER_ID, unit_number: "H1181" }, from: "write" },
  { tool: "update_maintenance_event", args: { event_id: EVENT_ID, description: "Oil change" }, from: "write" },
  { tool: "update_maintenance_schedule", args: { schedule_id: SCHEDULE_ID, description: "Oil every 10k" }, from: "write" },
  { tool: "complete_maintenance_schedule", args: { schedule_id: SCHEDULE_ID, done_date: "2026-11-12" }, from: "write" },
  { tool: "resolve_vehicle_defect", args: { defect_id: DEFECT_ID, status: "closed" }, from: "write" },
  { tool: "propose_maintenance_pack", args: { truck_id: TRUCK_ID }, from: "write" },
  { tool: "update_checklist_item", args: { item_id: ITEM_ID, item_name: "Check tires" }, from: "write" },
  { tool: "update_credential", args: { credential_id: CREDENTIAL_ID, label: "TWIC" }, from: "write" },
  { tool: "update_load_invoice", args: { invoice_id: INVOICE_ID, amount_dollars: 100 }, from: "write" },
  { tool: "update_recurring_obligation", args: { obligation_id: OBLIGATION_ID, name: "Rent" }, from: "write" },
  { tool: "update_broker_followup", args: { followup_id: FOLLOWUP_ID, note: "Call broker" }, from: "write" },
  { tool: "update_driver", args: { driver_id: DRIVER_ID, name: "Sajacous" }, from: "write" },
  { tool: "create_load_invoice", args: { load_id: LOAD_ID, amount_dollars: 1200, due_date: "2026-11-20" }, from: "write" },
  { tool: "create_broker_followup", args: { broker_id: BROKER_ID, due_on: "2026-11-13", note: "Call about detention" }, from: "write" },
  { tool: "dismiss_research_request", args: { request_id: REQUEST_ID }, from: "write" },
  { tool: "delete_record", args: { entity: "load", record_id: LOAD_ID }, from: "write" },
  { tool: "request_pretrip_photos", args: { load_id: LOAD_ID, items: ["BOL", "seal photo"] }, from: "write" },
  { tool: "send_email", args: { draft_id: DRAFT_ID, fingerprint: "abcdef123456" }, from: "bot" },
  { tool: "stamp_detention", args: { load_id: LOAD_ID, stamp_type: "arrival", stop_kind: "delivery" }, from: "bot" },
  { tool: "add_load_note", args: { load_id: LOAD_ID, note: "Gate code 1234" }, from: "bot" },
];

describe("D10: no raw ids in owner-facing proposal summaries", () => {
  it.each(SUMMARIZE_CASES)("$tool summarize carries no uuid", ({ tool: name, args, from }) => {
    const { client } = fakeClient({ loads: [LOAD_ROW], trucks: [TRUCK_ROW] });
    const store = stubStore(client);
    const tools = from === "write" ? buildExtendedWriteTools(store) : buildBotTools(store);
    const summary = tool(tools, name).summarize!(args);
    expect(summary).not.toMatch(UUID_SHAPE);
    expect(summary).not.toContain("Record id");
    // The words still say what the proposal does.
    expect(summary.length).toBeGreaterThan(5);
  });
});

describe("D10: no raw ids in run results", () => {
  it("update_load + complete_load confirm in words, never the load id", async () => {
    const { client } = fakeClient({ loads: [LOAD_ROW] });
    const store = stubStore(client);
    const tools = buildExtendedWriteTools(store);
    const updated = await tool(tools, "update_load").run({ load_id: LOAD_ID, status: "completed" });
    expect(updated).not.toMatch(UUID_SHAPE);
    expect(updated).not.toContain(LOAD_ID);
    expect(updated).toContain("Updated the load");
    const completed = await tool(tools, "complete_load").run({ load_id: LOAD_ID, delivery_date: "2026-11-12" });
    expect(completed).not.toMatch(UUID_SHAPE);
    expect(completed).not.toContain(LOAD_ID);
    expect(completed).toContain("Panama City, FL → Seminole, OK");
  });

  it("create_expense + create_fuel_purchase confirm without a record id", async () => {
    const { client } = fakeClient({ loads: [LOAD_ROW], trucks: [TRUCK_ROW] });
    const store = stubStore(client);
    const tools = buildBotTools(store);
    const expense = await tool(tools, "create_expense").run({
      category: "repairs",
      amount_dollars: 250,
      description: "Tire and mud repair",
      expense_date: "2026-11-08",
      bucket: "pay_deduction",
    });
    expect(expense).not.toMatch(UUID_SHAPE);
    expect(expense).not.toContain("Record id");
    expect(expense).toContain("PAY DEDUCTION");
    const fuel = await tool(tools, "create_fuel_purchase").run({
      truck_id: TRUCK_ID,
      total_dollars: 180,
      gallons: 45,
    });
    expect(fuel).not.toMatch(UUID_SHAPE);
    expect(fuel).not.toContain("Record id");
    expect(fuel).toContain("truck 101");
  });

  it("request_pretrip_photos + dismiss + delete_record return words, never ids", async () => {
    const { client, db } = fakeClient({
      loads: [LOAD_ROW],
      research_requests: [{ id: REQUEST_ID, company_id: COMPANY, status: "queued", deleted_at: null }],
    });
    const store = stubStore(client);
    const tools = buildExtendedWriteTools(store);
    const asked = await tool(tools, "request_pretrip_photos").run({ load_id: LOAD_ID, items: ["BOL", "seal photo"] });
    expect(asked).not.toMatch(UUID_SHAPE);
    expect(asked).not.toContain(LOAD_ID);
    expect(asked).toContain("BOL");
    const dismissed = await tool(tools, "dismiss_research_request").run({ request_id: REQUEST_ID });
    expect(dismissed).not.toMatch(UUID_SHAPE);
    expect(dismissed).not.toContain(REQUEST_ID);
    expect(dismissed).toContain("Dismissed the photo ask");
    const deleted = await tool(tools, "delete_record").run({ entity: "load", record_id: LOAD_ID });
    expect(deleted).not.toMatch(UUID_SHAPE);
    expect(deleted).not.toContain(LOAD_ID);
    expect(db.loads![0]!.deleted_at).toBeTruthy();
  });
});
