// Compliance Watchdog in the group room: it answers when the job is
// its own, with the spend cap in front of the model; a load draft
// carries its block when the checklist blocks, and nothing when the
// checklist is clear. One BotFather bot is the room's only face —
// Watchdog's lines are posted through it, prefixed with its name.
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
    recordSpend: async (input) => {
      state.spentCents += input.estimatedCents;
    },
    spentThisMonthCents: async () => state.spentCents,
    loadBotMemories: async () => [],
    listComplianceDeadlines: async () => state.deadlines,
    upsertComplianceDeadline: async (input) => {
      const row = deadlineRow(input.kind, input.dueDate ?? null, input.status ?? "filed");
      state.deadlines.push(row);
      return row;
    },
    listOpenDefects: async () => [],
    listRecentDutySegments: async () => [{ duty_status: "driving", started_at: new Date().toISOString(), location: null }],
    hasRecentAlert: async () => false,
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
