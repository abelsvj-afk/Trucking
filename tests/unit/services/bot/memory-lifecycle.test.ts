// Lane 2, Phase B acceptance (Intelligence Upgrade design §7):
// (1) "settles Fridays" -> "settles Thursdays": the new fact is the
// current one, the old one is closed with dates + a superseded_by
// pointer, and history still answers "when did it change?".
// Plus the "What Abel remembers" admin operations (list / edit /
// delete) over the same store, and the lifecycle primitives.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";
import {
  applySupersession,
  memorySubjectKey,
  personIdentityConfirmed,
  tokenSimilarity,
} from "@/services/bot/memory-lifecycle";

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
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private countHead = false;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
    private stamp: () => string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.head) this.countHead = true;
    return this;
  }
  insert(payload: Row) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const row: Row = {
        id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: this.stamp(),
        valid_to: null,
        deleted_at: null,
        ...this.payload,
      };
      rows.push(row);
      return { data: single || maybe ? row : [row], error: null, count: null };
    }
    if (this.op === "update") {
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, this.payload);
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
const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();

function fakeStore(db: Record<string, Row[]>) {
  const client = {
    from: (table: string) => new FakeQuery(db, table, stamp),
    rpc: async () => ({ data: null, error: { message: "no rpc in fake" } }),
  } as unknown as SupabaseClient;
  return createBotStore(client, COMPANY, "telegram");
}

describe("memorySubjectKey / tokenSimilarity", () => {
  it("keys people and business subjects; plain facts have no key", () => {
    expect(memorySubjectKey("person_profile", "PERSON — Steven | role: truck owner | Pays Fridays.")).toBe("person:steven");
    expect(memorySubjectKey("business_fact", "BUSINESS — How this carrier pays | Weekly.")).toBe("business:how this carrier pays");
    expect(memorySubjectKey("fact", "Steven settles on Fridays")).toBeNull();
  });

  it("similarity: identical text = 1, disjoint = 0, near-dupes land high", () => {
    expect(tokenSimilarity("Steven settles on Fridays", "Steven settles on Fridays")).toBe(1);
    expect(tokenSimilarity("cats and dogs", "quantum physics lecture")).toBe(0);
    expect(tokenSimilarity("Steven settles on Fridays", "Steven settles on Thursdays")).toBe(0.5);
  });
});

describe("supersession (acceptance B1)", () => {
  it("a new Steven profile closes the old one; current reads show only the new", async () => {
    const db: Record<string, Row[]> = { bot_memories: [] };
    const store = fakeStore(db);
    const firstId = await store.saveMemory(
      "person_profile",
      "PERSON — Steven | role: truck owner | Settles on Fridays.",
    );
    const secondId = await store.saveMemory(
      "person_profile",
      "PERSON — Steven | role: truck owner | Settles on Thursdays now.",
    );
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();

    const current = await store.listMemories();
    expect(current).toHaveLength(1);
    expect(current[0]?.content).toContain("Thursdays");

    // "When did it change?" - history carries both rows, the old
    // one closed and pointing at its replacement.
    const history = await store.listMemories({ includeHistory: true });
    expect(history).toHaveLength(2);
    const old = history.find((m) => m.id === firstId);
    expect(old?.valid_to).toBeTruthy();
    expect(old?.superseded_by).toBe(secondId);
  });

  it("applySupersession closes only the same subject", async () => {
    const db: Record<string, Row[]> = {
      bot_memories: [
        { id: "p1", company_id: COMPANY, kind: "person_profile", content: "PERSON — Steven | role: owner | Old.", created_at: stamp(), deleted_at: null, valid_to: null },
        { id: "p2", company_id: COMPANY, kind: "person_profile", content: "PERSON — Maria | role: dispatcher | Keep.", created_at: stamp(), deleted_at: null, valid_to: null },
      ],
    };
    const client = { from: (table: string) => new FakeQuery(db, table, stamp) } as unknown as SupabaseClient;
    const closed = await applySupersession(client, COMPANY, {
      id: "p3",
      kind: "person_profile",
      content: "PERSON — Steven | role: owner | New.",
    });
    expect(closed.map((r) => r.id)).toEqual(["p1"]);
    expect(db.bot_memories?.find((r) => r.id === "p2")?.valid_to).toBeNull();
  });
});

describe("CD-4: a namesake is not the same person", () => {
  it("identity needs name AND role - a missing or different role confirms nothing", () => {
    expect(
      personIdentityConfirmed(
        "PERSON — Steven | role: truck owner | New.",
        "PERSON — Steven | role: Truck Owner | Old.",
      ),
    ).toBe(true);
    expect(
      personIdentityConfirmed(
        "PERSON — Steven | role: broker | New.",
        "PERSON — Steven | role: truck owner | Old.",
      ),
    ).toBe(false);
    expect(personIdentityConfirmed("PERSON — Steven | New.", "PERSON — Steven | role: broker | Old.")).toBe(false);
    expect(personIdentityConfirmed("PERSON — Steven | role: broker | New.", "PERSON — Steven | Old.")).toBe(false);
  });

  it("applySupersession leaves a different-role namesake current and reports it as ambiguous", async () => {
    const db: Record<string, Row[]> = {
      bot_memories: [
        { id: "p1", company_id: COMPANY, kind: "person_profile", content: "PERSON — Steven | role: truck owner | Pays on Fridays.", created_at: stamp(), deleted_at: null, valid_to: null },
      ],
    };
    const client = { from: (table: string) => new FakeQuery(db, table, stamp) } as unknown as SupabaseClient;
    const onAmbiguousPersonMatch = vi.fn(
      async (_oldRow: { id: string; kind: string; content: string; created_at: string }) => {},
    );
    const closed = await applySupersession(
      client,
      COMPANY,
      { id: "p2", kind: "person_profile", content: "PERSON — Steven | role: broker | Quoted $2.10 a mile." },
      { onAmbiguousPersonMatch },
    );
    expect(closed).toEqual([]);
    expect(db.bot_memories?.find((r) => r.id === "p1")?.valid_to).toBeNull();
    expect(onAmbiguousPersonMatch).toHaveBeenCalledTimes(1);
    expect(onAmbiguousPersonMatch.mock.calls[0]?.[0]).toMatchObject({ id: "p1" });
  });

  it("store level: a namesake save keeps BOTH profiles current and stages a replace proposal; his yes converges to one", async () => {
    const db: Record<string, Row[]> = { bot_memories: [], bot_pending_actions: [] };
    const store = fakeStore(db);
    const ownerId = await store.saveMemory(
      "person_profile",
      "PERSON — Steven | role: truck owner | Settles on Fridays.",
    );
    const brokerId = await store.saveMemory(
      "person_profile",
      "PERSON — Steven | role: broker | Quoted $2.10 a mile.",
    );
    expect(ownerId).toBeTruthy();
    expect(brokerId).toBeTruthy();

    // Neither profile was silently closed.
    const current = await store.listMemories();
    expect(current).toHaveLength(2);
    // The question was staged on the proposal path, naming the old row.
    expect(db.bot_pending_actions).toHaveLength(1);
    const proposal = db.bot_pending_actions![0]!;
    expect(proposal.tool_name).toBe("save_memory");
    expect((proposal.arguments as Row).supersedes_id).toBe(ownerId);
    expect(String(proposal.summary)).toContain("same name");

    // His yes executes the proposal: save the new profile's content
    // naming the old row - the explicit path closes the old row,
    // and the confirmed-identity path closes the duplicate.
    await store.saveMemory(
      "person_profile",
      "PERSON — Steven | role: broker | Quoted $2.10 a mile.",
      { supersedesId: ownerId! },
    );
    const after = await store.listMemories();
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toContain("broker");
  });
});

describe("What Abel remembers - admin operations", () => {
  it("edit saves a corrected NEW row and closes the original", async () => {
    const db: Record<string, Row[]> = { bot_memories: [] };
    const store = fakeStore(db);
    const originalId = await store.saveMemory("fact", "The yard is on Peachtree Street");
    const newId = await store.editMemory(originalId!, "The yard is on Peachtree Industrial Blvd");
    expect(newId).not.toBe(originalId);
    const current = await store.listMemories();
    expect(current.map((m) => m.content)).toEqual(["The yard is on Peachtree Industrial Blvd"]);
    const history = await store.listMemories({ includeHistory: true });
    expect(history.find((m) => m.id === originalId)?.superseded_by).toBe(newId);
  });

  it("delete soft-deletes: gone from current AND history lists", async () => {
    const db: Record<string, Row[]> = { bot_memories: [] };
    const store = fakeStore(db);
    const id = await store.saveMemory("fact", "A fact he wants gone");
    await store.deleteMemory(id!);
    expect(await store.listMemories({ includeHistory: true })).toHaveLength(0);
    expect(db.bot_memories?.[0]?.deleted_at).toBeTruthy();
  });
});
