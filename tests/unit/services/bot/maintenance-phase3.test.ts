// The maintenance brain (Image Intelligence §5): event→schedule
// pairing (C1), the defect lifecycle off a failed pre-trip (C2),
// a passed pre-trip changing nothing (C3), the one-yes pack
// (§5.2), and the outlook computation (§5.7) - all against an
// in-memory fake, through the real tools and stores.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { executeWriteTool } from "@/services/bot/tools";
import { expandMaintenancePairings } from "@/services/bot/maintenance-pairing";
import { stageMaintenancePack } from "@/services/fleet/maintenance-seeding";
import {
  computeMaintenanceOutlook,
  formatMaintenanceOutlook,
} from "@/services/fleet/maintenance-outlook";
import type { ProposedWrite } from "@/services/ai/agent-loop";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const SCHEDULE_ID = "17171717-1717-4717-8717-171717171717";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderSpec: { col: string; asc: boolean } | null = null;
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
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderSpec = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matching(): Row[] {
    return (this.db[this.table] ?? []).filter((row) =>
      this.filters.every((f) => {
        const value = row[f.col];
        switch (f.op) {
          case "eq":
            return value === f.val;
          case "is":
            return f.val === null ? value == null : value === f.val;
          case "gte":
            return String(value) >= String(f.val);
          case "in":
            return Array.isArray(f.val) && f.val.includes(value);
          default:
            return true;
        }
      }),
    );
  }

  private execute(): { data: unknown; error: null } {
    if (this.op === "insert") {
      // UUID-shaped synthetic ids (several schemas validate them)
      // + the DB defaults the real tables carry.
      const n = (this.db[this.table] ?? []).length + 1;
      const defaults: Record<string, Row> = {
        vehicle_defects: { status: "open", follow_up_count: 0 },
      };
      const row = {
        id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        ...(defaults[this.table] ?? {}),
        ...this.payload,
      };
      (this.db[this.table] ??= []).push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      for (const row of this.matching()) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    let rows = this.matching();
    if (this.orderSpec) {
      const { col, asc } = this.orderSpec;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
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
        current_mileage: 514_700,
        current_mileage_source: "owner_said",
        current_mileage_at: "2026-11-02T08:00:00Z",
        deleted_at: null,
      },
    ],
    trailers: [],
    maintenance_schedules: [
      {
        id: SCHEDULE_ID,
        company_id: COMPANY,
        truck_id: TRUCK_ID,
        trailer_id: null,
        description: "Engine oil & filter",
        interval_miles: 15_000,
        interval_days: 180,
        last_done_date: "2026-08-01",
        last_done_mileage: 500_000,
        status: "active",
        template_key: "engine_oil",
        origin: "template",
        last_reminded_at: null,
        last_reminder_key: null,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
        deleted_at: null,
      },
    ],
    maintenance_events: [],
    pretrip_inspections: [],
    vehicle_defects: [],
    bot_pending_actions: [],
    bot_memories: [],
  };
  const client = { from: (table: string) => new FakeQuery(db, table) };
  const store = createBotStore(client as unknown as SupabaseClient, COMPANY, "telegram");
  return { db, store };
}

function pending(db: Record<string, Row[]>) {
  return (db.bot_pending_actions ?? []).map((r) => ({
    tool: r.tool_name as string,
    args: r.arguments as Row,
    item: r.item_number as number | null,
  }));
}

describe("§5.4 pairing — acceptance C1", () => {
  it("an oil-change proposal becomes a batch of exactly two: the event and the schedule completion", async () => {
    const { store } = fakeWorld();
    const proposals: ProposedWrite[] = [
      {
        tool: "create_maintenance_event",
        args: {
          truck_id: TRUCK_ID,
          description: "Oil change at the TA in Jacksonville",
          service_date: "2026-11-02",
          mileage_at_service: 514_700,
          template_key: "engine_oil",
        },
        summary: "Maintenance: Oil change at the TA in Jacksonville on 2026-11-02",
      },
    ];
    const expanded = await expandMaintenancePairings(store, proposals);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]!.tool).toBe("create_maintenance_event");
    expect(expanded[1]!.tool).toBe("complete_maintenance_schedule");
    expect(expanded[1]!.args).toMatchObject({
      schedule_id: SCHEDULE_ID,
      done_date: "2026-11-02",
      done_mileage: 514_700,
    });
    expect(expanded[0]!.batchId).toBeTruthy();
    expect(expanded[1]!.batchId).toBe(expanded[0]!.batchId);
    expect(expanded[1]!.confidence).toBe("high");
  });

  it("without a template_key, the pairing is a labeled guess from the description", async () => {
    const { store } = fakeWorld();
    const proposals: ProposedWrite[] = [
      {
        tool: "create_maintenance_event",
        args: {
          truck_id: TRUCK_ID,
          description: "Oil change done",
          service_date: "2026-11-02",
        },
        summary: "Maintenance: Oil change done on 2026-11-02",
      },
    ];
    const expanded = await expandMaintenancePairings(store, proposals);
    expect(expanded).toHaveLength(2);
    expect(expanded[1]!.confidence).toBe("medium");
    expect(expanded[1]!.sourceQuote).toContain("guess");
  });

  it("work that matches no library entry stands alone - no stretched pairing", async () => {
    const { store } = fakeWorld();
    const proposals: ProposedWrite[] = [
      {
        tool: "create_maintenance_event",
        args: { truck_id: TRUCK_ID, description: "Alternator replaced", service_date: "2026-11-02" },
        summary: "Maintenance: Alternator replaced on 2026-11-02",
      },
    ];
    const expanded = await expandMaintenancePairings(store, proposals);
    expect(expanded).toHaveLength(1);
  });

  it("approving the pair lands both: the schedule's last-done advances to the event", async () => {
    const { db, store } = fakeWorld();
    await executeWriteTool(store, "create_maintenance_event", {
      truck_id: TRUCK_ID,
      description: "Oil change at the TA in Jacksonville",
      service_date: "2026-11-02",
      mileage_at_service: 514_700,
      template_key: "engine_oil",
    });
    await executeWriteTool(store, "complete_maintenance_schedule", {
      schedule_id: SCHEDULE_ID,
      done_date: "2026-11-02",
      done_mileage: 514_700,
    });
    const schedule = db.maintenance_schedules![0]!;
    expect(schedule.last_done_date).toBe("2026-11-02");
    expect(schedule.last_done_mileage).toBe(514_700);
  });
});

describe("§5.5 defects — acceptance C2 / C3", () => {
  it("a failed pre-trip stages one defect per distinct problem; a passed one stages none (C2/C3)", async () => {
    const { db, store } = fakeWorld();
    await executeWriteTool(store, "log_pretrip_inspection", {
      truck_id: TRUCK_ID,
      passed: true,
    });
    expect(pending(db)).toHaveLength(0);

    const out = await executeWriteTool(store, "log_pretrip_inspection", {
      truck_id: TRUCK_ID,
      passed: false,
      defects_found: "Steer tire cut on the sidewall; mirror cracked",
    });
    expect(out).toContain("staged 2 defects");
    const stagedDefects = pending(db).filter((p) => p.tool === "create_vehicle_defect");
    expect(stagedDefects).toHaveLength(2);
    expect(stagedDefects.map((d) => d.args.description)).toEqual([
      "Steer tire cut on the sidewall",
      "mirror cracked",
    ]);
    expect(stagedDefects[0]!.args.source_inspection_id).toBeTruthy();
  });

  it("the lifecycle: staged defects land on approval, an event suggests closure, dismissal is honored (C2)", async () => {
    const { db, store } = fakeWorld();
    // Land one defect directly (as an approved proposal would).
    await executeWriteTool(store, "create_vehicle_defect", {
      truck_id: TRUCK_ID,
      description: "Steer tire cut on the sidewall",
      source: "pretrip",
    });
    const defect = db.vehicle_defects![0]!;
    expect(defect.status).toBe("open");

    // Work that sounds like the fix names the closure suggestion.
    const eventOut = await executeWriteTool(store, "create_maintenance_event", {
      truck_id: TRUCK_ID,
      description: "Replaced the steer tire",
      service_date: "2026-11-02",
    });
    expect(eventOut).toContain("Steer tire cut on the sidewall");
    // ...but the defect is still open - closure is its own approval.
    expect(db.vehicle_defects![0]!.status).toBe("open");

    const event = db.maintenance_events![0]!;
    await executeWriteTool(store, "resolve_vehicle_defect", {
      defect_id: String(defect.id),
      status: "closed",
      maintenance_event_id: String(event.id),
    });
    expect(db.vehicle_defects![0]!.status).toBe("closed");
    expect(db.vehicle_defects![0]!.maintenance_event_id).toBe(event.id);
  });
});

describe("§5.2 the pack — proposed once, last-done never invented", () => {
  it("stages every missing template with origin template and NO last-done", async () => {
    const { db, store } = fakeWorld();
    // Remove the seeded oil schedule so the full pack is missing.
    db.maintenance_schedules = [];
    const outcome = await stageMaintenancePack(store, TRUCK_ID);
    expect(outcome.staged).toBe(11);
    const items = pending(db).filter((p) => p.tool === "create_maintenance_schedule");
    expect(items).toHaveLength(11);
    for (const item of items) {
      expect(item.args.origin).toBe("template");
      expect(item.args.template_key).toBeTruthy();
      expect(item.args.last_done_date).toBeUndefined();
      expect(item.args.last_done_mileage).toBeUndefined();
    }
    expect(outcome.text).toContain("typical manufacturer/fleet starting points");
    expect(outcome.text).toContain("not inventing a history");
  });

  it("never proposes twice: the marker blocks a second staging", async () => {
    const { db, store } = fakeWorld();
    db.maintenance_schedules = [];
    await stageMaintenancePack(store, TRUCK_ID);
    const second = await stageMaintenancePack(store, TRUCK_ID);
    expect(second.staged).toBe(0);
    expect(second.text).toContain("already proposed");
  });

  it("a truck with the full pack tracked gets nothing new", async () => {
    const { db, store } = fakeWorld();
    db.maintenance_schedules = [
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `sched-${i}`,
        company_id: COMPANY,
        truck_id: TRUCK_ID,
        trailer_id: null,
        description: `Schedule ${i}`,
        template_key: [
          "engine_oil", "fuel_filters", "chassis_lube", "brake_inspection", "air_filter",
          "tire_inspection", "coolant_test", "belt_hose_inspect", "dot_annual", "dpf_service",
          "trans_diff_fluid",
        ][i],
        deleted_at: null,
      })),
    ];
    const outcome = await stageMaintenancePack(store, TRUCK_ID);
    expect(outcome.staged).toBe(0);
    expect(outcome.text).toContain("already has the full standard maintenance pack");
  });
});

describe("§4.5/R-6 — the pre-trip photo settle", () => {
  it("marks a queued pretrip_photo research request fulfilled, and never completes the inspection itself", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const request = {
      id: "req-1",
      company_id: COMPANY,
      kind: "pretrip_photo",
      status: "queued",
      created_at: "2026-11-02T07:00:00Z",
    };
    const updates: { table: string; values: Row }[] = [];
    const client = {
      from: (table: string) => {
        if (table === "documents") {
          return {
            update: (values: Row) => {
              updates.push({ table, values });
              return { eq: () => ({ eq: async () => ({ error: null }) }) };
            },
          };
        }
        if (table === "research_requests") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({
                      limit: async () => ({ data: [request], error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: (values: Row) => {
              updates.push({ table, values });
              Object.assign(request, values);
              return { eq: () => ({ eq: async () => ({ error: null }) }) };
            },
          };
        }
        if (table === "pretrip_inspections") {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  gte: () => ({
                    order: () => ({ limit: async () => ({ data: [], error: null }) }),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    const brainStore = {
      client: client as unknown as SupabaseClient,
      companyId: COMPANY,
      channel: "telegram",
    } as unknown as BotBrainStore;
    const result = await settlePhotoPurpose(
      { client: client as unknown as SupabaseClient, companyId: COMPANY, brainStore },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "pretrip",
        source: "vision",
        confidence: 0.9,
        headline: "Walk-around photo of the steer tire.",
        fields: {},
      },
    );
    expect(request.status).toBe("fulfilled");
    expect(request).toHaveProperty("fulfilled_at");
    // The skip-is-first-class line: the photo completes nothing.
    expect(result.reply).toContain("pre-trip passed");
    expect(result.reply).toContain("doesn't pass or fail anything");
  });

  it("with no queued request, the settle is identical minus the stamp (C5)", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const client = {
      from: (table: string) => {
        if (table === "documents") {
          return {
            update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          };
        }
        if (table === "research_requests") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    order: () => ({ limit: async () => ({ data: [], error: null }) }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "pretrip_inspections") {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  gte: () => ({
                    order: () => ({ limit: async () => ({ data: [], error: null }) }),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    const brainStore = {
      client: client as unknown as SupabaseClient,
      companyId: COMPANY,
      channel: "telegram",
    } as unknown as BotBrainStore;
    const result = await settlePhotoPurpose(
      { client: client as unknown as SupabaseClient, companyId: COMPANY, brainStore },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "pretrip",
        source: "vision",
        confidence: 0.9,
        fields: {},
      },
    );
    expect(result.reply).toContain("marked as a pre-trip photo");
  });
});

describe("§5.7 the outlook — one computation, honest buckets", () => {
  it("sorts schedules into overdue / unknown and names mileage provenance + open defects", async () => {
    const { db, store } = fakeWorld();
    // The seeded oil schedule: last done 500,000 mi / 2026-08-01,
    // truck now at 514,700 → due by mileage (515,000) within 1,000 → due-soon.
    db.maintenance_schedules!.push({
      id: "sched-unknown",
      company_id: COMPANY,
      truck_id: TRUCK_ID,
      trailer_id: null,
      description: "DOT annual inspection",
      interval_miles: null,
      interval_days: 365,
      last_done_date: null,
      last_done_mileage: null,
      status: "active",
      template_key: "dot_annual",
      origin: "template",
      last_reminded_at: null,
      last_reminder_key: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
    });
    db.vehicle_defects!.push({
      id: "defect-1",
      company_id: COMPANY,
      truck_id: TRUCK_ID,
      trailer_id: null,
      description: "Mirror cracked",
      source: "pretrip",
      status: "open",
      created_at: "2026-11-01T00:00:00Z",
      deleted_at: null,
    });
    const outlook = await computeMaintenanceOutlook(store.client, COMPANY, new Date("2026-11-02T12:00:00Z"));
    const text = formatMaintenanceOutlook(outlook);
    expect(text).toContain("Due soon: Engine oil & filter on truck 214");
    expect(text).toContain("Unknown: DOT annual inspection on truck 214");
    expect(text).toContain("no last-done on record");
    expect(text).toContain("514,700 mi");
    expect(text).toContain("Open defects (1)");
    expect(text).toContain("Mirror cracked");
  });
});
