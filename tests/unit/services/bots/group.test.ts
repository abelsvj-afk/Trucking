// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, shared turn per bot, one internal
// handoff, denied drafts teaching the bot that staged them.
import { describe, expect, it } from "vitest";
import { handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
import type {
  BotMemoryRow,
  BotTeamStore,
  GroupMessageRow,
  ProposalRow,
} from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import type { BotTurnInput, BotTurnResult } from "@/services/bots/turn";

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
  memories: BotMemoryRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null }[];
  groupMessages: GroupMessageRow[];
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
    recordLoadOutcome: async () => {},
    ensureGroupRoom: async () => {},
    recordGroupMessage: async (input) => {
      state.groupMessages.push({
        telegram_message_id: input.telegramMessageId,
        sender_kind: input.senderKind,
        sender_ref: input.senderRef,
        text: input.text,
        routed_to_bot_slug: input.routedToBotSlug ?? null,
        created_at: new Date().toISOString(),
      });
    },
    recordSpend: async (input) => {
      state.spentCents += input.estimatedCents;
    },
    spentThisMonthCents: async () => state.spentCents,
    loadBotMemories: async (botSlug) => state.memories.filter((row) => row.bot_slug === botSlug),
    saveBotMemory: async (input) => {
      const row: BotMemoryRow = {
        id: `memory-${++seq}`,
        bot_slug: input.botSlug,
        kind: input.kind,
        content: input.content,
        source: input.source,
        created_at: new Date().toISOString(),
      };
      state.memories.push(row);
      return row;
    },
    loadRecentGroupMessages: async () => state.groupMessages,
    loadRecentLoadOutcomes: async () => [],
  };
}

function makeDeps(
  state: StubState,
  overrides: Partial<GroupHandlerDeps> = {},
): { deps: GroupHandlerDeps; sent: string[]; turns: BotTurnInput[] } {
  const sent: string[] = [];
  const turns: BotTurnInput[] = [];
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
    runBotTurn: async (input) => {
      turns.push(input);
      const result: BotTurnResult = {
        reply: `Hello from ${input.slug}.`,
        proposalsCreated: 0,
        toolLog: [],
        handoffTo: null,
      };
      return result;
    },
    ...overrides,
  };
  return { deps, sent, turns };
}

function freshState(): StubState {
  return { proposals: [], memories: [], spentCents: 0, audit: [], groupMessages: [] };
}

describe("bot-team group mode", () => {
  it("ignores groups when no group chat id is configured", async () => {
    const state = freshState();
    const { deps, sent } = makeDeps(state, { groupChatId: null });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores a group that is not the allowlisted room", async () => {
    const state = freshState();
    const { deps, sent } = makeDeps(state, { groupChatId: "-999" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores anyone who is not the owner — the room has no third parties", async () => {
    const state = freshState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores bot senders — Telegram never delivers one bot's message to another bot", async () => {
    const state = freshState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("answers the owner through Abel with the bot's name first", async () => {
    const state = freshState();
    const { deps, sent, turns } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.slug).toBe("abel");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Hello from abel/);
    // The owner's message and the bot's reply are both logged.
    expect(state.groupMessages).toHaveLength(2);
    expect(state.groupMessages[1]!.sender_kind).toBe("bot");
  });

  it("tells the owner plainly when the model key is not configured", async () => {
    const state = freshState();
    const { deps, sent } = makeDeps(state, { runBotTurn: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(sent[0]).toMatch(/AI key isn't configured/);
  });

  it("answers the Auditor through the shared turn — every seat is wired in", async () => {
    const state = freshState();
    const { deps, sent, turns } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check this"), deps);
    expect(turns[0]!.slug).toBe("auditor");
    expect(sent[0]).toMatch(/^Auditor: Hello from auditor/);
  });

  it("routes a board question from Dispatch Scout to the shared turn, with the boards note", async () => {
    const state = freshState();
    const { deps, sent, turns } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(turns[0]!.slug).toBe("dispatch-scout");
    expect(sent[0]).toMatch(/^Dispatch Scout: Hello from dispatch-scout/);
  });

  it("posts through a bot's own account when sendAsBot is wired — no name prefix needed", async () => {
    const state = freshState();
    const sentAs: { slug: string; text: string }[] = [];
    const { deps, sent } = makeDeps(state, {
      sendAsBot: async (slug, _chatId, text) => {
        sentAs.push({ slug, text });
        return [2];
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(sentAs).toHaveLength(1);
    expect(sentAs[0]).toEqual({ slug: "abel", text: "Hello from abel." });
    expect(sent).toHaveLength(0);
    expect(state.groupMessages[1]!.sender_ref).toBe("abel");
  });

  it("runs one internal handoff when the answer names another bot, then stops", async () => {
    const state = freshState();
    const { deps, sent, turns } = makeDeps(state, {
      runBotTurn: async (input) => {
        turns.push(input);
        if (input.slug === "abel") {
          return { reply: "Tracker, take the ETA from here.", proposalsCreated: 0, toolLog: [], handoffTo: "tracker" };
        }
        return { reply: "On it.", proposalsCreated: 0, toolLog: [], handoffTo: "tracker" };
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel, where is the load?"), deps);
    expect(turns.map((turn) => turn.slug)).toEqual(["abel", "tracker"]);
    expect(turns[1]!.handoff).toMatchObject({ fromBot: "abel" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^Tracker: On it\./);
  });

  it("works a forwarded dispatch into an auditor-checked proposal", async () => {
    const state = freshState();
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
    const state = freshState();
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
    const state = freshState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(sent[0]).toMatch(/Nothing is waiting/);
  });

  it("teaches the bot from a denied draft — a second denial of the same field writes a watch-out", async () => {
    const state = freshState();
    const { deps } = makeDeps(state);
    const dispatch = "New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight";
    await handleBotTeamGroupUpdate(makeUpdate(dispatch), deps);
    await handleBotTeamGroupUpdate(makeUpdate("no"), deps);
    await handleBotTeamGroupUpdate(makeUpdate(dispatch), deps);
    await handleBotTeamGroupUpdate(makeUpdate("no"), deps);
    expect(state.proposals.filter((p) => p.status === "denied")).toHaveLength(2);
    expect(state.memories.filter((row) => row.kind === "correction").length).toBeGreaterThanOrEqual(2);
    expect(state.memories.some((row) => row.kind === "watch-out")).toBe(true);
  });
});
