// Regression for the live failure 2026-11-07 (Fly v68): the owner said SEND / YES about an email
// reply a dozen times and the bot NEVER sent - every yes executed another draft-SAVE, because
//   (1) the system prompt still said "I cannot send any email" (rung-1 text, never updated),
//   (2) no code path ever created the send_email proposal - only the model could, and it kept
//       re-drafting instead (there was often no saved draft, hence no fingerprint, hence the
//       "missing fingerprint" detour and a 6-step exhaustion),
//   (3) a draft-SAVE proposal was what a bare yes resolved, and an unrelated proposal created in
//       between (a photo attach) stole a yes outright,
//   (4) the draft display ended with model-facing instructions that were read back to the owner
//       verbatim when his yes executed the save.
// The fix: drafting saves in the turn it is asked for; "send" about a waiting draft stages the
// send_email proposal IN CODE (stageEmailSendIfAsked); the prompt describes the real flow; the
// draft display is split into owner text and a model note, and executed results are stripped of
// model-only lines before they are quoted back to him.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMAIL_RULES, runAgentTurn } from "@/services/bot/agent-turn";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { buildEmailTools, draftModelNote, showDraft } from "@/services/bot/email-tools";
import { gateExecutes } from "@/services/bot/execute-gate";
import { stripModelOnlyLines } from "@/services/bot/reply-prose";
import { runAgentLoop } from "@/services/ai/agent-loop";
import { bodyFingerprint } from "@/services/email/send";
import type { BotChatInput } from "@/services/ai/bot-chat";
import type { AiToolTurnResult, AgentCapableProvider } from "@/services/ai/provider";
import { memStore } from "../../helpers/mem-email-store";

const COMPANY = "company-1";
const MSG = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const DRAFT_BODY = "Thanks for reaching out - yes, we run central Florida. Best way is right here by email.";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "gte" | "lte" | "in" | "ilike"; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq": return value === f.val;
      case "is": return f.val === null ? value === null || value === undefined : value === f.val;
      case "gte": return typeof value === "string" && typeof f.val === "string" ? value >= f.val : Number(value) >= Number(f.val);
      case "lte": return typeof value === "string" && typeof f.val === "string" ? value <= f.val : value != null && Number(value) <= Number(f.val);
      case "in": return Array.isArray(f.val) && f.val.includes(value);
      case "ilike": {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        return typeof value === "string" && value.toLowerCase().includes(needle);
      }
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
  private countHead = false;
  private wantCount = false;

  constructor(private db: Record<string, Row[]>, private table: string, private nextStamp: () => string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.countHead = true; if (opts?.count) this.wantCount = true; return this; }
  insert(payload: Row | Row[]) { this.op = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.op = "update"; this.payload = payload; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ op: "gte", col, val }); return this; }
  lte(col: string, val: unknown) { this.filters.push({ op: "lte", col, val }); return this; }
  in(col: string, val: unknown) { this.filters.push({ op: "in", col, val }); return this; }
  like(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ op: "ilike", col, val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ op: "in", col, val: [true] }); return this; }
  or() { return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitN = n; return this; }

  private execute(single: boolean, maybe: boolean) {
    const rows = (this.db[this.table] ??= []);
    if (this.op === "insert" && Array.isArray(this.payload)) {
      for (const item of this.payload as Row[]) rows.push({ id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`, created_at: this.nextStamp(), ...item });
      return { data: null, error: null, count: null };
    }
    if (this.op === "insert") {
      const row: Row = { id: `row-${rows.length + 1}-${Math.random().toString(36).slice(2, 8)}`, created_at: this.nextStamp(), ...this.payload };
      rows.push(row);
      return { data: single || maybe ? row : null, error: null, count: null };
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
    if (single) return matched[0] ? { data: matched[0], error: null, count: null } : { data: null, error: { message: "no rows found" }, count: null };
    if (maybe) return { data: matched[0] ?? null, error: null, count: null };
    return { data: matched, error: null, count: this.wantCount ? matched.length : null };
  }

  single() { return Promise.resolve(this.execute(true, false)); }
  maybeSingle() { return Promise.resolve(this.execute(false, true)); }
  then<TResult1, TResult2>(
    onFulfilled?: ((value: ReturnType<FakeQuery["execute"]>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute(false, false)).then(onFulfilled, onRejected);
  }
}

function fakeClient(seed: Record<string, Row[]>): { client: SupabaseClient; db: Record<string, Row[]> } {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));
  let tick = 0;
  const base = Date.now();
  const nextStamp = () => new Date(base + tick++ * 1000).toISOString();
  const client = { from: (table: string) => new FakeQuery(db, table, nextStamp) } as unknown as SupabaseClient;
  return { client, db };
}

const fresh = () => new Date(Date.now() - 60_000).toISOString();

function baseSeed(): Record<string, Row[]> {
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false, deleted_at: null }],
    ai_capability_settings: [{ id: "cs-1", company_id: COMPANY, capability: "bot_chat", enabled: true, deleted_at: null }],
    telegram_messages: [],
    bot_memories: [],
    bot_pending_actions: [],
    loads: [],
    duty_logs: [],
    expenses: [],
    fuel_purchases: [],
    trucks: [{ id: "truck-1", company_id: COMPANY, unit_number: "101", deleted_at: null }],
    brokers: [],
    customers: [],
    drivers: [],
    documents: [],
    dispatch_exchanges: [],
    email_messages: [
      {
        id: MSG, company_id: COMPANY, mailbox: "owner", message_id: "<orig@broker.example>",
        from_address: "bob@broker.example", from_name: "Bob", reply_to: null,
        to_addresses: "owner@roadtolegacytrucking.com", subject: "Question about your trucking company",
        received_at: "2026-11-07T22:00:00Z", body_text: "Do you handle freight runs in central Florida?",
        attachments: [], classification: "other", summary: "Freight question",
        surfaced_at: "2026-11-07T22:05:00Z", digest_sent_at: null, linked_proposal_id: null, deleted_at: null,
      },
    ],
    email_drafts: [
      {
        id: DRAFT, company_id: COMPANY, email_message_id: MSG, to_address: "bob@broker.example",
        subject: "Re: Question about your trucking company", body: DRAFT_BODY, status: "draft",
        created_at: fresh(), send_error: null, sent_at: null, deleted_at: null,
      },
    ],
  };
}

function scriptedProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const runToolTurn = vi.fn(async () => {
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    return turn;
  });
  const provider: AgentCapableProvider = {
    complete: async () => { throw new Error("complete() is not used by the agent turn"); },
    runToolTurn,
  };
  return { provider, runToolTurn };
}

function neverCalledProvider() {
  const runToolTurn = vi.fn(async (): Promise<AiToolTurnResult> => {
    throw new Error("the model must not be called on this path");
  });
  const provider: AgentCapableProvider = {
    complete: async () => { throw new Error("complete() is not used by the agent turn"); },
    runToolTurn,
  };
  return { provider, runToolTurn };
}

function input(userText: string): BotChatInput {
  return { userText, history: [], snapshotText: null, instructions: [], memories: [] };
}

const telegramStore = (client: SupabaseClient): BotBrainStore => createBotStore(client, COMPANY, "telegram");
const livePending = (db: Record<string, Row[]>) => db.bot_pending_actions!.filter((r) => !r.deleted_at);

describe("the prompt no longer tells the model it cannot send", () => {
  it("EMAIL_RULES describes the real send flow", () => {
    expect(EMAIL_RULES).not.toMatch(/I cannot send/);
    expect(EMAIL_RULES).toContain("send_email proposal");
    expect(EMAIL_RULES).toMatch(/never answer a send request by drafting again/);
  });
});

describe("(a) 'Send' about a waiting draft stages the SEND proposal in code - not another draft-save", () => {
  it("stages exactly one send_email proposal for the saved draft + fingerprint, without any model call", async () => {
    const { client, db } = fakeClient(baseSeed());
    const { provider, runToolTurn } = neverCalledProvider();
    const out = await runAgentTurn(provider, telegramStore(client), input("Send"));
    expect(runToolTurn).not.toHaveBeenCalled();
    const waiting = livePending(db);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.tool_name).toBe("send_email");
    expect(waiting[0]!.arguments).toEqual({ draft_id: DRAFT, fingerprint: bodyFingerprint(DRAFT_BODY) });
    expect(out.reply).toContain("SEND this email");
    expect(out.reply).toContain("bob@broker.example");
    expect(out.reply).toContain(DRAFT_BODY);
    expect(out.reply).toContain("Reply YES to send it");
    expect(out.reply).not.toMatch(/Save an UNSENT reply draft/);
  });

  it("also fires for 'send it' / 'send the reply' wording", async () => {
    for (const text of ["send it", "Send the reply", "go ahead and send it"]) {
      const { client, db } = fakeClient(baseSeed());
      const { provider } = neverCalledProvider();
      await runAgentTurn(provider, telegramStore(client), input(text));
      expect(livePending(db).map((r) => r.tool_name), text).toEqual(["send_email"]);
    }
  });

  it("a non-send message stages nothing and goes to the model as before", async () => {
    const { client, db } = fakeClient(baseSeed());
    const { provider, runToolTurn } = scriptedProvider([{ text: "Two loads and a question.", toolCalls: [] }]);
    const out = await runAgentTurn(provider, telegramStore(client), input("what's new in the inbox?"));
    expect(runToolTurn).toHaveBeenCalled();
    expect(livePending(db)).toHaveLength(0);
    expect(out.reply).toContain("Two loads");
  });

  it("never stages a second send while one is already waiting - it reminds him instead", async () => {
    const seed = baseSeed();
    seed.bot_pending_actions = [
      { id: "w", company_id: COMPANY, channel: "telegram", tool_name: "send_email", arguments: { draft_id: DRAFT, fingerprint: bodyFingerprint(DRAFT_BODY) }, summary: `SEND this email from owner@ - To: bob@broker.example - Subject: Re: Question about your trucking company - Text: """${DRAFT_BODY}""" (draft ${DRAFT}, fingerprint ${bodyFingerprint(DRAFT_BODY)})`, created_at: fresh(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider } = scriptedProvider([{ text: "unrelated model text", toolCalls: [] }]);
    const out = await runAgentTurn(provider, telegramStore(client), input("Send"));
    expect(livePending(db)).toHaveLength(1);
    expect(out.reply).toContain("already lined up");
    expect(out.reply).toContain("Reply YES to send it");
  });

  it("a dispatch@ draft is never staged for sending (dispatch sending stays dormant)", async () => {
    const seed = baseSeed();
    seed.email_messages![0]!.mailbox = "dispatch";
    const { client, db } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([{ text: "That draft stays a draft - dispatch@ sending is off.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("Send"));
    expect(runToolTurn).toHaveBeenCalled();
    expect(livePending(db).filter((r) => r.tool_name === "send_email")).toHaveLength(0);
  });

  it("another proposal already waiting owns the turn - no send is staged over it", async () => {
    const seed = baseSeed();
    seed.bot_pending_actions = [
      { id: "w", company_id: COMPANY, channel: "telegram", tool_name: "create_expense", arguments: { category: "repairs", amount_dollars: 88 }, summary: "Expense: $88.00 (repairs)", created_at: fresh(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider, runToolTurn } = scriptedProvider([{ text: "The repair is still waiting.", toolCalls: [] }]);
    await runAgentTurn(provider, telegramStore(client), input("Send"));
    expect(runToolTurn).toHaveBeenCalled();
    expect(livePending(db).map((r) => r.tool_name)).toEqual(["create_expense"]);
  });
});

describe("(b) approving the staged proposal executes the send path exactly once", () => {
  const ENV = { IONOS_EMAIL_OWNER_USER: "owner@roadtolegacytrucking.com", IONOS_EMAIL_OWNER_PASSWORD: "pw-owner", IONOS_EMAIL_DISPATCH_USER: "dispatch@roadtolegacytrucking.com", IONOS_EMAIL_DISPATCH_PASSWORD: "pw-dispatch" };
  const NOW = new Date("2026-11-08T15:00:00Z");

  async function staged() {
    const store = memStore();
    const { id } = await store.insertMessage("owner", { messageId: "<orig@broker.example>", fromAddress: "bob@broker.example", fromName: "Bob", replyTo: null, toAddresses: null, subject: "Question about your trucking company", receivedAt: NOW.toISOString(), bodyText: "Do you run central Florida?", attachments: [] }, 1, "1");
    const draft = await store.createDraft(id, "bob@broker.example", "Re: Question about your trucking company", DRAFT_BODY);
    const delivered: { envelope: { from: string; to: string }; raw: Buffer }[] = [];
    const deps = {
      emailStore: store, now: () => NOW, env: ENV,
      deliver: vi.fn(async (_c: unknown, _s: unknown, envelope: { from: string; to: string }, raw: Buffer) => { delivered.push({ envelope, raw }); }),
      appendSent: vi.fn(async () => true),
      notify: vi.fn(async () => true),
    };
    const tools = buildEmailTools({ client: {}, companyId: "c" } as never, store, deps);
    const sendTool = tools.find((t) => t.name === "send_email")!;
    // Stage exactly the way agent-turn does: the tool's own verified summary + stored args.
    const fingerprint = bodyFingerprint(draft.body);
    const verdict = await sendTool.verifyProposal!({ draft_id: draft.id, fingerprint });
    expect(verdict.ok).toBe(true);
    return { store, draft, delivered, sendTool, args: { draft_id: draft.id, fingerprint } };
  }

  it("the YES path (executeWriteTool -> tool.run with the stored args) sends once; a second yes sends nothing", async () => {
    const { store, draft, delivered, sendTool, args } = await staged();
    const first = await sendTool.run(args);
    expect(first).toMatch(/^SENT from owner@ to bob@broker\.example/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.envelope).toEqual({ from: "owner@roadtolegacytrucking.com", to: "bob@broker.example" });
    expect(store.sent).toHaveLength(1);
    expect(store.drafts.find((d) => d.id === draft.id)!.status).toBe("sent");
    // a double yes (the stored-proposal path run twice) can never send twice
    const second = await sendTool.run(args);
    expect(second).toMatch(/NOT SENT:.*already sent/);
    expect(delivered).toHaveLength(1);
    expect(store.sent).toHaveLength(1);
  });

  it("an edit after staging voids the staged approval - the stored fingerprint no longer sends", async () => {
    const { store, draft, delivered, sendTool, args } = await staged();
    const tools = buildEmailTools({ client: {}, companyId: "c" } as never, store, {
      emailStore: store, now: () => NOW, env: ENV,
      deliver: vi.fn(async () => undefined), appendSent: vi.fn(async () => true), notify: vi.fn(async () => true),
    });
    await tools.find((t) => t.name === "revise_email_draft")!.run({ draft_id: draft.id, body: "Changed my mind - different text." });
    const refused = await sendTool.run(args);
    expect(refused).toMatch(/NOT SENT: The draft was changed after you approved it/);
    expect(delivered).toHaveLength(0);
    expect(store.sent).toHaveLength(0);
  });
});

describe("drafting saves in the turn it is asked for (no save proposal for his yes to eat)", () => {
  async function loopRun(userText: string, gateText: string) {
    const store = memStore();
    const { id } = await store.insertMessage("owner", { messageId: "<m@broker.example>", fromAddress: "bob@broker.example", fromName: "Bob", replyTo: null, toAddresses: null, subject: "Question", receivedAt: new Date().toISOString(), bodyText: "hi", attachments: [] }, 1, "1");
    const tools = gateExecutes(buildEmailTools({ client: {}, companyId: "c" } as never, store), gateText);
    const { provider, runToolTurn } = scriptedProvider([
      { text: null, toolCalls: [{ id: "c1", name: "draft_email_reply", arguments: JSON.stringify({ message_id: id, body: DRAFT_BODY, confirmation: "propose" }) }] },
      { text: "Here is the draft.", toolCalls: [] },
    ]);
    const out = await runAgentLoop({ provider, system: "", contextText: "", history: [], userText, tools });
    return { store, out, runToolTurn };
  }

  it("when his message names drafting, the draft is SAVED even if the model passes 'propose'", async () => {
    const { store, out, runToolTurn } = await loopRun("Draft a reply to the freight email", "Draft a reply to the freight email");
    expect(out.proposals).toHaveLength(0);
    expect(store.drafts).toHaveLength(1);
    expect(store.drafts[0]!.body).toBe(DRAFT_BODY);
    // the model saw the saved draft with its fingerprint - the thing a later send is staged from
    expect(JSON.stringify(runToolTurn.mock.calls[1] ?? [])).toContain("DRAFT (not sent)");
    expect(JSON.stringify(runToolTurn.mock.calls[1] ?? [])).toContain(bodyFingerprint(DRAFT_BODY));
  });

  it("when his message does NOT name drafting, the same call stays a proposal (gate unchanged)", async () => {
    const { store, out } = await loopRun("hmm, that email from Bob", "hmm, that email from Bob");
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]!.tool).toBe("draft_email_reply");
    expect(store.drafts).toHaveLength(0);
  });
});

describe("(c) the owner never sees model-facing instructions", () => {
  const d = { id: DRAFT, toAddress: "bob@broker.example", subject: "Re: Question about your trucking company", body: DRAFT_BODY };

  it("the owner-visible draft display carries no instructions to the model", () => {
    const shown = showDraft(d, "owner");
    expect(shown).toContain("To: bob@broker.example");
    expect(shown).toContain("Subject: Re: Question about your trucking company");
    expect(shown).toContain(DRAFT_BODY);
    expect(shown).toContain(bodyFingerprint(DRAFT_BODY));
    expect(shown).not.toMatch(/Show him|call send_email|call revise_email_draft|MODEL NOTE/i);
  });

  it("the model guidance lives in the separate model note, addressed to the model", () => {
    const note = draftModelNote(d, "owner");
    expect(note).toMatch(/^MODEL NOTE/);
    expect(note).toContain(DRAFT);
    expect(note).toContain(bodyFingerprint(DRAFT_BODY));
    expect(draftModelNote(d, "dispatch")).toBe(""); // dormant mailbox: nothing to stage
  });

  it("stripModelOnlyLines removes legacy instruction lines from an executed result", () => {
    const legacy = [
      "DRAFT (not sent) - id x - fingerprint abc",
      "--- BODY ---",
      "hello",
      "--- END ---",
      "Show him all of this. Nothing is sent until he says to send THIS text: then call send_email with this draft id and fingerprint (it is a proposal he approves). If he wants a change, call revise_email_draft.",
      "MODEL NOTE (never quote this to him): the draft above is SAVED.",
    ].join("\n");
    const clean = stripModelOnlyLines(legacy);
    expect(clean).toContain("hello");
    expect(clean).not.toMatch(/Show him|call send_email|MODEL NOTE/i);
  });

  it("the confirmation he reads after YES-ing a draft save contains the draft and NO model instructions", async () => {
    const seed = baseSeed();
    seed.email_drafts = [];
    seed.bot_pending_actions = [
      { id: "p1", company_id: COMPANY, channel: "telegram", tool_name: "draft_email_reply", arguments: { message_id: MSG, body: DRAFT_BODY }, summary: `Save an UNSENT reply draft (nothing is sent): "${DRAFT_BODY.slice(0, 60)}"`, created_at: fresh(), deleted_at: null },
    ];
    const { client, db } = fakeClient(seed);
    const { provider } = neverCalledProvider();
    const out = await runAgentTurn(provider, telegramStore(client), input("yes"));
    expect(db.email_drafts!.filter((r) => !r.deleted_at)).toHaveLength(1); // the save itself executed
    expect(out.reply).toContain("(not sent) - id"); // resolvePending lowercases the result's first letter ("dRAFT...") - pre-existing casing
    expect(out.reply).toContain(DRAFT_BODY);
    expect(out.reply).not.toMatch(/Show him|call send_email|call revise_email_draft|MODEL NOTE/i);
  });
});
