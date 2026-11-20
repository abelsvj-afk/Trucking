// Dispatch Scout scan run: boards walked in order at human pace,
// shortlist proposed, ledger written for what was skipped, nothing
// booked. The browser is a fake here — no network, no live board.
import { describe, expect, it } from "vitest";
import {
  parseCostPreferences,
  parseScanRequest,
  recordShortlistDecision,
  runScoutScan,
  type ScoutScanDeps,
  type ScoutScanInput,
} from "@/services/bots/dispatch-scout";
import type { BoardReadResult, BrowserRuntime } from "@/services/bots/browser-runtime";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";
import { shortlistProposalPayload, buildShortlist } from "@/services/bots/shortlist";

function makeRuntime(results: Record<string, BoardReadResult>): BrowserRuntime {
  return {
    route: "shared-vm",
    readBoard: async (boardSlug: string): Promise<BoardReadResult> =>
      results[boardSlug] ?? { boardSlug, status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
    watchUrl: (runId: string): string | null => `https://browser.example/watch/${runId}`,
    stopRun: async () => ({ stopped: true, reason: "Stopped." }),
  };
}

const NOT_CONFIGURED_RUNTIME: BrowserRuntime = {
  route: "not-configured",
  readBoard: async (boardSlug: string): Promise<BoardReadResult> => ({
    boardSlug,
    status: "not-configured",
    loads: [],
    note: "The shared browser is not configured on the server yet — no board was read.",
    readAtIso: new Date().toISOString(),
  }),
  watchUrl: (): string | null => null,
  stopRun: async () => ({ stopped: false, reason: "Not configured." }),
};

interface StubState {
  proposals: ProposalRow[];
  ledger: { loadRef: string; outcome: string; notes: string | null }[];
  audit: string[];
}

function makeStore(state: StubState): BotTeamStore {
  let seq = 0;
  return {
    companyId: "company-1",
    createProposal: async (input) => {
      const row: ProposalRow = {
        id: `proposal-${++seq}`,
        company_id: "company-1",
        bot_slug: input.botSlug,
        kind: input.kind,
        title: input.title,
        payload: input.payload,
        source_ref: input.sourceRef ?? null,
        status: "proposed",
        created_at: new Date().toISOString(),
        decided_at: null,
        decided_by: null,
      };
      state.proposals.push(row);
      return row;
    },
    listOpenProposals: async (limit = 20) => state.proposals.filter((p) => p.status === "proposed").slice(0, limit),
    getProposal: async (id) => state.proposals.find((p) => p.id === id) ?? null,
    decideProposal: async (id, decision, decidedBy) => {
      const row = state.proposals.find((p) => p.id === id);
      if (!row) throw new Error(`proposal ${id} not found`);
      if (row.status !== "proposed") return row;
      row.status = decision;
      row.decided_at = new Date().toISOString();
      row.decided_by = decidedBy;
      return row;
    },
    logAudit: async (input) => {
      state.audit.push(input.action);
    },
    hasAuditorCheck: async () => false,
    recordLoadOutcome: async (input) => {
      state.ledger.push({ loadRef: input.loadRef, outcome: input.outcome, notes: input.notes ?? null });
    },
    ensureGroupRoom: async () => {},
    recordGroupMessage: async () => {},
    findGroupMessage: async () => null,
    reserveSpend: async () => "reservation-1",
    settleSpend: async () => {},
    saveBotMemory: async (input) => ({
      id: "memory-new",
      bot_slug: input.botSlug,
      kind: input.kind,
      content: input.content,
      source: input.source ?? "bot",
      created_at: new Date().toISOString(),
    }),
    loadBotMemories: async () => [],
  };
}

const BASE_INPUT: ScoutScanInput = {
  origin: "Panama City, FL",
  costPerMileCents: 120,
  floorPerAllMileCents: 100,
  dieselCentsPerGallon: 600,
  mpg: 7,
  runId: "run-1",
};

function trulosRows(): unknown[] {
  return [
    {
      origin: "Panama City, FL",
      destination: "Atlanta, GA",
      rate: "$1,850",
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupDate: "2026-11-20",
      brokerName: "Acme Logistics",
      brokerCreditScore: 80,
      brokerDaysToPay: 30,
    },
    {
      origin: "Panama City, FL",
      destination: "Mobile, AL",
      rate: "$900",
      pickupDate: "2026-11-20",
    },
    {
      origin: "Panama City, FL",
      destination: "Birmingham, AL",
      rate: "$500",
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupDate: "2026-11-20",
    },
  ];
}

function makeResults(): Record<string, BoardReadResult> {
  return {
    trulos: { boardSlug: "trulos", status: "ok", loads: trulosRows(), note: "ok", readAtIso: new Date().toISOString() },
    "trucker-path": { boardSlug: "trucker-path", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
    justtracking: { boardSlug: "justtracking", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
  };
}

describe("dispatch scout scan run", () => {
  it("shortlists the qualifying load, proposes it, and ledgers the skipped ones", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const waits: number[] = [];
    const deps: ScoutScanDeps = {
      runtime: makeRuntime(makeResults()),
      store: makeStore(state),
      sleep: async (ms) => {
        waits.push(ms);
      },
    };
    const result = await runScoutScan(BASE_INPUT, deps);
    expect(result.shortlistCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(result.proposalId).toBe("proposal-1");
    expect(result.watchUrl).toBe("https://browser.example/watch/run-1");
    expect(result.loadsSeen).toBe(3);
    expect(result.boardReports.map((r) => r.boardSlug)).toEqual(["trulos", "trucker-path", "justtracking"]);
    // Two human-pace waits (before the 2nd and 3rd reads), ~20s each:
    // the gap is measured from the previous read's finish, so a read
    // that took a millisecond shaves a millisecond off the wait.
    expect(waits).toHaveLength(2);
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(19900);
      expect(wait).toBeLessThanOrEqual(20000);
    }
    // Ledger: the two skipped loads only — the shortlisted one waits on the owner.
    expect(state.ledger).toHaveLength(2);
    expect(state.ledger.every((row) => row.outcome === "skipped")).toBe(true);
    expect(state.ledger.map((row) => row.loadRef).sort()).toEqual(
      expect.arrayContaining([expect.stringContaining("trulos:")]),
    );
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]?.kind).toBe("load-shortlist");
    expect(result.summary).toContain("Panama City, FL → Atlanta, GA");
    expect(result.summary).toContain("$1,850");
    expect(result.summary).toContain("Reply Yes to approve");
  });

  it("reports plainly when the browser is not configured — nothing is faked", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const result = await runScoutScan(BASE_INPUT, {
      runtime: NOT_CONFIGURED_RUNTIME,
      store: makeStore(state),
      sleep: async () => {},
    });
    expect(result.shortlistCount).toBe(0);
    expect(result.proposalId).toBeNull();
    expect(result.watchUrl).toBeNull();
    expect(state.proposals).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
    expect(result.summary).toContain("not configured");
    expect(result.boardReports.every((r) => r.status === "not-configured")).toBe(true);
  });

  it("falls through a Cloudflare-blocked board to the next one", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const results = makeResults();
    results["trulos"] = {
      boardSlug: "trulos",
      status: "blocked-cloudflare",
      loads: [],
      note: "TruLOS asked for a human check (Cloudflare) — no loads were read.",
      readAtIso: new Date().toISOString(),
    };
    results["trucker-path"] = {
      boardSlug: "trucker-path",
      status: "ok",
      loads: trulosRows().slice(0, 1),
      note: "ok",
      readAtIso: new Date().toISOString(),
    };
    const result = await runScoutScan(BASE_INPUT, {
      runtime: makeRuntime(results),
      store: makeStore(state),
      sleep: async () => {},
    });
    expect(result.shortlistCount).toBe(1);
    expect(result.boardReports[0]?.status).toBe("blocked-cloudflare");
    expect(result.summary).toContain("Cloudflare");
  });

  it("does not create a proposal for an empty shortlist", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const result = await runScoutScan(BASE_INPUT, {
      runtime: makeRuntime({
        trulos: { boardSlug: "trulos", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
        "trucker-path": { boardSlug: "trucker-path", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
        justtracking: { boardSlug: "justtracking", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
      }),
      store: makeStore(state),
      sleep: async () => {},
    });
    expect(result.shortlistCount).toBe(0);
    expect(result.proposalId).toBeNull();
    expect(state.proposals).toHaveLength(0);
    expect(result.summary).toContain("No loads qualified");
  });

  it("flags a shortlist as time-sensitive when a load picks up within 6 hours", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const now = new Date("2026-11-19T12:00:00-05:00");
    const rows = trulosRows();
    const first = rows[0] as Record<string, unknown>;
    first["pickupDate"] = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
    const result = await runScoutScan(BASE_INPUT, {
      runtime: makeRuntime({
        trulos: { boardSlug: "trulos", status: "ok", loads: rows, note: "ok", readAtIso: new Date().toISOString() },
        "trucker-path": { boardSlug: "trucker-path", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
        justtracking: { boardSlug: "justtracking", status: "empty", loads: [], note: "No loads.", readAtIso: new Date().toISOString() },
      }),
      store: makeStore(state),
      sleep: async () => {},
      now: () => now,
    });
    expect(result.shortlistCount).toBe(1);
    expect(result.timeSensitive).toBe(true);
    expect(result.summary).toContain("time-sensitive");
  });
});

describe("parseScanRequest", () => {
  it("takes the origin from 'scan from <city, ST>' and the equipment when named", () => {
    expect(parseScanRequest("scout, scan from Panama City, FL")).toEqual({ origin: "Panama City, FL", equipment: null });
    expect(parseScanRequest("find dry van loads near Atlanta, GA")).toEqual({ origin: "Atlanta, GA", equipment: "dry van" });
    expect(parseScanRequest("what loads are out there")).toEqual({ origin: null, equipment: null });
  });
});

describe("parseCostPreferences", () => {
  it("reads dollars, cents, and mpg — and ignores what it cannot parse", () => {
    const found = parseCostPreferences([
      { content: "cost per mile: $1.20" },
      { content: "floor: 50c" },
      { content: "diesel $3.50" },
      { content: "mpg 7" },
    ]);
    expect(found).toEqual({ costPerMileCents: 120, floorPerAllMileCents: 50, dieselCentsPerGallon: 350, mpg: 7 });
    expect(parseCostPreferences([{ content: "cost per mile: soon" }])).toEqual({});
    expect(parseCostPreferences([{ content: "cost per mile: 120" }])).toEqual({ costPerMileCents: 120 });
  });
});

describe("recordShortlistDecision", () => {
  function shortlistProposal(): { kind: string; payload: Record<string, unknown> } {
    const result = buildShortlist({
      loads: [
        {
          boardSlug: "trulos",
          externalRef: "trulos:abc",
          origin: "Panama City, FL",
          destination: "Atlanta, GA",
          pickupDate: "2026-11-20",
          equipment: null,
          rateCents: 185000,
          rateCentsPerLoadedMile: null,
          weightLbs: null,
          loadedMiles: 500,
          deadheadMiles: 100,
          brokerName: "Acme Logistics",
          brokerCreditScore: 80,
          brokerDaysToPay: 30,
          contactRef: null,
          rawNote: null,
        },
      ],
      costPerMileCents: 120,
      floorPerAllMileCents: 100,
      dieselCentsPerGallon: 600,
      mpg: 7,
    });
    return { kind: "load-shortlist", payload: shortlistProposalPayload(result) };
  }

  it("writes skipped rows for every load when the owner denies the shortlist", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const store = makeStore(state);
    const written = await recordShortlistDecision(store, shortlistProposal(), "denied");
    expect(written).toBe(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]?.outcome).toBe("skipped");
    expect(state.ledger[0]?.notes).toContain("passed on the shortlist");
  });

  it("writes nothing on approval and nothing for other proposal kinds", async () => {
    const state: StubState = { proposals: [], ledger: [], audit: [] };
    const store = makeStore(state);
    expect(await recordShortlistDecision(store, shortlistProposal(), "approved")).toBe(0);
    expect(await recordShortlistDecision(store, { kind: "load-draft", payload: {} }, "denied")).toBe(0);
    expect(await recordShortlistDecision(store, { kind: "load-shortlist", payload: { loads: "not an array" } }, "denied")).toBe(0);
    expect(state.ledger).toHaveLength(0);
  });
});
