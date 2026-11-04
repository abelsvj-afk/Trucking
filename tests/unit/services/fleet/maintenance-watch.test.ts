// The maintenance watcher (Image Intelligence §5.6): reminder
// dedupe is STATE (D1), quiet hours hold the routine digest and
// release it after 6 AM ET (D2), the DOT annual at 7 days is
// urgent even in quiet hours (D3), the advisory lock makes
// concurrent passes collapse to one (D4), and the capability
// switch silences the whole watch (D5).

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore } from "@/services/bot/store";
import {
  evaluateMaintenanceWatch,
  runMaintenanceWatchIfDue,
} from "@/services/fleet/maintenance-watch";

const COMPANY = "company-1";
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const OIL_ID = "17171717-1717-4717-8717-171717171717";
const DOT_ID = "18181818-1818-4818-8818-181818181818";

// 9:00 AM Eastern (EST) - outside quiet hours, not driving.
const MORNING = new Date("2026-11-02T14:00:00Z");
// 3:30 AM Eastern - inside the research lane's quiet hours.
const QUIET = new Date("2026-11-02T08:30:00Z");

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
      const row = { id: `run-${(this.db[this.table] ?? []).length + 1}`, ...this.payload };
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

function scheduleRow(overrides: Row): Row {
  return {
    company_id: COMPANY,
    truck_id: TRUCK_ID,
    trailer_id: null,
    interval_miles: null,
    interval_days: null,
    last_done_date: null,
    last_done_mileage: null,
    status: "active",
    template_key: null,
    origin: "template",
    last_reminded_at: null,
    last_reminder_key: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function fakeWorld(schedules: Row[], extra: { defects?: Row[]; mileageAt?: string } = {}) {
  const db: Record<string, Row[]> = {
    trucks: [
      {
        id: TRUCK_ID,
        company_id: COMPANY,
        unit_number: "214",
        status: "active",
        current_mileage: 514_700,
        current_mileage_source: "owner_said",
        current_mileage_at: extra.mileageAt ?? "2026-11-02T08:00:00Z",
        deleted_at: null,
      },
    ],
    trailers: [],
    maintenance_schedules: schedules,
    vehicle_defects: extra.defects ?? [],
    duty_logs: [],
    maintenance_watch_runs: [],
  };
  const client = { from: (table: string) => new FakeQuery(db, table) };
  const store = {
    client: client as unknown as SupabaseClient,
    companyId: COMPANY,
    channel: "telegram",
    isMaintenanceWatchEnabled: vi.fn().mockResolvedValue(true),
  } as unknown as BotBrainStore;
  const notify = vi.fn().mockResolvedValue(true);
  return { db, store, notify };
}

const DUE_SOON_OIL = () =>
  scheduleRow({
    id: OIL_ID,
    description: "Engine oil & filter",
    interval_miles: 15_000,
    interval_days: 180,
    last_done_date: "2026-08-01",
    last_done_mileage: 500_000,
    template_key: "engine_oil",
  });

describe("evaluateMaintenanceWatch — the §5.6 policy", () => {
  it("D1: a due-soon item digests exactly once - the reminder key is the dedupe", async () => {
    const { db, store, notify } = fakeWorld([DUE_SOON_OIL()]);
    const first = await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(first.digestSent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("Engine oil & filter");
    expect(db.maintenance_schedules![0]!.last_reminder_key).toContain("|due_soon|1");

    const second = await evaluateMaintenanceWatch({
      store,
      notify,
      now: new Date(MORNING.getTime() + 60 * 60 * 1000),
    });
    expect(second.digestSent).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    // Both passes recorded their run rows (the due-check's clock).
    expect(db.maintenance_watch_runs).toHaveLength(2);
  });

  it("D2: a quiet-hours pass sends nothing and stamps nothing; the digest flushes after 6 AM ET", async () => {
    const { db, store, notify } = fakeWorld([DUE_SOON_OIL()]);
    const held = await evaluateMaintenanceWatch({ store, notify, now: QUIET });
    expect(held.digestSent).toBe(false);
    expect(held.routineHeld).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    expect(db.maintenance_schedules![0]!.last_reminder_key).toBeNull();

    const flushed = await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(flushed.digestSent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("D3: the DOT annual at 7 days sends immediately, even in quiet hours, once", async () => {
    const dot = scheduleRow({
      id: DOT_ID,
      description: "DOT annual inspection",
      interval_days: 365,
      // Due 2026-11-09 - exactly 7 days after Nov 2.
      last_done_date: "2025-11-09",
      template_key: "dot_annual",
    });
    const { db, store, notify } = fakeWorld([dot]);
    const first = await evaluateMaintenanceWatch({ store, notify, now: QUIET });
    expect(first.urgentSent).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("DOT annual inspection");
    expect(notify.mock.calls[0]![0]).toContain("7 days");
    expect(db.maintenance_schedules![0]!.last_reminder_key).toContain("|dot_7|1");

    const second = await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(second.urgentSent).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an overdue routine item refires weekly, not daily", async () => {
    const overdueOil = scheduleRow({
      id: OIL_ID,
      description: "Engine oil & filter",
      interval_miles: 15_000,
      last_done_date: "2026-05-01",
      last_done_mileage: 480_000,
      template_key: "engine_oil",
    });
    const { db, store, notify } = fakeWorld([overdueOil]);
    await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.maintenance_schedules![0]!.last_reminder_key).toContain("|overdue|1");

    const nextDay = new Date("2026-11-03T14:00:00Z");
    await evaluateMaintenanceWatch({ store, notify, now: nextDay });
    expect(notify).toHaveBeenCalledTimes(1);

    const nextWeek = new Date("2026-11-09T14:00:00Z");
    await evaluateMaintenanceWatch({ store, notify, now: nextWeek });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(db.maintenance_schedules![0]!.last_reminder_key).toContain("|overdue|2");
  });

  it("a defect gets its day-3 follow-up in the digest, then weekly - and the stamp lands on the defect", async () => {
    const defect = {
      id: "defect-1",
      company_id: COMPANY,
      truck_id: TRUCK_ID,
      trailer_id: null,
      description: "Mirror cracked",
      source: "pretrip",
      status: "open",
      follow_up_count: 0,
      last_follow_up_at: null,
      created_at: "2026-10-29T10:00:00Z",
      deleted_at: null,
    };
    const { db, store, notify } = fakeWorld([], { defects: [defect] });
    const out = await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(out.digestSent).toBe(true);
    expect(notify.mock.calls[0]![0]).toContain("Mirror cracked");
    expect(db.vehicle_defects![0]!.follow_up_count).toBe(1);
    expect(db.vehicle_defects![0]!.last_follow_up_at).not.toBeNull();

    await evaluateMaintenanceWatch({
      store,
      notify,
      now: new Date("2026-11-04T14:00:00Z"),
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an unknown schedule is folded into one digest and never asked again", async () => {
    const unknown = scheduleRow({
      id: OIL_ID,
      description: "Engine oil & filter",
      interval_miles: 15_000,
      interval_days: 180,
      template_key: "engine_oil",
    });
    const { store, notify } = fakeWorld([unknown]);
    await evaluateMaintenanceWatch({ store, notify, now: MORNING });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("no last-done on record");

    await evaluateMaintenanceWatch({
      store,
      notify,
      now: new Date("2026-11-05T14:00:00Z"),
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("runMaintenanceWatchIfDue — the due-check shell", () => {
  it("D4: when the advisory lock is held elsewhere, the pass sends nothing and records nothing", async () => {
    const { db, store, notify } = fakeWorld([DUE_SOON_OIL()]);
    await runMaintenanceWatchIfDue({
      store,
      notify,
      now: MORNING,
      acquireLock: async () => null,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(db.maintenance_watch_runs).toHaveLength(0);
  });

  it("D5: capability off - no sends, no run row (answers still work elsewhere)", async () => {
    const { db, store, notify } = fakeWorld([DUE_SOON_OIL()]);
    (store.isMaintenanceWatchEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await runMaintenanceWatchIfDue({
      store,
      notify,
      now: MORNING,
      acquireLock: async () => ({ release: async () => {} }),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(db.maintenance_watch_runs).toHaveLength(0);
  });

  it("the ~6h due-check: a fresh run row suppresses the next pass", async () => {
    const { db, store, notify } = fakeWorld([DUE_SOON_OIL()]);
    db.maintenance_watch_runs!.push({
      id: "run-recent",
      company_id: COMPANY,
      ran_at: new Date(MORNING.getTime() - 60 * 60 * 1000).toISOString(),
      reminders_sent: 0,
      detail: {},
    });
    await runMaintenanceWatchIfDue({
      store,
      notify,
      now: MORNING,
      acquireLock: async () => ({ release: async () => {} }),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(db.maintenance_watch_runs).toHaveLength(1);
  });
});
