// Abel forward-fix (docs/design/driver-mvp.md §11). The staging
// bridge between the dispatch helper's extraction and the bot's
// propose->yes batches: items are validated in code (real tool,
// verbatim quote, numbers traced to the message) before they are
// stored in bot_pending_actions, and a waiting proposal blocks new
// staging so batches never mix their item numbers.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import { stageRecordables } from "@/services/bot/stage-recordables";

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

  it("blocks staging while another proposal is waiting, so batches never mix", async () => {
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

    expect(result.blockedByPending).toBe(true);
    expect(result.proposals).toEqual([]);
    expect(rows).toHaveLength(1); // only the pre-existing row
  });

  it("is a no-op for an empty extraction", async () => {
    const { store, rows } = makeStore();
    const result = await stageRecordables(store, MESSAGE, []);
    expect(result).toEqual({ proposals: [], rejected: [], blockedByPending: false });
    expect(rows).toHaveLength(0);
  });
});
