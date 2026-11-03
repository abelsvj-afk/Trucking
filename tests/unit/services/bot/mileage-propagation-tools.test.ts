// Mileage propagation through the real write tools (Image
// Intelligence §5.3, acceptance B3): a duty-log odometer and a
// fuel odometer each move the truck's current_mileage the same
// day, stamped with where the number came from - and no path can
// move it backwards silently.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";
import { executeWriteTool } from "@/services/bot/tools";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const LOAD_ID = "16161616-1616-4616-8616-161616161616";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is"; col: string; val: unknown };

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private limitN: number | null = null;

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
  limit(n: number) {
    this.limitN = n;
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
      const row = { id: `new-${this.table}-${(this.db[this.table] ?? []).length + 1}`, ...this.payload };
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
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? 1 : -1));
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return { data: rows, error: null };
  }

  async single() {
    return this.execute();
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

function fakeWorld() {
  const db: Record<string, Row[]> = {
    trucks: [
      {
        id: TRUCK_ID,
        company_id: COMPANY,
        unit_number: "214",
        status: "active",
        current_mileage: 514_020,
        current_mileage_source: null,
        current_mileage_at: null,
        deleted_at: null,
      },
    ],
    loads: [{ id: LOAD_ID, company_id: COMPANY, truck_id: TRUCK_ID, deleted_at: null }],
    fuel_purchases: [],
    duty_logs: [],
    maintenance_events: [],
    bot_pending_actions: [],
  };
  const client = { from: (table: string) => new FakeQuery(db, table) };
  const store = createBotStore(client as unknown as SupabaseClient, COMPANY, "telegram");
  return { db, store };
}

function truck(db: Record<string, Row[]>) {
  return db.trucks![0]!;
}

describe("mileage propagation through the write tools (§5.3)", () => {
  it("a fuel entry's odometer moves the truck's mileage, stamped fuel_entry (B3)", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "create_fuel_purchase", {
      total_dollars: 412.5,
      gallons: 110,
      odometer: 514_400,
    });
    expect(out).toContain("Truck mileage now 514,400");
    expect(db.fuel_purchases![0]).toMatchObject({ odometer: 514_400 });
    expect(truck(db).current_mileage).toBe(514_400);
    expect(truck(db).current_mileage_source).toBe("fuel_entry");
  });

  it("a fuel entry without an odometer lands fine and says nothing about mileage (D-6)", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "create_fuel_purchase", {
      total_dollars: 200,
      gallons: 55,
    });
    expect(out).toContain("Recorded fuel purchase");
    expect(out.toLowerCase()).not.toContain("mileage now");
    expect(truck(db).current_mileage).toBe(514_020);
  });

  it("a duty-log odometer moves the mileage through the load's truck (B3)", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "log_duty_status", {
      duty_status: "driving",
      odometer: 514_650,
      load_id: LOAD_ID,
    });
    expect(out).toContain("Truck mileage now 514,650");
    expect(truck(db).current_mileage).toBe(514_650);
    expect(truck(db).current_mileage_source).toBe("duty_log");
  });

  it("a duty-log odometer with no load moves nothing - and says so", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "log_duty_status", {
      duty_status: "on_duty",
      odometer: 514_650,
    });
    expect(out).toContain("isn't tied to a load");
    expect(truck(db).current_mileage).toBe(514_020);
  });

  it("a maintenance event's service mileage propagates (source: the service record)", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "create_maintenance_event", {
      truck_id: TRUCK_ID,
      description: "Oil change",
      service_date: "2026-11-02",
      mileage_at_service: 514_700,
    });
    expect(out).toContain("Truck mileage now 514,700");
    expect(truck(db).current_mileage_source).toBe("maintenance_event");
  });

  it("update_truck refuses a backwards mileage and reports it instead of applying it", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "update_truck", {
      truck_id: TRUCK_ID,
      current_mileage: 500_000,
    });
    expect(out).toContain("Mileage NOT changed");
    expect(truck(db).current_mileage).toBe(514_020);
  });

  it("update_truck stamps the stated source for a forward mileage", async () => {
    const { db, store } = fakeWorld();
    const out = await executeWriteTool(store, "update_truck", {
      truck_id: TRUCK_ID,
      current_mileage: 515_000,
      mileage_source: "owner_said",
    });
    expect(out).toContain("Mileage now 515,000 (from his word)");
    expect(truck(db).current_mileage_source).toBe("owner_said");
  });
});
