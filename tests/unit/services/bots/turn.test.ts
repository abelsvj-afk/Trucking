// One bot's group turn: the shared brain, scoped tools, spend cap
// in front of the model, guardrail + Auditor checks on staged
// drafts, proposals waiting on the owner's yes, and one internal
// handoff. Scripted provider — no network, no real model.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type {
  AiAgentMessage,
  AiToolSpec,
  AiToolTurnResult,
  AgentCapableProvider,
} from "@/services/ai/provider";
import { createBotStore } from "@/services/bot/store";
import { runBotGroupTurn, type BotTurnInput } from "@/services/bots/turn";
import { SHARED_REASONING_MARKERS } from "@/services/bots/reasoning";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";
import type {
  BotMemoryRow,
  BotTeamStore,
  GroupMessageRow,
  LoadLedgerRow,
  ProposalRow,
} from "@/services/bots/store";

function scriptedProvider(turns: AiToolTurnResult[]) {
  let index = 0;
  const calls: { messages: AiAgentMessage[]; tools: AiToolSpec[] }[] = [];
  const provider: AgentCapableProvider = {
    complete: async () => {
      throw new Error("complete() is not used by the agent loop");
    },
    runToolTurn: async (messages, tools) => {
      calls.push({ messages, tools });
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      return turn;
    },
  };
  return { provider, calls };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): AiToolTurnResult {
  return { text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

function textTurn(text: string): AiToolTurnResult {
  return { text, toolCalls: [] };
}

interface TeamStubState {
  proposals: ProposalRow[];
  memories: BotMemoryRow[];
  spentCents: number;
  groupMessages: GroupMessageRow[];
  outcomes: LoadLedgerRow[];
  audit: string[];
}

function makeTeamStore(state: TeamStubState): BotTeamStore {
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
    loadRecentLoadOutcomes: async () => state.outcomes,
  };
}

function freshState(): TeamStubState {
  return { proposals: [], memories: [], spentCents: 0, groupMessages: [], outcomes: [], audit: [] };
}

function input(overrides: Partial<BotTurnInput> = {}): BotTurnInput {
  return {
    slug: "abel",
    userText: "what is my pay this week?",
    history: [],
    telegramChatId: -1001234567890,
    runId: "run-1",
    ...overrides,
  };
}

describe("runBotGroupTurn", () => {
  it("refuses the model call when the spend cap is hit, and says so", async () => {
    const state = freshState();
    state.spentCents = 1000;
    const { provider, calls } = scriptedProvider([textTurn("should not run")]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input(),
    );
    expect(calls).toHaveLength(0);
    expect(result.reply).toBe(SPEND_CAP_REACHED_TEXT);
    expect(result.proposalsCreated).toBe(0);
  });

  it("assembles the shared reasoning into the system prompt and the bot's memories into context", async () => {
    const state = freshState();
    state.memories.push({
      id: "m1",
      bot_slug: "abel",
      kind: "fact",
      content: "He never runs Florida without the exit priced in.",
      source: "seed",
      created_at: "",
    });
    const { provider, calls } = scriptedProvider([textTurn("Your pay this week is on track.")]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input(),
    );
    expect(result.reply).toBe("Your pay this week is on track.");
    expect(state.spentCents).toBeGreaterThan(0);
    const system = calls[0]!.messages[0]!.content as string;
    for (const marker of SHARED_REASONING_MARKERS) {
      expect(system).toContain(marker);
    }
    const userMessage = calls[0]!.messages[calls[0]!.messages.length - 1]!.content as string;
    expect(userMessage).toContain("He never runs Florida without the exit priced in.");
    expect(userMessage).toContain("NOW (owner's clock, America/New_York)");
    expect(userMessage).toContain("OWNER'S NEW MESSAGE:");
  });

  it("says plainly when the snapshot did not load instead of inventing figures", async () => {
    const state = freshState();
    const brain = createBotStore(createClient("https://example.supabase.co", "test-key"), "company-1", "telegram");
    const brainNoSnapshot = { ...brain, loadSnapshot: async () => null };
    const { provider, calls } = scriptedProvider([textTurn("I can't tell from what I have.")]);
    await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: brainNoSnapshot },
      input(),
    );
    const userMessage = calls[0]!.messages[calls[0]!.messages.length - 1]!.content as string;
    expect(userMessage).toContain("the company snapshot did not load");
  });

  it("carries the Scout boards-not-live note so a board question gets a plain not-yet", async () => {
    const state = freshState();
    const { provider, calls } = scriptedProvider([textTurn("I can't scan boards yet.")]);
    await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input({ slug: "dispatch-scout", userText: "find me a load to Dallas" }),
    );
    const userMessage = calls[0]!.messages[calls[0]!.messages.length - 1]!.content as string;
    expect(userMessage).toContain("LOAD BOARDS: live board scanning is not wired up yet");
  });

  it("stages a message draft as a proposal waiting on his yes — never executed", async () => {
    const state = freshState();
    const { provider } = scriptedProvider([
      toolCall("c1", "propose_message", { to: "FastFreight", body: "Checking on the load.", confirmation: "propose" }),
      textTurn("Drafted that message for you."),
    ]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input({ slug: "billing", userText: "draft a message to FastFreight" }),
    );
    expect(result.proposalsCreated).toBe(1);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("message-draft");
    expect(state.proposals[0]!.status).toBe("proposed");
    expect(state.proposals[0]!.payload).toEqual({ to: "FastFreight", body: "Checking on the load." });
    expect(result.reply).toContain("Waiting on your yes:");
    expect(result.reply).toContain("Reply Yes to approve it, No to drop it.");
  });

  it("attaches the Auditor's flags to a load draft that does not add up", async () => {
    const state = freshState();
    const { provider } = scriptedProvider([
      toolCall("c1", "propose_load_draft", {
        pay_cents: 185000,
        loaded_miles: 240,
        deadhead_miles: 30,
        rate_cents_per_loaded_mile: 200,
        origin: "Dallas",
        destination: "Houston",
        broker: "FastFreight",
        confirmation: "propose",
      }),
      textTurn("Here is the draft."),
    ]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input({ slug: "dispatch-scout", userText: "work up this dispatch" }),
    );
    expect(result.proposalsCreated).toBe(1);
    const payload = state.proposals[0]!.payload as { auditPassed: boolean; flags: { field: string }[] };
    expect(payload.auditPassed).toBe(false);
    expect(payload.flags.length).toBeGreaterThan(0);
    expect(result.reply).toContain("Auditor flags:");
  });

  it("does not stage the same proposal twice — it says it is already waiting", async () => {
    const state = freshState();
    state.proposals.push({
      id: "proposal-0",
      company_id: "company-1",
      bot_slug: "billing",
      kind: "message-draft",
      title: "Message draft to FastFreight",
      payload: { to: "FastFreight", body: "Checking on the load." },
      source_ref: "telegram-group:run-0",
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    });
    const { provider } = scriptedProvider([
      toolCall("c1", "propose_message", { to: "FastFreight", body: "Checking on the load.", confirmation: "propose" }),
      textTurn("Drafted that message for you."),
    ]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input({ slug: "billing", userText: "draft a message to FastFreight" }),
    );
    expect(result.proposalsCreated).toBe(0);
    expect(state.proposals).toHaveLength(1);
    expect(result.reply).toContain("Already waiting on your yes:");
  });

  it("reports a handoff when the answer names another bot — and a handoff turn is terminal", async () => {
    const state = freshState();
    const { provider } = scriptedProvider([textTurn("Tracker, take the ETA from here.")]);
    const result = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input(),
    );
    expect(result.handoffTo).toBe("tracker");
    const handoff = await runBotGroupTurn(
      { provider, teamStore: makeTeamStore(state), brainStore: null },
      input({ slug: "tracker", handoff: { fromBot: "abel", objective: "what is my pay", summary: "Tracker, take it." } }),
    );
    expect(handoff.handoffTo).toBeNull();
  });

  it("runs reduced without stores — no tools, no proposals, still an answer", async () => {
    const { provider, calls } = scriptedProvider([textTurn("Here is what I know from the conversation.")]);
    const result = await runBotGroupTurn({ provider, teamStore: null, brainStore: null }, input());
    expect(result.reply).toContain("Here is what I know");
    expect(calls[0]!.tools.map((tool) => tool.name)).not.toContain("propose_message");
  });
});
