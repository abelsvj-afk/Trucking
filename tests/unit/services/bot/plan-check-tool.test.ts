// Abel plan check, agent level (owner 2026-11-17): the owner's
// example shape — arrive by a stated time, a personal stop, sleep
// there, drop in the morning — run through the real tool registry
// against an in-memory fake Supabase client (no network).
//
// Ocala appears here as the owner's example place, in tests only.
// It is never a hardcoded destination in the feature itself.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";
import { buildBotTools } from "@/services/bot/tools";
import { buildDriverQuestionTools } from "@/services/bot/driver-question-tools";
import { gateExecutes } from "@/services/bot/execute-gate";
import { selectToolsForTurn, TOOL_BUDGET } from "@/services/bot/tool-budget";

const COMPANY = "company-1";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "gte"; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    if (f.op === "eq") return value === f.val;
    if (f.op === "is") return f.val === null ? value === null || value === undefined : value === f.val;
    // gte on ISO timestamps compares as strings.
    return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
  });
}

class FakeQuery {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
  ) {}

  select() {
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
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  async single() {
    const rows = this.rows();
    return { data: rows[0] ?? null, error: null };
  }
  then(onFulfilled: (v: { data: Row[]; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
    try {
      return Promise.resolve({ data: this.rows(), error: null }).then(onFulfilled, onRejected);
    } catch (e) {
      return Promise.reject(e).then(onFulfilled, onRejected);
    }
  }
  private rows(): Row[] {
    let rows = (this.db[this.table] ?? []).filter((r) => matches(r, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (typeof av === "string" && typeof bv === "string") return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        return this.orderAsc ? Number(av) - Number(bv) : Number(bv) - Number(av);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
}

function fakeClient(seed: Record<string, Row[]>): SupabaseClient {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  return { from: (table: string) => new FakeQuery(db, table) } as unknown as SupabaseClient;
}

const H = 3_600_000;

function seed(dutyLogs: Row[], loads: Row[] = [], loadStops: Row[] = []): Record<string, Row[]> {
  return {
    companies: [
      {
        id: COMPANY,
        hos_cycle: "70/8",
        hos_period_anchor: null,
        hos_restart_enabled: true,
        hos_carrier_timezone: "America/New_York",
        deleted_at: null,
      },
    ],
    duty_logs: dutyLogs,
    loads,
    load_stops: loadStops,
  };
}

function planEvents(now: number) {
  return [
    { label: "Get to Ocala", drive_minutes: 180, dwell_minutes: 120, arrive_by: new Date(now + 4 * H).toISOString() },
    { label: "Sleep in Ocala", drive_minutes: 0, dwell_minutes: 480, rest_kind: "sleeper" },
    { label: "Drop the load", drive_minutes: 120, dwell_minutes: 0, load_stop: "delivery" },
  ];
}

describe("evaluate_plan — agent level", () => {
  it("is selected for the owner's plain-words plan question", () => {
    const client = fakeClient(seed([]));
    const store = createBotStore(client, COMPANY, "telegram");
    const message =
      "I want to get to Ocala by 9 tonight, visit family, sleep there, and drop the load in the morning — how does that fit my drive time?";
    const catalog = gateExecutes(buildBotTools(store), message);
    const selected = selectToolsForTurn(catalog, message, TOOL_BUDGET - 1);
    expect(selected.map((t) => t.name)).toContain("evaluate_plan");
  });

  it("answers the owner's example shape from his real clocks and the load's appointments", async () => {
    const now = Date.now();
    const deliveryAt = now + 20 * H;
    const client = fakeClient(
      seed(
        // A full 10+ hour rest on file, so his clocks are real and full.
        [{ id: "d1", company_id: COMPANY, duty_status: "off_duty", started_at: new Date(now - 12 * H).toISOString(), deleted_at: null }],
        [
          {
            id: "load-1",
            company_id: COMPANY,
            origin: "Panama City, FL",
            destination: "Ocala, FL",
            status: "confirmed",
            pickup_date: new Date(now).toISOString().slice(0, 10),
            delivery_date: new Date(deliveryAt).toISOString().slice(0, 10),
            deleted_at: null,
          },
        ],
        [
          { id: "s1", company_id: COMPANY, load_id: "load-1", kind: "pickup", seq: 1, appointment_at: new Date(now - H).toISOString(), deleted_at: null },
          { id: "s2", company_id: COMPANY, load_id: "load-1", kind: "delivery", seq: 2, appointment_at: new Date(deliveryAt).toISOString(), deleted_at: null },
        ],
      ),
    );
    const store = createBotStore(client, COMPANY, "telegram");
    const tool = buildDriverQuestionTools(store).find((t) => t.name === "evaluate_plan")!;
    const reply = await tool.run({ events: planEvents(now) });
    expect(reply).toContain("fits — with a split sleeper break");
    expect(reply).toContain("full reset");
    expect(reply).toContain("Load on file: Panama City, FL → Ocala, FL.");
  });

  it("says out loud when no duty logs are on file, so the clocks are assumed full", async () => {
    const now = Date.now();
    const client = fakeClient(seed([]));
    const store = createBotStore(client, COMPANY, "telegram");
    const tool = buildDriverQuestionTools(store).find((t) => t.name === "evaluate_plan")!;
    const reply = await tool.run({
      events: [{ label: "Drop the load", drive_minutes: 60, dwell_minutes: 0 }],
    });
    expect(reply).toContain("assumes you start with full hours");
    expect(reply).toContain("No active load on file");
  });

  it("does not guess drive minutes — it asks for them", async () => {
    const client = fakeClient(seed([]));
    const store = createBotStore(client, COMPANY, "telegram");
    const tool = buildDriverQuestionTools(store).find((t) => t.name === "evaluate_plan")!;
    const reply = await tool.run({
      events: [{ label: "Get to Ocala", dwell_minutes: 120 }],
    });
    expect(reply).toContain("I need the drive minutes");
  });

  it("says plainly when it cannot read a time", async () => {
    const client = fakeClient(seed([]));
    const store = createBotStore(client, COMPANY, "telegram");
    const tool = buildDriverQuestionTools(store).find((t) => t.name === "evaluate_plan")!;
    const reply = await tool.run({
      events: [{ label: "Get to Ocala", drive_minutes: 180, dwell_minutes: 120, arrive_by: "not a time" }],
    });
    expect(reply).toContain("can't read");
  });
});
