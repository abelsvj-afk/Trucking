// place_call + list_outbound_calls - docs/design/outbound-calling.md.
// Fake Supabase (in-memory rows) and fake Telnyx fetch: the live API is
// never hit, and no call is ever really dialed.
import { describe, expect, it, vi } from "vitest";
import type { BotBrainStore } from "@/services/bot/store";
import { buildOutboundCallTools } from "@/services/bot/outbound-call-tools";
import type { CallingConfig } from "@/services/calling/config";

type Row = Record<string, unknown>;

function makeFakeClient(seed: Record<string, Row[]>) {
  const db: Record<string, Row[]> = seed;
  return {
    _db: db,
    from(table: string) {
      const rows = (db[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;
      let inserted: Row | null = null;
      let patch: Row | null = null;
      const builder: Record<string, unknown> & {
        then: (resolve: (v: unknown) => void) => void;
      } = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          orderBy = { col, asc: opts.ascending };
          return builder;
        },
        limit: (n: number) => {
          limitN = n;
          return builder;
        },
        insert: (row: Row) => {
          inserted = {
            ...row,
            id: `call-${rows.length + 1}`,
            telnyx_call_control_id: null,
            telnyx_conversation_id: null,
            transcript: null,
            outcome: null,
            started_at: null,
            ended_at: null,
            duration_seconds: null,
            created_at: "2026-11-17T15:30:00.000Z",
            updated_at: "2026-11-17T15:30:00.000Z",
            deleted_at: null,
          };
          rows.push(inserted);
          return builder;
        },
        update: (values: Row) => {
          patch = values;
          return builder;
        },
        single: async () => {
          const found = apply();
          if (inserted) return { data: inserted, error: null };
          if (patch && found[0]) Object.assign(found[0], patch);
          return found[0] ? { data: found[0], error: null } : { data: null, error: { message: "not found" } };
        },
        maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          const found = apply();
          if (patch) found.forEach((r) => Object.assign(r, patch));
          resolve({ data: found, error: null });
        },
      };
      function apply() {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, b) => {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            return av < bv ? (asc ? -1 : 1) : av > bv ? (asc ? 1 : -1) : 0;
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        return out;
      }
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "claim_next_outbound_call") return { data: null, error: { message: `unknown rpc ${name}` } };
      const calls = db.outbound_calls ?? [];
      if (calls.some((c) => c.company_id === args.p_company_id && (c.status === "dialing" || c.status === "in_progress") && !c.deleted_at)) {
        return { data: null, error: null };
      }
      const next = calls
        .filter((c) => c.company_id === args.p_company_id && c.status === "queued" && !c.deleted_at)
        .sort((a, b) => (a.created_at as string) < (b.created_at as string) ? -1 : 1)[0];
      if (!next) return { data: null, error: null };
      next.status = "dialing";
      next.updated_at = new Date().toISOString();
      return { data: next, error: null };
    },
  };
}

const CONFIG: CallingConfig = {
  telnyxApiKey: "test-key",
  phoneNumber: "+15551234567",
  connectionId: "conn-1",
  assistantId: "asst-1",
  publicKey: null,
};

function makeStore(client: ReturnType<typeof makeFakeClient>) {
  return { client, companyId: "company-1" } as unknown as BotBrainStore;
}

function seed(callingOn = true, extraCalls: Row[] = []) {
  return makeFakeClient({
    companies: [{ id: "company-1", ai_globally_disabled: false, call_voice_id: null }],
    ai_capability_settings: callingOn
      ? [{ company_id: "company-1", capability: "outbound_calling", enabled: true }]
      : [],
    drivers: [{ id: "driver-1", company_id: "company-1", name: "Marcus", phone: "(555) 987-6543", deleted_at: null }],
    brokers: [],
    customers: [],
    outbound_calls: [...extraCalls],
  });
}

function fakeTelnyx() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("/v2/calls")) {
      return { ok: true, status: 200, json: async () => ({ data: { call_control_id: "cc-1" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
  return { fetchImpl, calls };
}

const ARGS = { to_phone: "(555) 987-6543", purpose: "ETA check on Trip 1903", say: "Ask when he gets there." };

describe("place_call validateArgs", () => {
  it("normalizes the number and refuses a bad one, an empty purpose, or an overlong say", async () => {
    const tools = buildOutboundCallTools(makeStore(seed()), { config: CONFIG });
    const place = tools.find((t) => t.name === "place_call")!;
    expect(place.validateArgs!(ARGS)).toEqual({
      ok: true,
      args: { ...ARGS, to_phone: "+15559876543" },
    });
    expect(place.validateArgs!({ ...ARGS, to_phone: "911" })).toMatchObject({ ok: false });
    expect(place.validateArgs!({ ...ARGS, purpose: " " })).toMatchObject({ ok: false });
    expect(place.validateArgs!({ ...ARGS, say: "x".repeat(2001) })).toMatchObject({ ok: false });
  });
});

describe("place_call verifyProposal", () => {
  it("names the driver when calling is on and the number is on file", async () => {
    const tools = buildOutboundCallTools(makeStore(seed()), { config: CONFIG });
    const place = tools.find((t) => t.name === "place_call")!;
    const result = await place.verifyProposal!({ ...ARGS, to_phone: "+15559876543" });
    expect(result).toEqual({
      ok: true,
      summary: "Call Marcus (driver) at (555) 987-6543 — ETA check on Trip 1903",
    });
  });

  it("refuses when the capability is off, and refuses a number the app doesn't know", async () => {
    const offTools = buildOutboundCallTools(makeStore(seed(false)), { config: CONFIG });
    const off = offTools.find((t) => t.name === "place_call")!;
    expect(await off.verifyProposal!({ ...ARGS, to_phone: "+15559876543" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("switched off"),
    });
    const tools = buildOutboundCallTools(makeStore(seed()), { config: CONFIG });
    const place = tools.find((t) => t.name === "place_call")!;
    expect(await place.verifyProposal!({ ...ARGS, to_phone: "+15552223333" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("don't have"),
    });
  });
});

describe("place_call run", () => {
  it("dials the known driver through the fake Telnyx client and marks the call in progress", async () => {
    const client = seed();
    const { fetchImpl, calls } = fakeTelnyx();
    const tools = buildOutboundCallTools(makeStore(client), { config: CONFIG, fetchImpl: fetchImpl as never });
    const place = tools.find((t) => t.name === "place_call")!;
    const result = await place.run!({ ...ARGS, to_phone: "+15559876543" });
    expect(result).toContain("Calling Marcus ((555) 987-6543) now");
    expect(calls).toContain("https://api.telnyx.com/v2/calls");
    expect(calls).toContain("https://api.telnyx.com/v2/calls/cc-1/actions/ai_assistant_start");
    const row = (client._db.outbound_calls ?? [])[0];
    expect(row).toBeDefined();
    expect(row!.status).toBe("in_progress");
    expect(row!.telnyx_call_control_id).toBe("cc-1");
  });

  it("queues when another call is already on the line and dials nothing", async () => {
    const client = seed(true, [
      {
        id: "call-0",
        company_id: "company-1",
        status: "in_progress",
        to_number: "+15552223333",
        to_name: "Someone",
        purpose: "x",
        say: "y",
        created_at: "2026-11-17T15:00:00.000Z",
        deleted_at: null,
      },
    ]);
    const { fetchImpl, calls } = fakeTelnyx();
    const tools = buildOutboundCallTools(makeStore(client), { config: CONFIG, fetchImpl: fetchImpl as never });
    const place = tools.find((t) => t.name === "place_call")!;
    const result = await place.run!({ ...ARGS, to_phone: "+15559876543" });
    expect(result).toContain("another call is in progress");
    expect(calls).toEqual([]);
    expect(client._db.outbound_calls).toHaveLength(2);
    expect((client._db.outbound_calls ?? [])[1]!.status).toBe("queued");
  });

  it("dials nothing when the capability is off or the number is unknown", async () => {
    const { fetchImpl, calls } = fakeTelnyx();
    const offTools = buildOutboundCallTools(makeStore(seed(false)), { config: CONFIG, fetchImpl: fetchImpl as never });
    const off = offTools.find((t) => t.name === "place_call")!;
    expect(await off.run!({ ...ARGS, to_phone: "+15559876543" })).toContain("switched off");
    const tools = buildOutboundCallTools(makeStore(seed()), { config: CONFIG, fetchImpl: fetchImpl as never });
    const place = tools.find((t) => t.name === "place_call")!;
    expect(await place.run!({ ...ARGS, to_phone: "+15552223333" })).toContain("don't have");
    expect(calls).toEqual([]);
  });
});

describe("list_outbound_calls", () => {
  it("lists recent calls with Eastern times and the outcome, or says there are none", async () => {
    const client = seed(true, [
      {
        id: "call-0",
        company_id: "company-1",
        status: "completed",
        to_number: "+15559876543",
        to_name: "Marcus",
        purpose: "ETA check on Trip 1903",
        outcome: "He said 6 PM.",
        transcript: "Yes, 6 PM.",
        created_at: "2026-11-17T15:30:00.000Z",
        deleted_at: null,
      },
    ]);
    const tools = buildOutboundCallTools(makeStore(client), { config: CONFIG });
    const list = tools.find((t) => t.name === "list_outbound_calls")!;
    const result = await list.run!({});
    expect(result).toContain("Marcus ((555) 987-6543)");
    expect(result).toContain("completed");
    expect(result).toContain("He said 6 PM.");
    expect(result).toContain("ET");
    expect(result).not.toContain("UTC");

    const empty = buildOutboundCallTools(makeStore(seed()), { config: CONFIG });
    expect(await empty.find((t) => t.name === "list_outbound_calls")!.run!({})).toBe("No calls yet.");
  });
});

// Audit F-005/F-016: the kill switch is read by the DIALER, right before
// Telnyx, so a call queued while calling was on never dials after it is
// switched off — whichever route (tool, webhook queue drain, retry) reaches it.
describe("dialOutboundCallRow kill switch", () => {
  const queued: Row = {
    id: "call-q", company_id: "company-1", to_number: "+15559876543", to_name: "Marcus",
    purpose: "ETA check", say: "Ask when he gets there.", status: "dialing",
    created_at: "2026-11-17T15:00:00.000Z", deleted_at: null,
  };

  it("switched off with a queued call: nothing is dialed and the row says why", async () => {
    const { dialOutboundCallRow } = await import("@/services/calling/dialer");
    const client = seed(false, [{ ...queued }]);
    const { fetchImpl } = fakeTelnyx();
    const result = await dialOutboundCallRow(client as never, { ...queued } as never, { config: CONFIG, fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client._db.outbound_calls[0]).toMatchObject({ status: "failed" });
    expect(String(client._db.outbound_calls[0].outcome)).toMatch(/^Not dialed: Outbound calling is switched off/);
  });

  it("global AI off also stops the dial", async () => {
    const { dialOutboundCallRow } = await import("@/services/calling/dialer");
    const client = seed(true, [{ ...queued }]);
    client._db.companies[0].ai_globally_disabled = true;
    const { fetchImpl } = fakeTelnyx();
    const result = await dialOutboundCallRow(client as never, { ...queued } as never, { config: CONFIG, fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("switched on: it dials", async () => {
    const { dialOutboundCallRow } = await import("@/services/calling/dialer");
    const client = seed(true, [{ ...queued }]);
    const { fetchImpl } = fakeTelnyx();
    const result = await dialOutboundCallRow(client as never, { ...queued } as never, { config: CONFIG, fetchImpl: fetchImpl as never });
    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
