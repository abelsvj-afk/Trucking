// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";

const OWNER_ID = 8975172276;
const GROUP_ID = -1001234567890;

function makeUpdate(text: string, fromId: number = OWNER_ID, isBot = false): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, is_bot: isBot },
      chat: { id: GROUP_ID, type: "supergroup" },
      text,
    },
  };
}

interface StubState {
  proposals: ProposalRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null; detail?: Record<string, unknown> }[];
  groupMessages: { text: string }[];
  memories?: { content: string }[];
  ledger?: { loadRef: string; outcome: string; notes: string | null }[];
}

function makeStub(state: StubState): BotTeamStore {
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
      state.audit.push({ action: input.action, targetRef: input.targetRef ?? null, detail: input.detail });
    },
    hasAuditorCheck: async (checkKey) =>
      state.audit.some((a) => a.action === "auditor_check" && a.detail?.check_key === checkKey),
    recordLoadOutcome: async (input) => {
      if (state.ledger) state.ledger.push({ loadRef: input.loadRef, outcome: input.outcome, notes: input.notes ?? null });
    },
    ensureGroupRoom: async () => {},
    recordGroupMessage: async (input) => {
      state.groupMessages.push({ text: input.text });
    },
    recordSpend: async (input) => {
      state.spentCents += input.estimatedCents;
    },
    spentThisMonthCents: async () => state.spentCents,
    loadBotMemories: async () =>
      (state.memories ?? []).map((memory, index) => ({
        id: `memory-${index + 1}`,
        bot_slug: "dispatch-scout",
        kind: "preference",
        source: "test",
        content: memory.content,
        created_at: new Date().toISOString(),
      })),
  };
}

function makeDeps(state: StubState, overrides: Partial<GroupHandlerDeps> = {}): { deps: GroupHandlerDeps; sent: string[] } {
  const sent: string[] = [];
  const deps: GroupHandlerDeps = {
    botToken: "token",
    allowedChatId: String(OWNER_ID),
    groupChatId: String(GROUP_ID),
    companyId: "company-1",
    store: makeStub(state),
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return [1];
    },
    runChat: async () => "Hi — I'm Abel.",
    ...overrides,
  };
  return { deps, sent };
}

describe("bot-team group mode", () => {
  it("ignores groups when no group chat id is configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, { groupChatId: null });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores a group that is not the allowlisted room", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, { groupChatId: "-999" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores anyone who is not the owner — the room has no third parties", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores bot senders — bots do not answer each other unprompted", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("answers the owner through Abel with the bot's name first", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Hi/);
    expect(state.groupMessages.length).toBeGreaterThan(0);
  });

  it("tells the owner plainly when the model key is not configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(sent[0]).toMatch(/AI key isn't configured/);
  });

  it("refuses the model call when the spend cap is hit, and says so", async () => {
    const state: StubState = { proposals: [], spentCents: 1000, audit: [], groupMessages: [] };
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toContain(SPEND_CAP_REACHED_TEXT.slice(0, 40));
  });

  it("answers a board question from Dispatch Scout honestly — no board is live yet", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(sent[0]).toMatch(/can't scan boards yet/);
  });

  it("works a forwarded dispatch into an auditor-checked proposal", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("load-draft");
    expect(sent[0]).toMatch(/Dispatch Scout/);
    expect(sent[0]).toMatch(/Reply Yes to approve/);
  });

  it("resolves 'yes' to the newest open proposal and audits the decision", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles"),
      deps,
    );
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(state.proposals[0]!.status).toBe("approved");
    expect(sent[sent.length - 1]).toMatch(/^Approved:/);
    expect(state.audit.some((a) => a.action === "proposal_approved")).toBe(true);
  });

  it("says plainly when nothing is waiting on a yes or no", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(sent[0]).toMatch(/Nothing is waiting/);
  });

  it("tells the owner a seat is not in the room yet instead of pretending it is", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's my ETA?"), deps);
    expect(sent[0]).toMatch(/isn't in the room yet/);
  });

  it("asks where the truck is when a scan names no origin", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: () => "https://browser.example/watch/run-1",
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan"), deps);
    expect(sent[0]).toMatch(/where's the truck right now/);
  });

  it("asks for the missing cost numbers instead of inventing them", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: () => "https://browser.example/watch/run-1",
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan from Panama City, FL"), deps);
    expect(sent[0]).toMatch(/I need cost per mile/);
    expect(sent[0]).toMatch(/Nothing was read yet/);
  });

  it("acks a scan, then posts the shortlist summary when the run finishes", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      memories: [{ content: "cost per mile: $1.20" }, { content: "floor: 50c" }, { content: "diesel $3.50" }, { content: "mpg 7" }],
    };
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: (runId: string) => `https://browser.example/watch/${runId}`,
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
      scoutScan: async () => ({
        runId: "run-1",
        boardReports: [{ boardSlug: "trulos", status: "ok", loadsSeen: 1, note: "ok" }],
        loadsSeen: 1,
        shortlistCount: 1,
        skippedCount: 0,
        proposalId: "proposal-1",
        watchUrl: "https://browser.example/watch/run-1",
        timeSensitive: false,
        summary: "Dispatch Scout — shortlist from Panama City, FL:\n1. Panama City, FL → Atlanta, GA — $1,850",
      }),
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan from Panama City, FL"), deps);
    expect(sent[0]).toMatch(/scanning TruLOS first/);
    expect(sent[0]).toContain("https://browser.example/watch/");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Panama City, FL → Atlanta, GA");
  });

  it("writes skipped ledger rows when the owner denies a shortlist, none on approval", async () => {
    const shortlistRow: ProposalRow = {
      id: "proposal-9",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-shortlist",
      title: "Shortlist — 1 load from Panama City, FL",
      payload: {
        loads: [
          {
            board: "trulos",
            externalRef: "trulos:abc",
            origin: "Panama City, FL",
            destination: "Atlanta, GA",
            payCents: 185000,
            loadedMiles: 500,
            deadheadMiles: 100,
            perLoadedMileCents: 370,
            brokerName: "Acme Logistics",
          },
        ],
      },
      source_ref: "scout-scan:run-1",
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    };
    const state: StubState = { proposals: [shortlistRow], spentCents: 0, audit: [], groupMessages: [], ledger: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("no"), deps);
    expect(sent[sent.length - 1]).toMatch(/^Dropped:/);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger?.[0]?.outcome).toBe("skipped");
    expect(state.ledger?.[0]?.notes).toContain("passed on the shortlist");
  });

  it("Auditor, called by name with numbers, recomputes and flags the pay gap — and writes nothing", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("Auditor, check this load: pay $1,400, rate $3.00/mi, 500 loaded miles, 100 deadhead"),
      deps,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: /);
    expect(sent[0]).toMatch(/\$1,400\.00/);
    expect(sent[0]).toMatch(/\$1,500\.00/);
    // The check is read-only: no proposal created, no record changed.
    expect(state.proposals).toHaveLength(0);
    expect(state.audit.some((a) => a.action === "auditor_check")).toBe(true);
  });

  it("Auditor, called by name with clean numbers, says the math checks out (windows aside)", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("Auditor, check this load: pay $1,500, rate $3.00/mi, 500 loaded miles, 100 deadhead"),
      deps,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: Checks out on the numbers given/);
    expect(sent[0]).toMatch(/Cannot verify: windows/);
    expect(state.proposals).toHaveLength(0);
  });

  it("Auditor, called by name with no numbers and no draft, says what is missing", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check this"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: nothing to check right now/);
  });

  it("Auditor re-checks the newest open draft when asked with no numbers", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check the latest draft"), deps);
    expect(sent[sent.length - 1]).toMatch(/^Auditor — checking "/);
    // The draft has no rate and no windows: the Auditor says so, it does not guess.
    expect(sent[sent.length - 1]).toMatch(/Cannot verify/);
    expect(state.proposals).toHaveLength(1);
  });

  it("Auditor stays quiet on a keyword alone — Abel gets the message with a routing hint", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const runChat = vi.fn(async (input: { instructions: { kind: string; content: string }[] }) => {
      const hint = input.instructions.find((row) => row.kind === "routing");
      return hint ? "routing hint seen" : "no hint";
    });
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("does that add up?"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: routing hint seen/);
    expect(runChat).toHaveBeenCalledTimes(1);
    expect(state.proposals).toHaveLength(0);
  });

  it("Auditor answers on its own turn when a draft lands with numbers — no name needed", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("does that add up? pay $1,400, $3.00/mi, 500 miles"),
      deps,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: /);
    expect(sent[0]).toMatch(/\$1,500\.00/);
    expect(state.proposals).toHaveLength(0);
  });

  it("Auditor posts under its own face when one is wired — and nothing goes out under the coordinator's face", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const asBot: { slug: string; text: string }[] = [];
    const { deps, sent } = makeDeps(state, {
      sendAsBot: async (botSlug, _chatId, text) => {
        asBot.push({ slug: botSlug, text });
        return [1];
      },
    });
    await handleBotTeamGroupUpdate(
      makeUpdate("Auditor, check this load: pay $1,400, rate $3.00/mi, 500 loaded miles, deadhead 100 miles"),
      deps,
    );
    expect(asBot).toHaveLength(1);
    expect(asBot[0]?.slug).toBe("auditor");
    expect(asBot[0]?.text).toMatch(/^Auditor: /);
    expect(asBot[0]?.text).toMatch(/\$1,500\.00/);
    expect(sent).toEqual([]);
  });

  it("a redelivered Auditor check posts its flag once — the second delivery is skipped, not re-posted", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    const text = "Auditor, check this load: pay $1,400, rate $3.00/mi, 500 loaded miles, deadhead 100 miles";
    await handleBotTeamGroupUpdate(makeUpdate(text), deps);
    await handleBotTeamGroupUpdate(makeUpdate(text), deps);
    expect(sent).toHaveLength(1);
    expect(state.audit.filter((a) => a.action === "auditor_check")).toHaveLength(1);
  });

  it("a bot message naming the Auditor is ignored — Telegram never delivers other bots' messages anyway", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(
      await handleBotTeamGroupUpdate(
        makeUpdate("Auditor, check this load: pay $1,500, rate $3.00/mi, 500 loaded miles", 999, true),
        deps,
      ),
    ).toBe("ignored");
    expect(sent).toEqual([]);
    expect(state.audit).toHaveLength(0);
  });

  it("a bot message that does not name the Auditor is still ignored", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("found a good load to Dallas", 999, true), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });
});
