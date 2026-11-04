// R-6 (Research Intelligence design D-5): the research_requests
// contract in services/research/requests.ts, against an in-memory
// fake Supabase client:
// - requestPretripPhotos writes exactly the fenced shape (own
//   company, kind 'pretrip_photo', status 'queued') with the
//   design's default photo list when no items are named;
// - pending reads are company-scoped and oldest-first;
// - dismiss only moves a QUEUED row of the same company - a
//   fulfilled ask or another company's ask is untouched.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRETRIP_PHOTO_DEFAULT_ITEMS,
  dismissResearchRequest,
  listPendingResearchRequests,
  requestPhotoItems,
  requestPretripPhotos,
} from "@/services/research/requests";

const COMPANY = "company-1";
const OTHER = "company-2";
const LOAD_ID = "16161616-1616-4616-8616-161616161616";

type Row = Record<string, unknown>;
type Filter = { col: string; val: unknown };

class FakeQuery {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
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
    this.filters.push({ col, val });
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

  private matched(): Row[] {
    const rows = (this.db[this.table] ?? []).filter((r) =>
      this.filters.every((f) => r[f.col] === f.val),
    );
    if (this.orderCol) {
      const col = this.orderCol;
      rows.sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return this.limitN != null ? rows.slice(0, this.limitN) : rows;
  }

  private execute(): { data: unknown; error: null } {
    if (this.op === "insert") {
      const row: Row = {
        id: `req-${(this.db[this.table] ?? []).length + 1}`,
        created_at: "2026-11-02T12:00:00.000Z",
        fulfilled_at: null,
        ...this.payload,
      };
      (this.db[this.table] ??= []).push(row);
      return { data: row, error: null };
    }
    if (this.op === "update") {
      const rows = this.matched();
      for (const row of rows) Object.assign(row, this.payload);
      return { data: rows, error: null };
    }
    return { data: this.matched(), error: null };
  }

  async single() {
    const { data, error } = this.execute();
    return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
  }

  then(resolve: (v: { data: unknown; error: null }) => void) {
    resolve(this.execute());
  }
}

function fakeClient(seed: Record<string, Row[]>) {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  const client = {
    from: (table: string) => new FakeQuery(db, table),
  } as unknown as SupabaseClient;
  return { client, db };
}

describe("requestPretripPhotos", () => {
  it("writes the fenced row shape with the default photo list", async () => {
    const { client, db } = fakeClient({ research_requests: [] });
    const id = await requestPretripPhotos(client, COMPANY, {
      loadId: LOAD_ID,
      reason: "Storm damage reported on this lane.",
    });
    expect(id).toBe("req-1");
    const row = db.research_requests![0]!;
    expect(row.company_id).toBe(COMPANY);
    expect(row.load_id).toBe(LOAD_ID);
    expect(row.kind).toBe("pretrip_photo");
    expect(row.status).toBe("queued");
    expect(row.detail).toEqual({
      checklist_kind: "pre-trip",
      items: [...PRETRIP_PHOTO_DEFAULT_ITEMS],
      reason: "Storm damage reported on this lane.",
    });
  });

  it("honors named items and checklist kind, dropping blanks", async () => {
    const { client, db } = fakeClient({ research_requests: [] });
    await requestPretripPhotos(client, COMPANY, {
      checklistKind: "post-trip",
      items: [" reefer unit ", "", "door seals"],
    });
    expect(db.research_requests![0]!.detail).toEqual({
      checklist_kind: "post-trip",
      items: ["reefer unit", "door seals"],
    });
    expect(db.research_requests![0]!.load_id).toBeNull();
  });
});

describe("listPendingResearchRequests + dismissResearchRequest", () => {
  const seed = () => ({
    research_requests: [
      {
        id: "req-old",
        company_id: COMPANY,
        load_id: null,
        kind: "pretrip_photo",
        detail: { checklist_kind: "pre-trip", items: ["tires"] },
        status: "queued",
        created_at: "2026-11-01T08:00:00.000Z",
        fulfilled_at: null,
      },
      {
        id: "req-new",
        company_id: COMPANY,
        load_id: LOAD_ID,
        kind: "pretrip_photo",
        detail: { checklist_kind: "pre-trip", items: ["lights"], reason: "Recall notice." },
        status: "queued",
        created_at: "2026-11-02T08:00:00.000Z",
        fulfilled_at: null,
      },
      {
        id: "req-done",
        company_id: COMPANY,
        load_id: null,
        kind: "pretrip_photo",
        detail: {},
        status: "fulfilled",
        created_at: "2026-10-31T08:00:00.000Z",
        fulfilled_at: "2026-10-31T09:00:00.000Z",
      },
      {
        id: "req-other",
        company_id: OTHER,
        load_id: null,
        kind: "pretrip_photo",
        detail: {},
        status: "queued",
        created_at: "2026-11-02T07:00:00.000Z",
        fulfilled_at: null,
      },
    ],
  });

  it("lists only the company's queued asks, oldest first", async () => {
    const { client } = fakeClient(seed());
    const pending = await listPendingResearchRequests(client, COMPANY);
    expect(pending.map((r) => r.id)).toEqual(["req-old", "req-new"]);
    expect(requestPhotoItems(pending[1]!)).toEqual(["lights"]);
  });

  it("dismisses a queued ask and reports it", async () => {
    const { client, db } = fakeClient(seed());
    await expect(dismissResearchRequest(client, COMPANY, "req-old")).resolves.toBe(true);
    expect(db.research_requests!.find((r) => r.id === "req-old")!.status).toBe("dismissed");
  });

  it("never dismisses a fulfilled ask or another company's ask", async () => {
    const { client, db } = fakeClient(seed());
    await expect(dismissResearchRequest(client, COMPANY, "req-done")).resolves.toBe(false);
    await expect(dismissResearchRequest(client, COMPANY, "req-other")).resolves.toBe(false);
    expect(db.research_requests!.find((r) => r.id === "req-done")!.status).toBe("fulfilled");
    expect(db.research_requests!.find((r) => r.id === "req-other")!.status).toBe("queued");
  });
});
