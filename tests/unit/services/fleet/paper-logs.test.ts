// Paper-log staging (Image Intelligence §7): E4 (a paper day
// overlapping app rows stages a paper-wins conflict proposal -
// approving is the delete tool + paper rows; nothing is silently
// overwritten), E5 (a 5-day-late sheet re-computes the 8-day
// totals and the reply names the 70-hour change), E6 (editing a
// paper-sourced row carries the re-mark line), the document's
// partial stamp (E2 at the pipeline level), provenance labeling,
// and the photo settle wiring that replaced "not read yet".

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore } from "@/services/bot/store";
import {
  PAPER_REMARK_LINE,
  annotatePaperLogEdits,
  hosProvenanceLines,
  stagePaperLogDay,
} from "@/services/fleet/paper-logs";
import { settlePhotoPurpose } from "@/services/telegram/photo-purpose";
import type { PaperLogExtraction } from "@/services/ai/paper-log-extraction";

const COMPANY = "company-1";
const DOC_ID = "19191919-1919-4919-8919-191919191919";

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
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: "lt", col, val });
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
        const value = row[f.col] as string;
        switch (f.op) {
          case "eq":
            return value === f.val;
          case "is":
            return f.val === null ? value == null : value === f.val;
          case "in":
            return Array.isArray(f.val) && f.val.includes(value);
          case "gte":
            return value >= (f.val as string);
          case "lt":
            return value < (f.val as string);
          default:
            return true;
        }
      }),
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
    if (this.orderSpec) {
      const { col, asc } = this.orderSpec;
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return { data: rows, error: null };
  }

  async single() {
    const out = this.execute();
    const rows = out.data as Row[];
    return { data: Array.isArray(rows) ? (rows[0] ?? null) : out.data, error: null };
  }
  async maybeSingle() {
    return this.single();
  }
  then<TResult>(resolve: (v: { data: unknown; error: null }) => TResult) {
    return Promise.resolve(this.execute()).then(resolve);
  }
}

interface SavedAction {
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  batchId?: string;
  itemNumber?: number;
  confidence?: number | null;
}

function fakeStore(db: Record<string, Row[]>) {
  const saved: SavedAction[] = [];
  const client = { from: (table: string) => new FakeQuery(db, table) };
  const store = {
    client: client as unknown as SupabaseClient,
    companyId: COMPANY,
    channel: "telegram",
    savePendingAction: vi.fn(async (action: SavedAction) => {
      saved.push(action);
    }),
  } as unknown as BotBrainStore;
  return { store, saved, client: client as unknown as SupabaseClient };
}

const CLEAN_DAY: PaperLogExtraction = {
  log_date: "2026-10-27",
  driver_name: "S. Smith",
  carrier_name: null,
  truck_number: "214",
  trailer_number: null,
  segments: [
    { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
    { status: "on_duty", start: "06:00", end: "06:15", confidence: 0.98 },
    { status: "driving", start: "06:15", end: "12:00", confidence: 0.99 },
    { status: "on_duty", start: "12:00", end: "12:30", confidence: 0.97 },
    { status: "driving", start: "12:30", end: "17:30", confidence: 0.98 },
    { status: "off_duty", start: "17:30", end: "24:00", confidence: 0.99 },
  ],
  totals: { off_duty: 12.5, sleeper: null, driving: 10.75, on_duty: 0.75 },
  remarks: null,
  shipping_info: null,
  odometer_start: null,
  odometer_end: null,
  total_miles: null,
  unreadable: [],
};

function baseDb(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    documents: [
      { id: DOC_ID, company_id: COMPANY, file_name: "log.jpg", extracted_fields: { keep: "me" } },
    ],
    duty_logs: [],
    loads: [],
    trucks: [],
    ...extra,
  };
}

describe("stagePaperLogDay", () => {
  it("E1 at the pipeline level: a clean day stages six paper rows in one batch and stamps the document complete", async () => {
    const db = baseDb();
    const { store, saved } = fakeStore(db);
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: CLEAN_DAY });
    const text = lines.join("\n");
    expect(text).toContain("Read your paper log for");
    expect(text).toContain("driving 10.75h");
    const logs = saved.filter((a) => a.toolName === "log_duty_status");
    expect(logs).toHaveLength(6);
    expect(logs.every((a) => a.args.source === "paper_photo")).toBe(true);
    expect(logs.every((a) => a.args.source_document_id === DOC_ID)).toBe(true);
    expect(new Set(logs.map((a) => a.batchId)).size).toBe(1);
    // Midnight ET = 04:00Z (EDT): the first segment starts there.
    expect(logs[0]!.args.started_at).toBe("2026-10-27T04:00:00.000Z");
    const doc = db.documents![0]!;
    expect((doc.extracted_fields as Row).paper_log_complete).toBe(true);
    expect((doc.extracted_fields as Row).paper_log_date).toBe("2026-10-27");
    expect((doc.extracted_fields as Row).keep).toBe("me");
  });

  it("E2 at the pipeline level: a blurred span stamps the document partial and the reply names the missing span", async () => {
    const db = baseDb();
    const { store, saved } = fakeStore(db);
    const blurred: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "06:00", end: "15:00", confidence: 0.99 },
        { status: "off_duty", start: "18:30", end: "24:00", confidence: 0.99 },
      ],
      unreadable: [{ description: "grid washed out", start: "15:00", end: "18:30" }],
    };
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: blurred });
    const text = lines.join("\n");
    expect(text).toContain("3 PM");
    expect(text).toContain("6:30 PM");
    expect(text).toContain("missing from what I could read");
    expect(text).toContain("marked partial");
    expect(saved.filter((a) => a.toolName === "log_duty_status")).toHaveLength(3);
    expect((db.documents![0]!.extracted_fields as Row).paper_log_complete).toBe(false);
  });

  it("E4: an overlapping app row stages a paper-wins replace proposal alongside the paper rows - nothing silently overwritten", async () => {
    const db = baseDb({
      duty_logs: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          company_id: COMPANY,
          duty_status: "driving",
          // 9:00 AM ET on the sheet's day - the paper says on-duty then.
          started_at: "2026-10-27T13:00:00.000Z",
          load_id: null,
          location: null,
          notes: null,
          odometer: null,
          source: "app",
          source_document_id: null,
          deleted_at: null,
        },
      ],
    });
    const { store, saved } = fakeStore(db);
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: CLEAN_DAY });
    const deletes = saved.filter((a) => a.toolName === "delete_record");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args).toMatchObject({ entity: "duty_log", record_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(deletes[0]!.summary).toContain("legal record");
    expect(deletes[0]!.itemNumber).toBe(1);
    expect(saved.filter((a) => a.toolName === "log_duty_status")).toHaveLength(6);
    expect(lines.join("\n")).toContain("Paper is your legal record");
    // The app row itself is untouched until his yes executes the batch.
    expect(db.duty_logs![0]!.deleted_at).toBeNull();
  });

  it("E5: a sheet backfilled 5 days late names the carrier-cycle change it makes", async () => {
    const dayMs = 86_400_000;
    const now = Date.now();
    const isoDaysAgo = (days: number, hourUtc: number) =>
      new Date(now - days * dayMs).toISOString().slice(0, 10) + `T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
    const logDate = new Date(now - 5 * dayMs).toISOString().slice(0, 10);
    // He drove every day after the sheet's day (9h a day, ~15h breaks):
    // no 34-hour rest anywhere, so the sheet's driving counts in the cycle.
    const row = (id: string, duty_status: string, days: number, hourUtc: number) => ({
      id, company_id: COMPANY, duty_status, started_at: isoDaysAgo(days, hourUtc),
      load_id: null, location: null, notes: null, odometer: null, source: "app", source_document_id: null, deleted_at: null,
    });
    const db = baseDb({
      duty_logs: [4, 3, 2, 1].flatMap((d) => [row(`d${d}`, "driving", d, 13), row(`o${d}`, "off_duty", d, 22)]),
    });
    const { store } = fakeStore(db);
    const sheet: PaperLogExtraction = {
      ...CLEAN_DAY,
      log_date: logDate,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "06:00", end: "14:00", confidence: 0.99 },
        { status: "off_duty", start: "14:00", end: "24:00", confidence: 0.99 },
      ],
      totals: null,
    };
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: sheet });
    const text = lines.join("\n");
    // Before: 4 x 9h = 36h on duty in the carrier cycle.
    // After: + 8h of paper driving = 44h. The reply names the cycle
    // and says the settings are the provisional defaults.
    expect(text).toContain("70/8 cycle (provisional carrier settings)");
    expect(text).toContain("from 36h to 44h of 70h");
  });

  it("a late sheet behind a verified 34-hour restart does not change the cycle - and says nothing it can't back", async () => {
    const dayMs = 86_400_000;
    const now = Date.now();
    const isoDaysAgo = (days: number, hourUtc: number) =>
      new Date(now - days * dayMs).toISOString().slice(0, 10) + `T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
    const logDate = new Date(now - 5 * dayMs).toISOString().slice(0, 10);
    const db = baseDb({
      duty_logs: [
        { id: "h1", company_id: COMPANY, duty_status: "off_duty", started_at: isoDaysAgo(2, 12), load_id: null, location: null, notes: null, odometer: null, source: "app", source_document_id: null, deleted_at: null },
        { id: "h2", company_id: COMPANY, duty_status: "driving", started_at: isoDaysAgo(2, 13), load_id: null, location: null, notes: null, odometer: null, source: "app", source_document_id: null, deleted_at: null },
        { id: "h3", company_id: COMPANY, duty_status: "off_duty", started_at: isoDaysAgo(2, 22), load_id: null, location: null, notes: null, odometer: null, source: "app", source_document_id: null, deleted_at: null },
      ],
    });
    const { store } = fakeStore(db);
    const sheet: PaperLogExtraction = {
      ...CLEAN_DAY,
      log_date: logDate,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "06:00", end: "14:00", confidence: 0.99 },
        { status: "off_duty", start: "14:00", end: "24:00", confidence: 0.99 },
      ],
      totals: null,
    };
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: sheet });
    // ~2.9 days off between the sheet and the next drive = a 34-hour
    // restart the engine can verify: the sheet's hours sit before it.
    expect(lines.join("\n")).not.toContain("changes your");
  });

  it("naming condition: the approval prompt names every flagged (faint) stretch it would book", async () => {
    const db = baseDb();
    const { store, saved } = fakeStore(db);
    const faint: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "06:00", end: "10:00", confidence: 0.86 },
        { status: "on_duty", start: "10:00", end: "10:30", confidence: 0.82 },
        { status: "off_duty", start: "10:30", end: "24:00", confidence: 0.99 },
      ],
    };
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: faint });
    const prompt = lines.find((l) => l.startsWith("Say yes"))!;
    expect(prompt).toContain("2 faint stretches");
    expect(prompt).toContain("driving 6 AM–10 AM");
    expect(prompt).toContain("on duty (not driving) 10 AM–10:30 AM");
    expect(saved.filter((a) => a.toolName === "log_duty_status")).toHaveLength(4);
  });

  it("naming condition: sub-floor stretches stay dropped and named, never staged; the prompt names no faint ones when there are none", async () => {
    const db = baseDb();
    const { store, saved } = fakeStore(db);
    const low: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "06:00", end: "10:00", confidence: 0.6 },
        { status: "off_duty", start: "10:00", end: "24:00", confidence: 0.99 },
      ],
    };
    const { lines } = await stagePaperLogDay({ store, documentId: DOC_ID, extraction: low });
    const text = lines.join("\n");
    expect(text).toContain("left it out rather than guess");
    expect(saved.filter((a) => a.toolName === "log_duty_status").map((a) => a.args.duty_status)).toEqual(["off_duty", "off_duty"]);
    expect(lines.find((l) => l.startsWith("Say yes"))).not.toContain("faint");
    expect(text).toContain("marked partial");
  });

  it("an undated sheet stages nothing and asks for the date in words", async () => {
    const db = baseDb();
    const { store, saved } = fakeStore(db);
    const { lines } = await stagePaperLogDay({
      store,
      documentId: DOC_ID,
      extraction: { ...CLEAN_DAY, log_date: null },
    });
    expect(saved).toHaveLength(0);
    expect(lines.join("\n")).toContain("date itself wasn't readable");
    expect((db.documents![0]!.extracted_fields as Row).paper_log_complete).toBe(false);
  });
});

describe("annotatePaperLogEdits — E6", () => {
  it("a delete aimed at a paper-sourced row gains the re-mark line; an app row is untouched", async () => {
    const db = baseDb({
      duty_logs: [
        { id: "paper-row", company_id: COMPANY, source: "paper_photo", deleted_at: null },
        { id: "app-row", company_id: COMPANY, source: "app", deleted_at: null },
      ],
    });
    const { store } = fakeStore(db);
    const proposals = [
      { tool: "delete_record", args: { entity: "duty_log", record_id: "paper-row" }, summary: "DELETE duty_log record paper-row" },
      { tool: "delete_record", args: { entity: "duty_log", record_id: "app-row" }, summary: "DELETE duty_log record app-row" },
      { tool: "delete_record", args: { entity: "load", record_id: "paper-row" }, summary: "DELETE load record paper-row" },
    ];
    const out = await annotatePaperLogEdits(store, proposals);
    expect(out[0]!.summary).toContain(PAPER_REMARK_LINE);
    expect(out[1]!.summary).toBe("DELETE duty_log record app-row");
    expect(out[2]!.summary).toBe("DELETE load record paper-row");
  });
});

describe("hosProvenanceLines — §7.7 labeling", () => {
  it("paper rows label the picture; a partial document names its date", async () => {
    const db = baseDb();
    (db.documents![0]!.extracted_fields as Row).paper_log_complete = false;
    (db.documents![0]!.extracted_fields as Row).paper_log_date = "2026-10-27";
    const { client } = fakeStore(db);
    const lines = await hosProvenanceLines(client, COMPANY, [
      { source: "paper_photo", source_document_id: DOC_ID },
      { source: "paper_photo", source_document_id: DOC_ID },
    ]);
    expect(lines[0]).toContain("Every hour in this picture");
    expect(lines.some((l) => l.includes("Partial — from the readable part of 2026-10-27's log"))).toBe(true);

    const none = await hosProvenanceLines(client, COMPANY, [{ source: "app", source_document_id: null }]);
    expect(none).toEqual([]);
  });
});

describe("settle wiring — the paper_log purpose runs the reader now", () => {
  it("a settled paper_log photo stages the day and replies with the read, not 'not read yet'", async () => {
    const db = baseDb();
    const { store, saved, client } = fakeStore(db);
    const reply = await settlePhotoPurpose(
      {
        client,
        companyId: COMPANY,
        brainStore: store,
        readPaperLog: async () => CLEAN_DAY,
      },
      { documentId: DOC_ID, choice: "paper_log", source: "vision", confidence: 0.97 },
    );
    expect(reply.reply).toContain("Read your paper log for");
    expect(reply.reply).not.toContain("not running on this one yet");
    expect(saved.filter((a) => a.toolName === "log_duty_status")).toHaveLength(6);
  });

  it("a failed read stays honest: stored and marked, paper still the record, nothing staged", async () => {
    const db = baseDb();
    const { store, saved, client } = fakeStore(db);
    const reply = await settlePhotoPurpose(
      {
        client,
        companyId: COMPANY,
        brainStore: store,
        readPaperLog: async () => {
          throw new Error("vision unavailable");
        },
      },
      { documentId: DOC_ID, choice: "paper_log", source: "owner", confidence: null },
    );
    expect(reply.reply).toContain("couldn't");
    expect(reply.reply).toContain("legal record");
    expect(saved).toHaveLength(0);
  });
});
