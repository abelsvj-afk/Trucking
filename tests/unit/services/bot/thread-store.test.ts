// Phase C acceptance (design §4, tests 1-2): a forwarded
// multi-party thread is reconstructed into a STORED record
// (participants, roles, ask, deadline, unanswered); a follow-up
// from the same conversation APPENDS to the same thread; open
// loops read back from the record; message bodies stay verbatim
// (English untouched - the F-019 shape). Before migration 00046
// the write fails plainly and reads degrade to empty.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore, type ThreadRecordInput } from "@/services/bot/store";
import { buildPersonModel } from "@/services/bot/threads";
import { captureForwardThread } from "@/services/bot/thread-capture";
import type { AiProvider } from "@/services/ai/provider";

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
  private payload: Row | Row[] | null = null;
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
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    if (this.missing.has(this.table)) {
      return { data: null, error: { message: `relation "public.${this.table}" does not exist`, code: "42P01" }, count: null };
    }
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted = payloads.map((payload) => {
        const row: Row = {
          id: `row-${this.table}-${rows.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
          created_at: this.stamp(),
          updated_at: this.stamp(),
          valid_to: null,
          deleted_at: null,
          ...payload,
        };
        rows.push(row);
        return row;
      });
      return { data: single || maybe ? inserted[0] ?? null : inserted, error: null, count: null };
    }
    if (this.op === "update") {
      // supabase-js drops undefined values from the JSON body - the fake mirrors that (an absent key leaves the column untouched).
      const clean = Object.fromEntries(Object.entries(this.payload as Row).filter(([, v]) => v !== undefined));
      for (const row of rows) if (matches(row, this.filters)) Object.assign(row, clean);
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

const SEGMENT_1: ThreadRecordInput = {
  title: "Dispatch — Dallas load confirmation",
  participants: [
    { name: "Maria", role: "carrier_dispatch" },
    { name: "Steven", role: "steven" },
    { name: "Sajacous", role: "owner" },
  ],
  messages: [
    { senderName: "Maria", body: "Load 4417 Dallas to Atlanta, pickup tomorrow 08:00. Can the driver confirm?", language: "en", sentAt: null },
    { senderName: "Steven", body: "He is 40 miles out, should be fine", language: "en", sentAt: null },
  ],
  theAsk: "Confirm the driver can pick up load 4417 tomorrow at 08:00",
  askOf: "Sajacous",
  deadlineText: "tomorrow 08:00",
  unanswered: true,
  source: "forward",
  exchangeId: null,
};

const SEGMENT_2: ThreadRecordInput = {
  participants: [
    { name: "Maria", role: "carrier_dispatch" },
    { name: "Sajacous", role: "owner" },
  ],
  messages: [
    { senderName: "Maria", body: "Following up - still need that confirmation for 4417", language: "en", sentAt: null },
  ],
  theAsk: "Confirm the driver can pick up load 4417 tomorrow at 08:00",
  askOf: "Sajacous",
  deadlineText: "tomorrow 08:00",
  unanswered: true,
  source: "forward",
  exchangeId: null,
};

describe("thread records", () => {
  it("stores a multi-party thread: participants, roles, ask, deadline, unanswered, verbatim bodies", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    const recorded = await store.recordForwardThread(SEGMENT_1);
    expect(recorded.appended).toBe(false);

    const detail = await store.getThread(recorded.threadId);
    expect(detail?.thread.participants).toHaveLength(3);
    expect(detail?.thread.theAsk).toContain("4417");
    expect(detail?.thread.deadlineText).toBe("tomorrow 08:00");
    expect(detail?.thread.unanswered).toBe(true);
    expect(detail?.thread.language).toBe("en");
    // Verbatim: the English body comes back byte-for-byte - never translated, never cleaned (F-019 shape).
    expect(detail?.messages[0]?.body).toBe("Load 4417 Dallas to Atlanta, pickup tomorrow 08:00. Can the driver confirm?");
    expect(detail?.messages[0]?.senderRole).toBe("carrier_dispatch");
  });

  it("a follow-up from the same conversation APPENDS to the same thread; a different counterparty starts a new one", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    const first = await store.recordForwardThread(SEGMENT_1);
    const second = await store.recordForwardThread(SEGMENT_2);
    expect(second.threadId).toBe(first.threadId);
    expect(second.appended).toBe(true);
    const detail = await store.getThread(first.threadId);
    expect(detail?.messages).toHaveLength(3);

    const other = await store.recordForwardThread({
      ...SEGMENT_1,
      participants: [{ name: "Broker Bob", role: "broker" }],
      messages: [{ senderName: "Broker Bob", body: "Rate on the Memphis load?", language: "en", sentAt: null }],
    });
    expect(other.threadId).not.toBe(first.threadId);
  });

  it("open loops read from the record; markThreadAnswered closes the loop, not the thread", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    const { threadId } = await store.recordForwardThread(SEGMENT_1);
    const loops = await store.listThreads({ openOnly: true, unansweredOnly: true });
    expect(loops.map((t) => t.id)).toContain(threadId);
    await store.markThreadAnswered(threadId);
    expect(await store.listThreads({ openOnly: true, unansweredOnly: true })).toHaveLength(0);
    const detail = await store.getThread(threadId);
    expect(detail?.thread.status).toBe("open");
    expect(detail?.thread.unanswered).toBe(false);
  });

  it("before migration 00046 the WRITE fails plainly; reads degrade to empty", async () => {
    const store = fakeStore({}, new Set(["forward_threads", "forward_thread_messages"]));
    await expect(store.recordForwardThread(SEGMENT_1)).rejects.toThrow(/migration 00046/);
    expect(await store.listThreads({})).toEqual([]);
    expect(await store.getThread("anything")).toBeNull();
  });
});

describe("Telegram repairs: two forwarded bundles accumulate one person's evidence", () => {
  it("the second bundle appends to the same thread and the person model grows, not restarts", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);

    // Bundle 1 (as captureForwardThread records a batched bundle):
    // Maria the dispatcher appears twice.
    const first = await store.recordForwardThread({
      title: "Dispatch — Dallas load",
      participants: [
        { name: "Maria", role: "carrier_dispatch" },
        { name: "Sajacous", role: "owner" },
      ],
      messages: [
        { senderName: "Maria", body: "Load 4417 pickup tomorrow 08:00", language: "en", sentAt: null },
        { senderName: "Maria", body: "Dock 4 when you get in", language: "en", sentAt: null },
      ],
      theAsk: "Confirm the pickup",
      askOf: "Sajacous",
      deadlineText: "tomorrow 08:00",
      unanswered: true,
      source: "forward",
      exchangeId: null,
    });
    const before = buildPersonModel("Maria", await store.loadPersonEvidence("Maria"));

    // Bundle 2, a day later, same counterparty: appends, and her
    // evidence count grows by the new messages - one accumulating
    // record, never two isolated ones.
    const second = await store.recordForwardThread({
      title: "Dispatch — Dallas load follow-up",
      participants: [
        { name: "Maria", role: "carrier_dispatch" },
        { name: "Sajacous", role: "owner" },
      ],
      messages: [
        { senderName: "Maria", body: "BOL is at the guard shack", language: "en", sentAt: null },
        { senderName: "Maria", body: "Seal number goes on the paperwork", language: "en", sentAt: null },
        { senderName: "Maria", body: "Call me when you're loaded", language: "en", sentAt: null },
      ],
      theAsk: "Call when loaded",
      askOf: "Sajacous",
      deadlineText: null,
      unanswered: true,
      source: "forward",
      exchangeId: null,
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.appended).toBe(true);
    const evidence = await store.loadPersonEvidence("Maria");
    const after = buildPersonModel("Maria", evidence);
    expect(evidence.threads).toHaveLength(1);
    expect(after.evidenceCount).toBe(before.evidenceCount + 3);
    const detail = await store.getThread(first.threadId);
    expect(detail?.messages).toHaveLength(5);
  });
});

describe("Telegram repairs: bundle capture through captureForwardThread itself", () => {
  it("two bundles captured through the real capture path land in ONE thread and pool Maria's evidence", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);

    // The governed extraction, faked at the provider seam: bundle
    // A's combined text reconstructs to two Maria messages,
    // bundle B's to three more from the same counterparty.
    const extractions = [
      {
        title: "Dispatch — Dallas load",
        language: "en",
        participants: [
          { name: "Maria", role: "carrier_dispatch" },
          { name: "Sajacous", role: "owner" },
        ],
        messages: [
          { sender: "Maria", body: "Load 4417 pickup tomorrow 08:00", language: "en", sent_at: null },
          { sender: "Maria", body: "Dock 4 when you get in", language: "en", sent_at: null },
        ],
        the_ask: "Confirm the pickup",
        ask_of: "Sajacous",
        deadline_text: "tomorrow 08:00",
        unanswered: true,
      },
      {
        title: "Dispatch — Dallas load follow-up",
        language: "en",
        participants: [
          { name: "Maria", role: "carrier_dispatch" },
          { name: "Sajacous", role: "owner" },
        ],
        messages: [
          { sender: "Maria", body: "BOL is at the guard shack", language: "en", sent_at: null },
          { sender: "Maria", body: "Seal number goes on the paperwork", language: "en", sent_at: null },
          { sender: "Maria", body: "Call me when you're loaded", language: "en", sent_at: null },
        ],
        the_ask: "Call when loaded",
        ask_of: "Sajacous",
        deadline_text: null,
        unanswered: true,
      },
    ];
    const provider = {
      complete: async () => JSON.stringify(extractions.shift()),
    } as unknown as AiProvider;

    await captureForwardThread(store, provider, "BUNDLE A combined text");
    const before = buildPersonModel("Maria", await store.loadPersonEvidence("Maria"));
    await captureForwardThread(store, provider, "BUNDLE B combined text");
    const evidence = await store.loadPersonEvidence("Maria");
    const after = buildPersonModel("Maria", evidence);

    expect(evidence.threads).toHaveLength(1);
    expect(after.evidenceCount).toBe(before.evidenceCount + 3);
    const threads = await store.listThreads({});
    expect(threads).toHaveLength(1);
    const detail = await store.getThread(threads[0]!.id);
    expect(detail?.messages).toHaveLength(5);
  });
});

describe("person evidence through the store", () => {
  it("aggregates threads, their messages, a confirmed profile, and exchange mentions for one name", async () => {
    const db: Record<string, Row[]> = {};
    const store = fakeStore(db);
    (db.bot_memories ??= []).push({
      id: "mem-steven",
      company_id: COMPANY,
      kind: "person_profile",
      content: "PERSON — Steven | role: truck owner | Pays on Fridays.",
      created_at: "2026-10-30T00:00:00.000Z",
      valid_to: null,
      deleted_at: null,
    });
    (db.dispatch_exchanges ??= []).push(
      { id: "ex-1", company_id: COMPANY, incoming_message: "Steven: trailer swap Friday?", created_at: "2026-11-01T00:00:00.000Z", deleted_at: null },
      { id: "ex-2", company_id: COMPANY, incoming_message: "unrelated broker text", created_at: "2026-11-01T00:00:00.000Z", deleted_at: null },
    );
    await store.recordForwardThread({
      ...SEGMENT_1,
      messages: [
        { senderName: "Steven", body: "Settlement lands Friday, settlement Friday", language: "en", sentAt: null },
        { senderName: "Maria", body: "Copy that", language: "en", sentAt: null },
      ],
    });
    const evidence = await store.loadPersonEvidence("Steven");
    expect(evidence.confirmedProfile?.name).toBe("Steven");
    expect(evidence.threads).toHaveLength(1);
    expect(evidence.threads[0]?.messagesFromThem).toBe(1);
    expect(evidence.messageBodies).toHaveLength(1);
    expect(evidence.exchangeMentions).toBe(1);
  });
});
