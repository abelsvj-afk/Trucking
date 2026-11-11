// Duty-log edit trail (UI/UX spec 2026-11-10 §2.2, migration 00088):
// the write path pinned end to end against a stateful fake Supabase -
// PATCH/DELETE refuse a reasonless correction (422), a reasoned one
// writes the trail row with exact before/after snapshots, backdated
// creates are refused unless they carry a reason OR a submission_id
// (the offline-outbox replay distinguisher), live creates need no
// reason and write no trail, and restore writes kind='restore'.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));
vi.mock("@/services/db/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/services/db/server";
import { POST as collectionPOST } from "@/app/api/v1/duty-logs/route";
import { GET as getOne, PATCH, DELETE as removeOne } from "@/app/api/v1/duty-logs/[id]/route";
import { POST as restorePOST } from "@/app/api/v1/duty-logs/[id]/restore/route";

type Row = Record<string, unknown>;

const COMPANY = "company-1";
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";

interface State {
  duty: Row[];
  edits: Row[];
  nextId: number;
}

let state: State;

function freshState(): State {
  return { duty: [], edits: [], nextId: 100 };
}

function seedDuty(overrides: Row = {}): Row {
  const row: Row = {
    id: ENTRY_ID,
    company_id: COMPANY,
    driver_id: null,
    load_id: null,
    duty_status: "driving",
    started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    location: "Panama City, FL",
    odometer: 1000,
    notes: null,
    source: "app",
    created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    deleted_at: null,
    ...overrides,
  };
  state.duty.push(row);
  return row;
}

type Filter = { col: string; op: "eq" | "is" | "not-is"; val: unknown };

function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.op === "eq") return row[f.col] === f.val;
    if (f.op === "is") return (row[f.col] ?? null) === f.val;
    return (row[f.col] ?? null) !== f.val; // not-is
  });
}

class FakeBuilder {
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;

  constructor(private table: string) {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, op: "is", val });
    return this;
  }
  not(col: string, _op: string, val: unknown) {
    this.filters.push({ col, op: "not-is", val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  range() {
    return this;
  }
  limit() {
    return this;
  }
  gte() {
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: "eq", val: vals });
    return this;
  }

  private rows(): Row[] {
    const all = this.table === "duty_log_edits" ? state.edits : state.duty;
    let out = all.filter((row) =>
      this.filters.every((f) => {
        if (Array.isArray(f.val)) return f.val.includes(row[f.col]);
        return matchesFilters(row, [f]);
      }),
    );
    if (this.orderCol) {
      const col = this.orderCol;
      out = [...out].sort((a, b) =>
        this.orderAsc
          ? String(a[col]) < String(b[col])
            ? -1
            : 1
          : String(a[col]) > String(b[col])
            ? -1
            : 1,
      );
    }
    return out;
  }

  private doInsert(): Row {
    const payload = this.payload as Row;
    if (this.table === "duty_logs" && payload.submission_id) {
      const dupe = state.duty.find((r) => r.submission_id === payload.submission_id);
      if (dupe) {
        throw { code: "23505", message: "duplicate key value violates unique constraint \"duty_logs_submission_idempotency\"", details: "" };
      }
    }
    const row: Row = {
      id: `generated-${state.nextId++}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      ...payload,
    };
    if (this.table === "duty_log_edits") {
      row.edited_at = row.created_at;
      state.edits.push(row);
    } else {
      state.duty.push(row);
    }
    return row;
  }

  private doUpdate(): Row[] {
    const targets = this.rows();
    for (const row of targets) Object.assign(row, this.payload);
    return targets;
  }

  single() {
    return Promise.resolve(this.execute(true, false));
  }
  maybeSingle() {
    return Promise.resolve(this.execute(true, true));
  }

  private execute(single: boolean, _maybe: boolean): { data: unknown; error: unknown; count?: number } {
    try {
      if (this.mode === "insert") {
        const row = this.doInsert();
        return { data: single ? row : [row], error: null };
      }
      if (this.mode === "update") {
        const updated = this.doUpdate();
        return { data: single ? (updated[0] ?? null) : updated, error: null };
      }
      const rows = this.rows();
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    } catch (err) {
      return { data: null, error: err };
    }
  }

  then(resolve: (v: { data: unknown; error: unknown; count?: number }) => void) {
    resolve(this.execute(false, false));
  }
}

function fakeClient() {
  return { from: (table: string) => new FakeBuilder(table) };
}

const ctxFor = (id?: string): { params: Promise<Record<string, string>> } => {
  const params: Record<string, string> = id ? { id } : {};
  return { params: Promise.resolve(params) };
};

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  state = freshState();
  vi.mocked(createClient).mockResolvedValue(fakeClient() as never);
});

describe("PATCH /duty-logs/[id] - reason enforcement + trail", () => {
  it("refuses a substantive patch without a reason (422) and writes nothing", async () => {
    seedDuty();
    const res = await PATCH(
      jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "PATCH", { duty_status: "on_duty" }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("A reason is required to correct a duty entry.");
    expect(state.duty[0]!.duty_status).toBe("driving");
    expect(state.edits).toEqual([]);
  });

  it("with a reason: updates, strips the meta fields from the row, and writes the exact before/after trail row", async () => {
    const before = seedDuty();
    const res = await PATCH(
      jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "PATCH", {
        duty_status: "on_duty",
        location: "Panama City Beach, FL",
        edit_reason: "Wrong status",
      }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(200);
    const row = state.duty[0]!;
    expect(row.duty_status).toBe("on_duty");
    expect(row.location).toBe("Panama City Beach, FL");
    expect("edit_reason" in row).toBe(false);
    expect("edit_source" in row).toBe(false);
    expect(state.edits).toHaveLength(1);
    const edit = state.edits[0]!;
    expect(edit.kind).toBe("update");
    expect(edit.reason).toBe("Wrong status");
    expect(edit.source).toBe("app");
    expect(edit.duty_log_id).toBe(ENTRY_ID);
    expect(edit.company_id).toBe(COMPANY);
    expect(edit.before).toEqual(before);
    expect((edit.after as Row).duty_status).toBe("on_duty");
    expect((edit.after as Row).location).toBe("Panama City Beach, FL");
  });

  it("honors an explicit edit_source on the trail row", async () => {
    seedDuty();
    const res = await PATCH(
      jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "PATCH", {
        notes: "Fuel stop",
        edit_reason: "Entered late",
        edit_source: "conversation",
      }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(200);
    expect(state.edits[0]!.source).toBe("conversation");
  });
});

describe("POST /duty-logs - backfill guard + insert trail", () => {
  const backdated = new Date(Date.now() - 3 * 3_600_000).toISOString();

  it("refuses a backdated create with no reason and no submission_id (422)", async () => {
    const res = await collectionPOST(
      jsonReq("http://localhost/api/v1/duty-logs", "POST", { duty_status: "driving", started_at: backdated }),
      ctxFor(),
    );
    expect(res.status).toBe(422);
    expect(state.duty).toEqual([]);
    expect(state.edits).toEqual([]);
  });

  it("a backdated create WITH submission_id succeeds with no trail demanded (outbox replay path)", async () => {
    const res = await collectionPOST(
      jsonReq("http://localhost/api/v1/duty-logs", "POST", {
        duty_status: "driving",
        started_at: backdated,
        submission_id: SUBMISSION_ID,
      }),
      ctxFor(),
    );
    expect(res.status).toBe(201);
    expect(state.duty).toHaveLength(1);
    expect(state.edits).toEqual([]);
  });

  it("a live create (started_at ~ now) without a reason succeeds with no trail row", async () => {
    const res = await collectionPOST(
      jsonReq("http://localhost/api/v1/duty-logs", "POST", {
        duty_status: "on_duty",
        started_at: new Date().toISOString(),
      }),
      ctxFor(),
    );
    expect(res.status).toBe(201);
    expect(state.duty).toHaveLength(1);
    expect(state.edits).toEqual([]);
  });

  it("a backfill WITH a reason succeeds and writes kind='insert' (before null), meta stripped from the row", async () => {
    const res = await collectionPOST(
      jsonReq("http://localhost/api/v1/duty-logs", "POST", {
        duty_status: "driving",
        started_at: backdated,
        location: "Seminole, OK",
        edit_reason: "Forgot to log it",
      }),
      ctxFor(),
    );
    expect(res.status).toBe(201);
    const row = state.duty[0]!;
    expect("edit_reason" in row).toBe(false);
    expect(state.edits).toHaveLength(1);
    const edit = state.edits[0]!;
    expect(edit.kind).toBe("insert");
    expect(edit.reason).toBe("Forgot to log it");
    expect(edit.source).toBe("app");
    expect(edit.before).toBeNull();
    expect(edit.duty_log_id).toBe(row.id);
    expect((edit.after as Row).duty_status).toBe("driving");
  });

  it("a reasoned create replayed by submission_id does NOT write a second trail row (hook skips dedup replays)", async () => {
    const body = {
      duty_status: "driving",
      started_at: backdated,
      edit_reason: "Forgot to log it",
      submission_id: SUBMISSION_ID,
    };
    const first = await collectionPOST(jsonReq("http://localhost/api/v1/duty-logs", "POST", body), ctxFor());
    expect(first.status).toBe(201);
    const replay = await collectionPOST(jsonReq("http://localhost/api/v1/duty-logs", "POST", body), ctxFor());
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Row).deduplicated).toBe(true);
    expect(state.duty).toHaveLength(1);
    expect(state.edits).toHaveLength(1);
  });
});

describe("DELETE /duty-logs/[id] - reason required, delete trail", () => {
  it("refuses without a reason (422) and deletes nothing", async () => {
    seedDuty();
    const res = await removeOne(jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "DELETE"), ctxFor(ENTRY_ID));
    expect(res.status).toBe(422);
    expect(state.duty[0]!.deleted_at).toBeNull();
    expect(state.edits).toEqual([]);
  });

  it("with a reason in the body: soft-deletes and writes kind='delete' (after null)", async () => {
    const before = seedDuty();
    const res = await removeOne(
      jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "DELETE", { edit_reason: "Wrong time" }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(204);
    expect(state.duty[0]!.deleted_at).not.toBeNull();
    expect(state.edits).toHaveLength(1);
    const edit = state.edits[0]!;
    expect(edit.kind).toBe("delete");
    expect(edit.reason).toBe("Wrong time");
    expect(edit.before).toEqual(before);
    expect(edit.after).toBeNull();
  });

  it("accepts the reason from the ?edit_reason= query param", async () => {
    seedDuty();
    const res = await removeOne(
      new NextRequest(`http://localhost/api/v1/duty-logs/${ENTRY_ID}?edit_reason=Entered%20late`, { method: "DELETE" }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(204);
    expect(state.edits[0]!.reason).toBe("Entered late");
  });

  it("404s for an entry that doesn't exist, reason or not", async () => {
    const res = await removeOne(
      jsonReq(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`, "DELETE", { edit_reason: "Wrong time" }),
      ctxFor(ENTRY_ID),
    );
    expect(res.status).toBe(404);
  });
});

describe("restore + GET read path", () => {
  it("restore writes kind='restore' with the default reason (RecordLifecycle calls it with no body)", async () => {
    seedDuty({ deleted_at: new Date().toISOString() });
    const res = await restorePOST(new NextRequest(`http://localhost/api/v1/duty-logs/${ENTRY_ID}/restore`, { method: "POST" }), ctxFor(ENTRY_ID));
    expect(res.status).toBe(200);
    expect(state.duty[0]!.deleted_at).toBeNull();
    expect(state.edits).toHaveLength(1);
    const edit = state.edits[0]!;
    expect(edit.kind).toBe("restore");
    expect(edit.reason).toBe("Entry restored");
    expect(edit.before).toBeNull();
    expect((edit.after as Row).id).toBe(ENTRY_ID);
  });

  it("GET returns the row PLUS its edits, edited_at ascending", async () => {
    seedDuty();
    state.edits.push(
      { id: "e2", company_id: COMPANY, duty_log_id: ENTRY_ID, kind: "update", reason: "Wrong time", before: null, after: null, source: "app", edited_at: "2026-11-10T15:00:00.000Z", created_at: "2026-11-10T15:00:00.000Z" },
      { id: "e1", company_id: COMPANY, duty_log_id: ENTRY_ID, kind: "insert", reason: "Forgot to log it", before: null, after: null, source: "app", edited_at: "2026-11-10T14:00:00.000Z", created_at: "2026-11-10T14:00:00.000Z" },
      { id: "eX", company_id: COMPANY, duty_log_id: "other-entry", kind: "update", reason: "Not this entry", before: null, after: null, source: "app", edited_at: "2026-11-10T13:00:00.000Z", created_at: "2026-11-10T13:00:00.000Z" },
    );
    const res = await getOne(new NextRequest(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`), ctxFor(ENTRY_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row & { edits: Row[] };
    expect(body.id).toBe(ENTRY_ID);
    expect(body.duty_status).toBe("driving");
    expect(body.edits.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("GET 404s for a missing entry, exactly like the factory", async () => {
    const res = await getOne(new NextRequest(`http://localhost/api/v1/duty-logs/${ENTRY_ID}`), ctxFor(ENTRY_ID));
    expect(res.status).toBe(404);
  });
});
