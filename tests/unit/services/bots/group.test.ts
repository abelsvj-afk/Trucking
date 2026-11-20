// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { isMissingTableError, resetGroupSetupNotices, handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
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
  audit: { action: string; targetRef: string | null }[];
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
      state.audit.push({ action: input.action, targetRef: input.targetRef ?? null });
    },
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
    saveBotMemory: async (input) => ({
      id: "memory-new",
      bot_slug: input.botSlug,
      kind: input.kind,
      content: input.content,
      source: input.source ?? "bot",
      created_at: new Date().toISOString(),
    }),
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
  // Owner 2026-11-19: "DispatchBot isn't working in the group" - the group
  // was silent with no reason given. It still never answers IN an
  // unconfigured group, but the owner is now told privately why, with the id.
  it("no group configured: silent in the group, but tells the owner privately what to set (once per half hour)", async () => {
    resetGroupSetupNotices();
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: null, notifyOwner: async (t) => void owner.push(t) });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("unconfigured");
    expect(sent).toEqual([]);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toContain(`TELEGRAM_GROUP_CHAT_ID to ${GROUP_ID}`);
    await handleBotTeamGroupUpdate(makeUpdate("hello again"), deps);
    expect(owner).toHaveLength(1); // throttled
  });

  it("a different group than the configured one: silent there, owner told both ids", async () => {
    resetGroupSetupNotices();
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: "-999", notifyOwner: async (t) => void owner.push(t) });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("unconfigured");
    expect(sent).toEqual([]);
    expect(owner[0]).toContain("-999");
    expect(owner[0]).toContain(String(GROUP_ID));
  });

  it("a stranger in an unconfigured group never triggers anything", async () => {
    resetGroupSetupNotices();
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: null, notifyOwner: async (t) => void owner.push(t) });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
    expect(owner).toEqual([]);
  });

  it("the group was upgraded to a supergroup: the owner gets the NEW id", async () => {
    resetGroupSetupNotices();
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const owner: string[] = [];
    const { deps } = makeDeps(state, { notifyOwner: async (t) => void owner.push(t) });
    const update = makeUpdate("");
    (update.message as Record<string, unknown>).migrate_to_chat_id = -1009999999999;
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("unconfigured");
    expect(owner[0]).toContain("-1009999999999");
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

  it("carries the shared reasoning layer and Abel's own memory context into his group turn", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      memories: [{ content: "cost per mile: $1.20" }],
    };
    const seen: { systemContext?: string; instructions: { kind: string; content: string }[] }[] = [];
    const { deps } = makeDeps(state, {
      runChat: async (input) => {
        seen.push(input);
        return "Hi — I'm Abel.";
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(seen).toHaveLength(1);
    // The full brain: core and think-deeper form markers are present.
    expect(seen[0]?.systemContext).toContain("CONTEXT: hold the whole thread");
    expect(seen[0]?.systemContext).toContain("KNOW WHEN TO STOP");
    expect(seen[0]?.systemContext).toContain("PLAN THEN ACT:");
    // His own memory rides along; preference rows are not standing
    // instructions, so they travel in the context, not that channel.
    expect(seen[0]?.systemContext).toContain("cost per mile: $1.20");
    expect(seen[0]?.instructions).toEqual([]);
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
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check this"), deps);
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
});

describe("bot-team tables missing (migration 00103 not applied)", () => {
  it("is recognised as setup, not a passing hiccup", () => {
    expect(isMissingTableError(new Error('[bot-team] spend failed: relation "bot_spend_ledger" does not exist'))).toBe(true);
    expect(isMissingTableError(new Error("Could not find the table 'public.bot_spend_ledger' in the schema cache"))).toBe(true);
    expect(isMissingTableError(new Error("timeout"))).toBe(false);
  });
});

describe("Abel in the group when the bot-team tables are missing", () => {
  it("names the real cause (migration 00103) instead of 'try again', and still never calls the model", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const store = makeStub(state);
    store.spentThisMonthCents = async () => {
      throw new Error('[bot-team] spend failed: relation "bot_spend_ledger" does not exist');
    };
    let modelCalled = false;
    const { deps, sent } = makeDeps(state, { store, runChat: async () => ((modelCalled = true), "x") });
    await handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps);
    expect(modelCalled).toBe(false);
    expect(sent.join(" ")).toContain("migration 00103");
  });
});

describe("adding the bot to a group (2026-11-19)", () => {
  it("the 'bot was added' service message (delivered even in privacy mode) gets the owner the id AND the privacy-mode fix", async () => {
    resetGroupSetupNotices();
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: null, notifyOwner: async (t) => void owner.push(t) });
    const update = makeUpdate("");
    const msg = update.message as Record<string, unknown>;
    delete msg.text;
    msg.new_chat_members = [{ id: 7777, is_bot: true, first_name: "Abel" }];
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("unconfigured");
    expect(sent).toEqual([]);
    expect(owner[0]).toContain(String(GROUP_ID));
    expect(owner[0]).toContain("/setprivacy");
  });
});
