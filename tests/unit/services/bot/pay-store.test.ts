// Phase D acceptance (design §5, test 1 + store discipline): a
// settlement recorded against a pin gets code-computed true-pay
// columns and a pin check at record time; before migration 00045
// the WRITE fails with a plain "not applied" message while reads
// degrade to empty; the weekly report job delivers once per week
// and closes empty weeks silently.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { runWeeklyPayReportIfDue } from "@/services/bot/pay-report-scheduler";
import { formatPayPin, UNKNOWN_PIN, type PayPin } from "@/services/bot/pay-pin";

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq":
        return value === f.val;
      case "is":
        return f.val === null ? value === null || value === undefined : value === f.val;
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      case "gte":
        return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
      case "lte":
        return typeof value === "string" && typeof f.val === "string" ? value <= f.val : Number(value) <= Number(f.val);
      case "ilike": {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        return typeof value === "string" && value.toLowerCase().includes(needle);
      }
      default:
        return true;
    }
  });
}

class FakeQuery {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private conflictKeys: string[] = [];
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private db: Record<string, Row[]>,
    private missing: Set<string>,
    private table: string,
    private stamp: () => string,
  ) {}

  select() { return this; }
  insert(payload: Row | Row[]) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = payload;
    this.conflictKeys = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return this;
  }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ op: "lte", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  or() { return this; } // duty-log range filter: the store clips segments in code, so returning all rows is safe here
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private missingError() {
    return {
      data: null,
      error: { message: `relation "public.${this.table}" does not exist`, code: "42P01" },
      count: null,
    };
  }

  private execute(single: boolean, maybe: boolean) {
    if (this.missing.has(this.table)) return this.missingError();
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert" || this.op === "upsert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted: Row[] = [];
      for (const payload of payloads) {
        if (this.op === "upsert" && this.conflictKeys.length > 0) {
          const existing = rows.find((r) => this.conflictKeys.every((k) => r[k] === payload[k]));
          if (existing) {
            Object.assign(existing, payload);
            inserted.push(existing);
            continue;
          }
        }
        const row: Row = {
          id: `row-${this.table}-${rows.length + 1}`,
          created_at: this.stamp(),
          valid_to: null,
          deleted_at: null,
          ...payload,
        };
        rows.push(row);
        inserted.push(row);
      }
      return { data: single || maybe ? inserted[0] ?? null : inserted, error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
      return { data: null, error: null, count: null };
    }
    let matched = rows.filter((row) => matches(row, this.filters));
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
        : { data: null, error: { message: "no rows" }, count: null };
    }
    if (maybe) return { data: matched[0] ?? null, error: null, count: null };
    return { data: matched, error: null, count: matched.length };
  }
  single() { return Promise.resolve(this.execute(true, false)); }
  maybeSingle() { return Promise.resolve(this.execute(false, true)); }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute(false, false)).then(onfulfilled, onrejected);
  }
}

const COMPANY = "company-1";
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 10, 2, 0, 0, tick++)).toISOString();

function fakeStore(db: Record<string, Row[]>, missing: Set<string> = new Set()): BotBrainStore {
  const client = {
    from: (table: string) => new FakeQuery(db, missing, table, stamp),
    rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
  } as unknown as SupabaseClient;
  return createBotStore(client, COMPANY, "telegram");
}

const PIN: PayPin = {
  model: "percentage_gross",
  rate: 30,
  employment: "1099",
  fuelPaidBy: "owner",
  tollsPaidBy: "driver",
  settlementDay: "Friday",
  taxSetasidePercent: 25,
  source: "test pin",
  pinnedAt: "2026-11-01",
};

function seedPin(db: Record<string, Row[]>) {
  (db.bot_memories ??= []).push({
    id: "mem-pin",
    company_id: COMPANY,
    kind: "business_fact",
    content: formatPayPin(PIN),
    created_at: "2026-11-01T00:00:00.000Z",
    valid_to: null,
    deleted_at: null,
  });
}

function seedCapabilities(db: Record<string, Row[]>) {
  (db.companies ??= []).push({ id: COMPANY, ai_globally_disabled: false });
  (db.ai_capability_settings ??= []).push({ company_id: COMPANY, capability: "bot_chat", enabled: true });
}

const SETTLEMENT_INPUT = {
  issuerName: "Steven's carrier",
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  grossCents: 400_000,
  carrierCutCents: 280_000,
  netToTruckCents: 120_000,
  driverPayCents: 120_000,
  milesTotal: 2_400,
  milesLoaded: 2_000,
  dutyMinutes: 3_000,
  sourceDocumentId: null,
  notes: null,
  lines: [
    { kind: "load_pay" as const, label: "DAL → ATL", amountCents: 120_000, loadId: "load-1" },
    { kind: "tolls" as const, label: "Tolls", amountCents: -4_200, loadId: null },
  ],
};

describe("pay pin through the store", () => {
  it("no pin memory -> the explicit UNKNOWN pin, never a guess", async () => {
    const store = fakeStore({});
    expect(await store.loadPayPin()).toEqual(UNKNOWN_PIN);
  });

  it("a pinned business_fact round-trips through loadPayPin", async () => {
    const db: Record<string, Row[]> = {};
    seedPin(db);
    const store = fakeStore(db);
    expect(await store.loadPayPin()).toEqual(PIN);
  });
});

describe("recordSettlement", () => {
  it("computes true pay + pin check in code and stores header, lines, and the load link", async () => {
    const db: Record<string, Row[]> = {};
    seedPin(db);
    const store = fakeStore(db);
    const recorded = await store.recordSettlement(SETTLEMENT_INPUT);
    expect(recorded.pinCheck).toBe("fits");
    expect(recorded.truePayLines.join("\n")).toContain("Tax set-aside at 25%");
    expect(recorded.truePayLines.join("\n")).toContain("$300.00");

    const header = (db.settlements ?? [])[0]!;
    expect(header.tax_setaside_cents).toBe(30_000);
    expect(header.spendable_cents).toBe(90_000);
    expect(header.pin_check).toBe("fits");
    expect((db.settlement_lines ?? []).length).toBe(2);
    const links = db.settlement_load_links ?? [];
    expect(links.length).toBe(1);
    expect(links[0]!.load_id).toBe("load-1");
  });

  it("a settlement that contradicts the pin stores a mismatch with both figures in the detail", async () => {
    const db: Record<string, Row[]> = {};
    seedPin(db);
    const store = fakeStore(db);
    const recorded = await store.recordSettlement({ ...SETTLEMENT_INPUT, driverPayCents: 100_000 });
    expect(recorded.pinCheck).toBe("mismatch");
    expect(recorded.pinCheckDetail).toContain("$1200.00");
    expect(recorded.pinCheckDetail).toContain("$1000.00");
  });

  it("unpinned: the settlement still records, checked as unpinned - nothing invented", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    const recorded = await store.recordSettlement(SETTLEMENT_INPUT);
    expect(recorded.pinCheck).toBe("unpinned");
    expect((db.settlements ?? [])[0]!.tax_setaside_cents).toBeNull(); // employment unknown - no set-aside computed, none invented
  });

  it("before migration 00045 the WRITE fails plainly; reads degrade to empty", async () => {
    const missing = new Set(["settlements", "settlement_lines", "settlement_load_links", "pay_report_runs"]);
    const store = fakeStore({}, missing);
    await expect(store.recordSettlement(SETTLEMENT_INPUT)).rejects.toThrow(/migration 00045/);
    expect(await store.listSettlements(5)).toEqual([]);
    expect(await store.listSettlementsInRange("2026-10-26", "2026-11-01")).toEqual([]);
    expect(await store.payReportRunForWeek("2026-10-26")).toBeNull();
  });
});

describe("weekly pay report job", () => {
  const NOW = new Date("2026-11-02T12:00:00.000Z"); // a Monday - last completed week is 2026-10-26..2026-11-01
  const unlock = { release: async () => {} };

  it("delivers the report once for the completed week, then stays done", async () => {
    const db: Record<string, Row[]> = {};
    seedCapabilities(db);
    seedPin(db);
    const store = fakeStore(db);
    await store.recordSettlement(SETTLEMENT_INPUT);
    const sent: string[] = [];
    const deps = {
      store,
      acquireLock: async () => unlock,
      notify: async (text: string) => { sent.push(text); return true; },
      now: () => NOW,
    };
    await runWeeklyPayReportIfDue(deps);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Weekly pay truth");
    const run = await store.payReportRunForWeek("2026-10-26");
    expect(run?.sent).toBe(true);
    await runWeeklyPayReportIfDue(deps);
    expect(sent.length).toBe(1); // no double-send
  });

  it("an empty week past the close window closes silently (no nag, run recorded)", async () => {
    const db: Record<string, Row[]> = {};
    seedCapabilities(db);
    const store = fakeStore(db);
    const sent: string[] = [];
    // 2026-11-15: scan covers weeks of 2026-10-26 (ended 11-01, 14
    // days past - closes) and 2026-11-02 (ended 11-08, 7 days past -
    // still open for a late settlement photo).
    await runWeeklyPayReportIfDue({
      store,
      acquireLock: async () => unlock,
      notify: async (text: string) => { sent.push(text); return true; },
      now: () => new Date("2026-11-15T12:00:00.000Z"),
    });
    expect(sent.length).toBe(0);
    const closed = await store.payReportRunForWeek("2026-10-26");
    expect(closed?.closedEmpty).toBe(true);
    expect(closed?.sent).toBe(false);
    expect(await store.payReportRunForWeek("2026-11-02")).toBeNull();
  });

  it("bot_chat off -> the job does nothing at all", async () => {
    const db: Record<string, Row[]> = {};
    (db.companies ??= []).push({ id: COMPANY, ai_globally_disabled: false });
    const store = fakeStore(db);
    const notify = vi.fn(async () => true);
    await runWeeklyPayReportIfDue({ store, acquireLock: async () => unlock, notify, now: () => NOW });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("UH-06: weekly pay report honors the delivery gate", () => {
  const unlock = { release: async () => {} };
  it("held during quiet hours: no send, no run recorded; released on the next sendable tick", async () => {
    const db: Record<string, Row[]> = {};
    seedCapabilities(db);
    seedPin(db);
    const store = fakeStore(db);
    await store.recordSettlement(SETTLEMENT_INPUT);
    const sent: string[] = [];
    const notify = async (text: string) => { sent.push(text); return true; };
    // Tick 1: gate holds (quiet hours) -> nothing sent, week still due.
    await runWeeklyPayReportIfDue({
      store, acquireLock: async () => unlock, notify,
      now: () => new Date("2026-11-02T12:00:00.000Z"),
      deliveryGate: async () => ({ sendNow: false, heldUntil: new Date("2026-11-02T11:00:00.000Z"), reason: "quiet hours" }),
    });
    expect(sent.length).toBe(0);
    expect(await store.payReportRunForWeek("2026-10-26")).toBeNull();
    // Tick 2: gate releases -> the same week's report goes out, once.
    await runWeeklyPayReportIfDue({
      store, acquireLock: async () => unlock, notify,
      now: () => new Date("2026-11-02T12:00:00.000Z"),
      deliveryGate: async () => ({ sendNow: true, heldUntil: null, reason: null }),
    });
    expect(sent.length).toBe(1);
    expect((await store.payReportRunForWeek("2026-10-26"))?.sent).toBe(true);
  });
});
