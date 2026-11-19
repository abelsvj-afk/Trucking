// Bots' corrections-learning: a field fixed twice becomes a
// watch-out, read into every turn — Abel's mechanism, shared.
import { describe, expect, it } from "vitest";
import {
  botMemoriesBlock,
  botWatchoutsBlock,
  BOT_WATCHOUT_THRESHOLD,
  recentOutcomesBlock,
  recordBotCorrection,
} from "@/services/bots/outcomes";
import type { BotMemoryRow, BotTeamStore } from "@/services/bots/store";

function makeStore(memories: BotMemoryRow[] = []): { store: BotTeamStore; memories: BotMemoryRow[] } {
  let seq = 0;
  const store: BotTeamStore = {
    companyId: "company-1",
    createProposal: async () => {
      throw new Error("unused in this test");
    },
    listOpenProposals: async () => [],
    getProposal: async () => null,
    decideProposal: async () => {
      throw new Error("unused in this test");
    },
    logAudit: async () => {},
    recordLoadOutcome: async () => {},
    ensureGroupRoom: async () => {},
    recordGroupMessage: async () => {},
    recordSpend: async () => {},
    spentThisMonthCents: async () => 0,
    loadBotMemories: async () => [...memories],
    saveBotMemory: async (input) => {
      const row: BotMemoryRow = {
        id: `memory-${++seq}`,
        bot_slug: input.botSlug,
        kind: input.kind,
        content: input.content,
        source: input.source,
        created_at: new Date().toISOString(),
      };
      memories.push(row);
      return row;
    },
    loadRecentGroupMessages: async () => [],
    loadRecentLoadOutcomes: async () => [],
  };
  return { store, memories };
}

describe("bot corrections-learning", () => {
  it("records the first correction without a watch-out", async () => {
    const { store, memories } = makeStore();
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "pay", detail: "pay did not match miles x rate" });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.kind).toBe("correction");
    expect(BOT_WATCHOUT_THRESHOLD).toBe(2);
  });

  it("writes the watch-out on the second correction of the same field, once", async () => {
    const { store, memories } = makeStore();
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "pay", detail: "first miss" });
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "pay", detail: "second miss" });
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "pay", detail: "third miss" });
    expect(memories.filter((row) => row.kind === "correction")).toHaveLength(3);
    expect(memories.filter((row) => row.kind === "watch-out")).toHaveLength(1);
    expect(memories.find((row) => row.kind === "watch-out")!.content).toContain('field "pay"');
  });

  it("does not write a watch-out for a different field", async () => {
    const { store, memories } = makeStore();
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "pay", detail: "miss" });
    await recordBotCorrection(store, { botSlug: "dispatch-scout", field: "miles", detail: "miss" });
    expect(memories.filter((row) => row.kind === "watch-out")).toHaveLength(0);
  });

  it("renders memories and watch-outs as separate context blocks", () => {
    const rows: BotMemoryRow[] = [
      { id: "1", bot_slug: "tracker", kind: "fact", content: "Detention starts after 2h free.", source: "seed", created_at: "" },
      { id: "2", bot_slug: "tracker", kind: "rule", content: "Always confirm the POD.", source: "seed", created_at: "" },
      { id: "3", bot_slug: "tracker", kind: "correction", content: 'field "pay" — corrected: wrong.', source: "seed", created_at: "" },
    ];
    const memories = botMemoriesBlock(rows);
    expect(memories).toContain("Detention starts after 2h free.");
    expect(memories).toContain("Always confirm the POD.");
    expect(memories).not.toContain('field "pay"');
    const watchouts = botWatchoutsBlock(rows);
    expect(watchouts).toContain('field "pay"');
    expect(botMemoriesBlock([])).toBeNull();
    expect(botWatchoutsBlock([])).toBeNull();
  });

  it("renders recent load outcomes with lane, outcome, and pay", () => {
    const block = recentOutcomesBlock([
      {
        load_ref: "load-1",
        broker_name: "FastFreight",
        origin: "Dallas",
        destination: "Houston",
        rate_cents_per_loaded_mile: 200,
        loaded_miles: 240,
        deadhead_miles: 30,
        pay_cents: 48000,
        outcome: "booked",
        notes: null,
        created_at: "",
      },
    ]);
    expect(block).toContain("Dallas → Houston");
    expect(block).toContain("booked");
    expect(block).toContain("$480.00");
    expect(block).toContain("FastFreight");
    expect(recentOutcomesBlock([])).toBeNull();
  });
});
