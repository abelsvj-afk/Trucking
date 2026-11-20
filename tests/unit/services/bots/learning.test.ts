// Corrections-learning for the bot team: a bot corrected twice on
// the same field earns a durable watch-out in its OWN memory — the
// same rule Abel lives under (threshold 2, Abel's counting code) —
// and one bot's lessons never leak into another bot's memory.
import { describe, expect, it } from "vitest";
import { botCorrectedFields, botWatchoutsBlock, recordBotCorrection } from "@/services/bots/learning";
import type { BotSlug } from "@/services/bots/registry";
import type { BotMemoryRow, BotTeamStore, ProposalRow } from "@/services/bots/store";

interface MemoryState {
  rows: BotMemoryRow[];
}

function makeMemoryStore(state: MemoryState): BotTeamStore {
  let seq = 0;
  const unused = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  return {
    companyId: "company-1",
    createProposal: unused,
    listOpenProposals: async () => [] as ProposalRow[],
    getProposal: async () => null,
    decideProposal: unused,
    logAudit: async () => {},
    hasAuditorCheck: async () => false,
    recordLoadOutcome: async () => {},
    ensureGroupRoom: async () => {},
    recordGroupMessage: async () => {},
    findGroupMessage: async () => null,
    recordSpend: async () => {},
    spentThisMonthCents: async () => 0,
    loadBotMemories: async (botSlug: BotSlug) =>
      state.rows.filter((row) => row.bot_slug === botSlug).slice().reverse(),
    saveBotMemory: async (input) => {
      const row: BotMemoryRow = {
        id: `memory-${++seq}`,
        bot_slug: input.botSlug,
        kind: input.kind,
        content: input.content,
        source: input.source ?? "bot",
        created_at: new Date().toISOString(),
      };
      state.rows.push(row);
      return row;
    },
  };
}

describe("recordBotCorrection", () => {
  it("writes the correction in Abel's summary format", async () => {
    const state: MemoryState = { rows: [] };
    const store = makeMemoryStore(state);
    const result = await recordBotCorrection(store, "dispatch-scout", ["rate", "delivery_city"]);
    expect(result.newWatchouts).toEqual([]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.kind).toBe("correction");
    expect(state.rows[0]?.content).toBe("corrected fields: delivery_city, rate");
  });

  it("the second correction on the same field stores exactly one watch-out", async () => {
    const state: MemoryState = { rows: [] };
    const store = makeMemoryStore(state);
    await recordBotCorrection(store, "dispatch-scout", ["rate"]);
    const second = await recordBotCorrection(store, "dispatch-scout", ["rate"]);
    expect(second.newWatchouts).toEqual([{ field: "rate", count: 2 }]);
    const watchouts = state.rows.filter((row) => row.kind === "watch-out");
    expect(watchouts).toHaveLength(1);
    expect(watchouts[0]?.bot_slug).toBe("dispatch-scout");
    expect(watchouts[0]?.content).toContain("rate: corrected 2 times");

    const third = await recordBotCorrection(store, "dispatch-scout", ["rate"]);
    expect(third.newWatchouts).toEqual([]);
    expect(state.rows.filter((row) => row.kind === "watch-out")).toHaveLength(1);
  });

  it("keeps each bot's lessons in its own seat — Scout's corrections never become Billing's watch-outs", async () => {
    const state: MemoryState = { rows: [] };
    const store = makeMemoryStore(state);
    await recordBotCorrection(store, "dispatch-scout", ["rate"]);
    await recordBotCorrection(store, "dispatch-scout", ["rate"]);
    expect(botCorrectedFields(await store.loadBotMemories("dispatch-scout"))).toEqual([{ field: "rate", count: 2 }]);
    expect(botCorrectedFields(await store.loadBotMemories("billing"))).toEqual([]);
    expect(botWatchoutsBlock(await store.loadBotMemories("billing"))).toBeNull();
    expect(state.rows.filter((row) => row.bot_slug === "billing")).toHaveLength(0);
  });

  it("an empty correction records nothing", async () => {
    const state: MemoryState = { rows: [] };
    const store = makeMemoryStore(state);
    expect(await recordBotCorrection(store, "abel", ["", "  "])).toEqual({ newWatchouts: [] });
    expect(state.rows).toHaveLength(0);
  });
});

describe("botWatchoutsBlock", () => {
  it("is null below the threshold and Abel-worded at it", async () => {
    const state: MemoryState = { rows: [] };
    const store = makeMemoryStore(state);
    await recordBotCorrection(store, "tracker", ["eta"]);
    expect(botWatchoutsBlock(await store.loadBotMemories("tracker"))).toBeNull();
    await recordBotCorrection(store, "tracker", ["eta"]);
    const block = botWatchoutsBlock(await store.loadBotMemories("tracker"));
    expect(block).toContain("WATCH-OUTS FROM HIS OWN CORRECTIONS");
    expect(block).toContain("- eta: corrected 2 times");
  });
});
