// Compliance Watchdog in the group room: it answers when the job is
// its own, with the spend cap in front of the model; a load draft
// carries its block when the checklist blocks, and nothing when the
// checklist is clear. Team room (2026-11-19): bots pick up messages
// addressed to them from other team bots (bot-channel safeguards),
// and Watchdog speaks as itself when it has its own token —
// otherwise through the shared token, prefixed with its name.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, type GroupHandlerDeps } from "@/services/bots/group";
import type { BotTeamStore, ComplianceDeadlineRow, ProposalRow } from "@/services/bots/store";
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
  deadlines: ComplianceDeadlineRow[];
  /** Room log rows the bot-channel reads (newest first). */
  recentGroupMessages?: { sender_kind: string; telegram_message_id: number }[];
  /** Handoff rows addressed to Watchdog. */
  handoffs?: { bot_slug: string; target_ref: string | null; detail: Record<string, unknown> }[];
}

function deadlineRow(kind: string, dueDate: string | null, status: "filed" | "missing" | "unknown" = "filed"): ComplianceDeadlineRow {
  return {
    id: `deadline-${kind}`,
    company_id: "company-1",
    kind,
    subject_ref: null,
    due_date: dueDate,
    status,
    source: null,
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
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
    recordLoadOutcome: async () => {},
    ensureGroupRoom: async () => {},
    recordGroupMessage: async (input) => {
      state.groupMessages.push({ text: input.text });
    },
    reserveSpend: async (input) => {
      // Mirrors reserve_bot_spend (00109): reserve only while it still fits under the cap.
      if (state.spentCents + input.estimatedCents > input.capCents) return null;
      state.spentCents += input.estimatedCents;
      return "reservation";
    },
    settleSpend: async () => {},
    loadBotMemories: async () => [],
    recordCheckCall: async () => { throw new Error("not used in this test"); },
    listCheckCalls: async () => [],
    startDetentionClock: async () => { throw new Error("not used in this test"); },
    getOpenDetentionClock: async () => null,
    endDetentionClock: async () => { throw new Error("not used in this test"); },
    getDocPacket: async () => null,
    setDocPacket: async () => { throw new Error("not used in this test"); },
    getGroupMessageSender: async () => null,
    recordHandoff: async () => { throw new Error("not used in this test"); },
    listOpenHandoffs: async () => [],
    claimHandoff: async () => { throw new Error("not used in this test"); },
    completeHandoff: async () => { throw new Error("not used in this test"); },
    hasAuditorCheck: async () => false,
    findGroupMessage: async () => null,
    listComplianceDeadlines: async () => state.deadlines,
    upsertComplianceDeadline: async (input) => {
      const row = deadlineRow(input.kind, input.dueDate ?? null, input.status ?? "filed");
      state.deadlines.push(row);
      return row;
    },
    listOpenDefects: async () => [],
    listRecentDutySegments: async () => [{ duty_status: "driving", started_at: new Date().toISOString(), location: null }],
    hasRecentAlert: async () => false,
    saveBotMemory: async (input) => ({
      id: "memory-new",
      bot_slug: input.botSlug,
      kind: input.kind,
      content: input.content,
      source: input.source ?? "bot",
      created_at: new Date().toISOString(),
    }),
    listRecentAudit: async () => [],
    hasRecentAuditFingerprint: async () => false,
    listHandoffsFor: async () =>
      (state.handoffs ?? []).map((h, index) => ({
        id: `handoff-${index + 1}`,
        bot_slug: h.bot_slug,
        actor: "bot",
        action: "handoff",
        target_ref: h.target_ref,
        detail: h.detail,
        created_at: new Date().toISOString(),
      })),
    listRecentGroupMessages: async () =>
      (state.recentGroupMessages ?? []).map((row, index) => ({
        id: `gm-${index + 1}`,
        telegram_message_id: row.telegram_message_id,
        sender_kind: row.sender_kind as "owner" | "bot",
        sender_ref: "test",
        text: "",
        routed_to_bot_slug: null,
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
    runChat: async () => "Your medical card is current until next year.",
    ...overrides,
  };
  return { deps, sent };
}

const CLEAR_DEADLINES = [
  "medical_card",
  "cdl",
  "mvr",
  "clearinghouse_query",
  "drug_test_pool",
  "ucr",
  "irp",
  "mcs_150",
  "annual_inspection",
  "dvir_defect",
].map((kind) => deadlineRow(kind, "2027-06-01"));

describe("compliance watchdog in the group", () => {
  it("answers a compliance question as Watchdog, with its name first", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("Watchdog, when is my medical card due?"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Compliance Watchdog: /);
  });

  it("the Watchdog turn carries its job, the ten reasoning forms, and the snapshot", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const runChat = vi.fn(async (..._args: Parameters<NonNullable<GroupHandlerDeps["runChat"]>>) => "All current.");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("is my CDL current?"), deps);
    expect(runChat).toHaveBeenCalledTimes(1);
    const instructions = JSON.stringify(runChat.mock.calls[0]?.[0]?.instructions ?? []);
    expect(instructions).toContain("Compliance Watchdog");
    expect(instructions).toContain("TIME: never work out a weekday");
    expect(instructions).toContain("CONTEXT: hold the whole thread");
    expect(instructions).toContain("CAUSE BEFORE CONCLUSION");
    expect(instructions).toContain("PRACTICAL: fit the action");
    expect(instructions).toContain("OWN YOUR MISTAKES");
    expect(instructions).toContain("EPISODES, NOT JUST FACTS");
    expect(instructions).toContain("WHAT HE KNOWS");
    expect(instructions).toContain("LEARN WHAT HE VALUES");
    expect(instructions).toContain("USE WHAT YOU ALREADY LEARNED");
    expect(instructions).toContain("KNOW WHEN TO STOP");
    expect(instructions).toContain("COMPLIANCE SNAPSHOT");
    expect(sent[0]).toMatch(/^Compliance Watchdog: /);
  });

  it("refuses the model call when the spend cap is hit, and says so", async () => {
    const state: StubState = { proposals: [], spentCents: 1000, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("Watchdog, when is my medical card due?"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toContain(SPEND_CAP_REACHED_TEXT.slice(0, 40));
  });

  it("tells the owner plainly when the model key is not configured", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("Watchdog, when is my medical card due?"), deps);
    expect(sent[0]).toMatch(/AI key isn't configured/);
  });

  it("a load draft carries the Watchdog block when a deadline is expired — and hands it to Scout", async () => {
    const expired = CLEAR_DEADLINES.map((row) =>
      row.kind === "medical_card" ? deadlineRow("medical_card", "2026-11-10") : row,
    );
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: expired };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    expect(sent[0]).toMatch(/Dispatch Scout/);
    expect(sent[0]).toMatch(/BLOCK — the driver or truck is not legal to run this load/);
    expect(sent[0]).toMatch(/Medical card expired/);
    expect(state.audit.some((a) => a.action === "handoff" && a.detail?.to === "dispatch-scout")).toBe(true);
  });

  it("a load draft carries nothing from Watchdog when the checklist is clear", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(sent[0]).toMatch(/Dispatch Scout/);
    expect(sent[0]).not.toMatch(/BLOCK/);
    expect(sent[0]).not.toMatch(/cannot confirm/);
  });
});

describe("team room: bot-to-bot pickup (2026-11-19)", () => {
  function makeBotUpdate(text: string, username = "DispatchScoutBot", messageId = 77): TelegramUpdate {
    return {
      update_id: 2,
      message: {
        message_id: messageId,
        from: { id: 555000111, is_bot: true, username },
        chat: { id: GROUP_ID, type: "supergroup" },
        text,
      },
    };
  }

  it("Dispatch Scout asks Watchdog by name in the room — Watchdog picks it up and answers", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Watchdog, is the medical card current for this run?"), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("Compliance Watchdog: Your medical card is current until next year.");
    // The bot's message is in the room log, marked as a bot's.
    expect(state.groupMessages.map((m) => m.text)).toContain("Watchdog, is the medical card current for this run?");
  });

  it("a bot that is not a listed teammate is ignored entirely", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Watchdog, is the medical card current?", "RandomSpamBot"), deps);
    expect(result).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  it("unaddressed bot chatter is heard and logged, and wakes nobody", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("boards are quiet this morning"), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(0);
    expect(state.groupMessages).toHaveLength(1);
  });

  it("a redelivered bot message (same message id) is dropped", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      deadlines: CLEAR_DEADLINES,
      recentGroupMessages: [{ sender_kind: "bot", telegram_message_id: 77 }],
    };
    const { deps, sent } = makeDeps(state);
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Watchdog, is the medical card current?"), deps);
    expect(result).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  it("at the chain cap, bots stop answering bots until a human speaks", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      deadlines: CLEAR_DEADLINES,
      recentGroupMessages: [
        { sender_kind: "bot", telegram_message_id: 71 },
        { sender_kind: "bot", telegram_message_id: 72 },
        { sender_kind: "bot", telegram_message_id: 73 },
        { sender_kind: "bot", telegram_message_id: 74 },
      ],
    };
    const { deps, sent } = makeDeps(state);
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Watchdog, is the medical card current?"), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(0);
  });

  it("a bot's 'yes' in the room never decides a proposal — only the owner decides", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const { deps, sent } = makeDeps(state);
    await deps.store!.createProposal({ botSlug: "dispatch-scout", kind: "load-draft", title: "Load draft — $1,850", payload: {} });
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("yes"), deps);
    expect(result).toBe("handled");
    expect(state.proposals[0]!.status).toBe("proposed");
    expect(sent).toHaveLength(0);
  });

  it("with its own token, Watchdog speaks as itself — no name prefix, nothing via the shared send", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [], deadlines: CLEAR_DEADLINES };
    const asCalls: { slug: string; text: string }[] = [];
    const { deps, sent } = makeDeps(state, {
      sendMessageAs: async (slug, _chatId, text) => {
        asCalls.push({ slug, text });
        return true;
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("Watchdog, when is my medical card due?"), deps);
    expect(asCalls).toEqual([{ slug: "compliance-watchdog", text: "Your medical card is current until next year." }]);
    expect(sent).toHaveLength(0);
  });

  it("handoffs from the team reach Watchdog's turn as summaries", async () => {
    const state: StubState = {
      proposals: [],
      spentCents: 0,
      audit: [],
      groupMessages: [],
      deadlines: CLEAR_DEADLINES,
      handoffs: [
        {
          bot_slug: "dispatch-scout",
          target_ref: null,
          detail: { reason: "driver renewed the medical card Tuesday — new card in the cab", deadlineKind: "medical_card" },
        },
      ],
    };
    let captured: { kind: string; content: string }[] = [];
    const { deps } = makeDeps(state, {
      runChat: async (input) => {
        captured = input.instructions;
        return "Noted — checking the new card against the file.";
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("Watchdog, anything waiting for you?"), deps);
    const joined = captured.map((b) => b.content).join("\n\n");
    expect(joined).toContain("HANDOFFS WAITING FOR YOU FROM THE TEAM");
    expect(joined).toContain("driver renewed the medical card Tuesday");
  });
});
