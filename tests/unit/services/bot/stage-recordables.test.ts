// Abel forward-fix (docs/design/driver-mvp.md §11). The staging
// bridge between the dispatch helper's extraction and the bot's
// propose->yes batches: items are validated in code (real tool,
// verbatim quote, numbers traced to the message) before they are
// stored in bot_pending_actions, and a waiting proposal blocks new
// staging so batches never mix their item numbers.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { formatRecordableOutcome, stageRecordables } from "@/services/bot/stage-recordables";

type Row = Record<string, unknown>;

const COMPANY = "44444444-4444-4444-8444-444444444444";

/** Minimal thenable query fake - just the chains the pending-action store uses. */
class FakePendingQuery {
  constructor(private readonly rows: Row[]) {}

  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  is(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  insert(row: Row): Promise<{ error: null }> {
    this.rows.push({
      ...row,
      id: `pending-${this.rows.length + 1}`,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });
    return Promise.resolve({ error: null });
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onFulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const visible = this.rows.filter((r) => !r.deleted_at);
    return Promise.resolve({ data: visible, error: null }).then(onFulfilled, onRejected);
  }
}

// A broker lookup fake: the trip path resolves the broker NAME to an id in code.
function makeStoreWithBrokers(brokers: Row[], seed: Row[] = []) {
  const rows = [...seed];
  const client = {
    from: (table: string) => {
      if (table === "bot_pending_actions") return new FakePendingQuery(rows);
      if (table === "brokers") {
        const q = { select: () => q, eq: () => q, is: () => q, ilike: async () => ({ data: brokers, error: null }) };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { store: createBotStore(client, COMPANY, "telegram"), rows };
}

function makeStore(seed: Row[] = []): { store: BotBrainStore; rows: Row[] } {
  const rows = [...seed];
  const client = {
    from: (table: string) => {
      if (table !== "bot_pending_actions") throw new Error(`unexpected table ${table}`);
      return new FakePendingQuery(rows);
    },
  } as unknown as SupabaseClient;
  return { store: createBotStore(client, COMPANY, "telegram"), rows };
}

const MESSAGE = "Load from Savannah, GA to Atlanta, GA paying $1,800, pickup tomorrow morning.";

const LOAD_ITEM = {
  tool_name: "create_load",
  args: { origin: "Savannah, GA", destination: "Atlanta, GA", rate_dollars: 1800 },
  source_quote: "Load from Savannah, GA to Atlanta, GA paying $1,800",
  confidence: "high",
};

describe("stageRecordables", () => {
  it("stages a grounded item as a numbered batch row, recording nothing itself", async () => {
    const { store, rows } = makeStore();
    const result = await stageRecordables(store, MESSAGE, [LOAD_ITEM]);

    expect(result.blockedByPending).toBe(false);
    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool_name).toBe("create_load");
    expect(rows[0]?.item_number).toBe(1);
    expect(rows[0]?.batch_id).toBeTruthy();
    expect(String(rows[0]?.summary)).toContain("Savannah, GA → Atlanta, GA");
  });

  it("rejects an item whose rate appears nowhere in the message - and stages nothing", async () => {
    const { store, rows } = makeStore();
    const invented = {
      ...LOAD_ITEM,
      args: { ...LOAD_ITEM.args, rate_dollars: 2500 },
    };
    const result = await stageRecordables(store, MESSAGE, [invented]);

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("2500");
    expect(rows).toHaveLength(0);
  });

  // Lane 1 (audit B-7): a waiting proposal used to BLOCK staging -
  // the new forward's items were dropped unless he re-sent the
  // message. Now the batch QUEUES behind the waiting one (its own
  // batch id, its own item numbers); resolution still only ever
  // addresses the oldest pending proposal first.
  it("queues a new batch behind a waiting proposal instead of dropping it", async () => {
    const waiting: Row = {
      id: "pending-0",
      company_id: COMPANY,
      channel: "telegram",
      tool_name: "create_expense",
      arguments: { category: "other", amount_dollars: 40 },
      summary: "Expense $40",
      batch_id: null,
      item_number: null,
      source_quote: null,
      confidence: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    const { store, rows } = makeStore([waiting]);
    const result = await stageRecordables(store, MESSAGE, [LOAD_ITEM]);

    expect(result.blockedByPending).toBe(false);
    expect(result.queuedBehindPending).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.tool_name).toBe("create_load");
    expect(rows[1]?.batch_id).toBeTruthy();
    expect(rows[1]?.batch_id).not.toBe(rows[0]?.batch_id);
    expect(rows[1]?.item_number).toBe(1);
  });

  it("one rule (telegram audit P0-5): the new batch is the one a YES answers; the earlier proposal is named, not hidden", async () => {
    const waiting: Row = {
      id: "pending-0",
      company_id: COMPANY,
      channel: "telegram",
      tool_name: "create_expense",
      arguments: { category: "other", amount_dollars: 40 },
      summary: "Expense $40",
      batch_id: null,
      item_number: null,
      source_quote: null,
      confidence: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    const { store } = makeStore([waiting]);
    const result = await stageRecordables(store, MESSAGE, [LOAD_ITEM]);
    const text = formatRecordableOutcome(result);
    expect(text).not.toContain("settle that one first");
    expect(text).toContain("A YES now answers the list above");
    expect(text).toContain("Expense $40");
    expect(result.earlierPending).toBe("Expense $40");
  });

  it("is a no-op for an empty extraction", async () => {
    const { store, rows } = makeStore();
    const result = await stageRecordables(store, MESSAGE, []);
    expect(result).toEqual({ proposals: [], rejected: [], blockedByPending: false, queuedBehindPending: false });
    expect(rows).toHaveLength(0);
  });

  it("a structured trip assignment is read by code: one proposal with trip fields, broker id, stops, tasks, and a clean review", async () => {
    const BROKER = "55555555-5555-4555-8555-555555555555";
    const { store, rows } = makeStoreWithBrokers([{ id: BROKER, name: "Example Logistics" }]);
    const msg = `NEW TRIP 1234 HAS BEEN ASSIGNED
STOP 1
SHIPPER/CONSIGNEE: Example Steel Co
ADDRESS: 100 Example Way, Springfield, MO 65801
APPT: 11/04/2026 00:00 CST
TYPE: Pickup Stop
STOP 2
SHIPPER/CONSIGNEE: Sample County Recycling
ADDRESS: 200 Sample Road , Tampa, FL 33601
APPT: 11/05/2026 00:00 EST
TYPE: Delivery Stop
TRIP DETAILS
BROKER: Example Logistics
REF #: REF123456
DEADHEAD: 120.00 mi
LOADED DISTANCE: 900.50 mi
TOTAL DISTANCE: 1,000.50 mi
❗️SEND SEAL PICTURE`;
    // The model proposed a broken create_load (no origin) - code replaces it.
    const result = await stageRecordables(store, msg, [{ tool_name: "create_load", args: {}, source_quote: "NEW TRIP 1234", confidence: "low" }]);
    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arguments).toMatchObject({
      origin: "Springfield, MO", destination: "Tampa, FL", trip_number: "1234", broker_id: BROKER,
      broker_reference: "REF123456", deadhead_miles: 120, loaded_miles: 900.5,
    });
    expect((rows[0]!.arguments as { stops: unknown[] }).stops).toHaveLength(2);
    expect(result.review).toContain("NEW TRIP 1234");
    expect(result.review).toContain("Example Steel Co");
    expect(result.review).toContain("11/04/2026 00:00 CST");
    expect(result.review).toContain("SEND SEAL PICTURE");
  });

  it("an unknown broker is saved without a broker link and the review says so - never a name in an id field", async () => {
    const { store, rows } = makeStoreWithBrokers([]);
    const result = await stageRecordables(
      store,
      "NEW TRIP 9 HAS BEEN ASSIGNED\nSTOP 1\nSHIPPER/CONSIGNEE: A\nADDRESS: 1 Main St, Dallas, TX 75001\nAPPT: 12/01/2026 08:00 CST\nTYPE: Pickup Stop\nSTOP 2\nSHIPPER/CONSIGNEE: B\nADDRESS: 2 Main St, Tulsa, OK 74101\nAPPT: 12/01/2026 14:00 CST\nTYPE: Delivery Stop\nTRIP DETAILS\nBROKER: Nobody Freight\nREF #: X1",
      [],
    );
    expect(result.proposals).toHaveLength(1);
    expect((rows[0]!.arguments as Record<string, unknown>).broker_id).toBeUndefined();
    expect(result.review).toContain("not on file yet");
  });
});
