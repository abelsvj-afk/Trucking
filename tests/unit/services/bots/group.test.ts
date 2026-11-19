// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, type BotSlug, type GroupHandlerDeps } from "@/services/bots/group";
import type { BotTeamStore, DetentionClockRow, HandoffStatus, ProposalRow } from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";

const OWNER_ID = 8975172276;
const GROUP_ID = -1001234567890;

function makeUpdate(text: string, fromId: number = OWNER_ID, isBot = false, replyToMessageId?: number, username?: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, is_bot: isBot, ...(username !== undefined ? { username } : {}) },
      chat: { id: GROUP_ID, type: "supergroup" },
      text,
      ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  };
}

interface StubState {
  proposals: ProposalRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null }[];
  groupMessages: { text: string; senderRef: string; telegramMessageId: number }[];
  memories?: { content: string }[];
  ledger?: { loadRef: string; outcome: string; notes: string | null }[];
  checkCalls: { kind: string; place: string | null }[];
  clocks: DetentionClockRow[];
  packets: { load_ref: string | null; bol_received: boolean; pod_received: boolean }[];
  handoffs: { id: string; from_bot: BotSlug; to_bot: BotSlug; title: string; payload: Record<string, unknown>; status: HandoffStatus; claimed_by: string | null; idempotency_key: string }[];
}

function emptyState(): StubState {
  return { proposals: [], spentCents: 0, audit: [], groupMessages: [], checkCalls: [], clocks: [], packets: [], handoffs: [] };
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
      state.groupMessages.push({ text: input.text, senderRef: input.senderRef, telegramMessageId: input.telegramMessageId });
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
    recordCheckCall: async (input) => {
      state.checkCalls.push({ kind: input.kind, place: input.place ?? null });
      return {
        id: `check-call-${state.checkCalls.length}`,
        company_id: "company-1",
        load_ref: input.loadRef ?? null,
        kind: input.kind,
        place: input.place ?? null,
        note: input.note ?? null,
        event_at: input.eventAt ?? new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
    },
    listCheckCalls: async () => [],
    startDetentionClock: async (input) => {
      const arrivedMs = Date.parse(input.arrivedAt);
      const apptMs = input.appointmentAt ? Date.parse(input.appointmentAt) : Number.NaN;
      const baseMs = Number.isFinite(apptMs) ? Math.max(arrivedMs, apptMs) : arrivedMs;
      const row = {
        id: `clock-${state.clocks.length + 1}`,
        company_id: "company-1",
        load_ref: input.loadRef ?? null,
        stop_label: input.stopLabel,
        arrived_at: input.arrivedAt,
        appointment_at: input.appointmentAt ?? null,
        free_minutes: input.freeMinutes,
        started_at: new Date(baseMs + input.freeMinutes * 60_000).toISOString(),
        ended_at: null as string | null,
        created_at: new Date().toISOString(),
      };
      state.clocks.push(row);
      return row;
    },
    getOpenDetentionClock: async () => {
      const open = [...state.clocks].reverse().find((clock) => clock.ended_at === null);
      return open ?? null;
    },
    endDetentionClock: async (id, departedAt) => {
      const row = state.clocks.find((clock) => clock.id === id);
      if (!row) throw new Error(`clock ${id} not found`);
      row.ended_at = departedAt;
      return row;
    },
    getDocPacket: async (loadRef) => {
      const found = [...state.packets].reverse().find((packet) => packet.load_ref === loadRef);
      return found ? { id: "packet-1", company_id: "company-1", load_ref: found.load_ref, bol_received: found.bol_received, pod_received: found.pod_received, updated_at: new Date().toISOString() } : null;
    },
    setDocPacket: async (input) => {
      const existing = state.packets.find((packet) => packet.load_ref === input.loadRef);
      if (existing) {
        existing.bol_received = input.bolReceived;
        existing.pod_received = input.podReceived;
      } else {
        state.packets.push({ load_ref: input.loadRef, bol_received: input.bolReceived, pod_received: input.podReceived });
      }
      return { id: "packet-1", company_id: "company-1", load_ref: input.loadRef, bol_received: input.bolReceived, pod_received: input.podReceived, updated_at: new Date().toISOString() };
    },
    getGroupMessageSender: async (_telegramChatId, telegramMessageId) => {
      const found = state.groupMessages.find((message) => message.telegramMessageId === telegramMessageId);
      return found?.senderRef ?? null;
    },
    recordHandoff: async (input) => {
      const existing = state.handoffs.find((handoff) => handoff.idempotency_key === input.idempotencyKey);
      if (existing) {
        return { id: existing.id, company_id: "company-1", from_bot: existing.from_bot, to_bot: existing.to_bot, title: existing.title, payload: existing.payload, status: existing.status, parent_id: input.parentId ?? null, depth: input.depth, idempotency_key: existing.idempotency_key, claimed_by: existing.claimed_by, created_at: new Date().toISOString(), claimed_at: null, done_at: null };
      }
      const row = {
        id: `handoff-${state.handoffs.length + 1}`,
        from_bot: input.fromBot,
        to_bot: input.toBot,
        title: input.title,
        payload: input.payload,
        status: "open" as const,
        claimed_by: null,
        idempotency_key: input.idempotencyKey,
      };
      state.handoffs.push(row);
      return { id: row.id, company_id: "company-1", from_bot: row.from_bot, to_bot: row.to_bot, title: row.title, payload: row.payload, status: "open" as const, parent_id: input.parentId ?? null, depth: input.depth, idempotency_key: row.idempotency_key, claimed_by: null, created_at: new Date().toISOString(), claimed_at: null, done_at: null };
    },
    listOpenHandoffs: async (toBot) => {
      return state.handoffs
        .filter((handoff) => handoff.to_bot === toBot && handoff.status === "open")
        .map((handoff) => ({ id: handoff.id, company_id: "company-1", from_bot: handoff.from_bot, to_bot: handoff.to_bot, title: handoff.title, payload: handoff.payload, status: "open" as const, parent_id: null, depth: 0, idempotency_key: handoff.idempotency_key, claimed_by: null, created_at: new Date().toISOString(), claimed_at: null, done_at: null }));
    },
    claimHandoff: async (id, byBot) => {
      const row = state.handoffs.find((handoff) => handoff.id === id);
      if (!row) throw new Error(`handoff ${id} not found`);
      if (row.status === "open") {
        row.status = "claimed";
        row.claimed_by = byBot;
      }
      return { id: row.id, company_id: "company-1", from_bot: row.from_bot, to_bot: row.to_bot, title: row.title, payload: row.payload, status: row.status, parent_id: null, depth: 0, idempotency_key: row.idempotency_key, claimed_by: row.claimed_by, created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), done_at: null };
    },
    completeHandoff: async (id) => {
      const row = state.handoffs.find((handoff) => handoff.id === id);
      if (!row) throw new Error(`handoff ${id} not found`);
      if (row.status === "claimed") row.status = "done";
      return { id: row.id, company_id: "company-1", from_bot: row.from_bot, to_bot: row.to_bot, title: row.title, payload: row.payload, status: row.status, parent_id: null, depth: 0, idempotency_key: row.idempotency_key, claimed_by: row.claimed_by, created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), done_at: new Date().toISOString() };
    },
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
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { groupChatId: null });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores a group that is not the allowlisted room", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { groupChatId: "-999" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores anyone who is not the owner — the room has no third parties", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("ignores a bot sender that is not one of the team's faces", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("ignored");
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", 111111, true, undefined, "StrangerBot"), deps)).toBe(
      "ignored",
    );
    expect(sent).toEqual([]);
  });

  it("answers the owner through Abel with the bot's name first", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Hi/);
    expect(state.groupMessages.length).toBeGreaterThan(0);
  });

  it("tells the owner plainly when the model key is not configured", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(sent[0]).toMatch(/AI key isn't configured/);
  });

  it("refuses the model call when the spend cap is hit, and says so", async () => {
    const state: StubState = { ...emptyState(), spentCents: 1000 };
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toContain(SPEND_CAP_REACHED_TEXT.slice(0, 40));
  });

  it("answers a board question from Dispatch Scout honestly — no board is live yet", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(sent[0]).toMatch(/can't scan boards yet/);
  });

  it("works a forwarded dispatch into an auditor-checked proposal", async () => {
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(sent[0]).toMatch(/Nothing is waiting/);
  });

  it("tells the owner a seat is not in the room yet instead of pretending it is", async () => {
    const state: StubState = emptyState();
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

describe("bot-team group mode — Tracker (Phase 2)", () => {
  it("answers a Tracker question by name, with Tracker's name first, and records the spend", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "ETA 4:35 PM, about 120 miles out.");
    const { deps, sent } = makeDeps(state, { runChat });
    expect(await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's my ETA?"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Tracker: ETA 4:35 PM/);
    expect(state.spentCents).toBeGreaterThan(0);
    expect(state.groupMessages.some((message) => message.senderRef === "tracker")).toBe(true);
  });

  it("answers its job by keyword too — the team room, not a switchboard", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "ETA 4:35 PM.");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("what's the eta on this load?"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Tracker:/);
  });

  it("logs a check call in code and confirms it in one line — no model turn needed", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("picked up at the shipper in Panama City"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Tracker: Picked up — the shipper in Panama City, \d+:\d+ [AP]M\.$/);
    expect(state.checkCalls).toEqual([{ kind: "picked_up", place: "the shipper in Panama City" }]);
    expect(state.audit.some((a) => a.action === "check_call_logged")).toBe(true);
  });

  it("starts the detention clock on arrival and reports the total on departure", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { runChat: vi.fn(async () => "should not run") });
    await handleBotTeamGroupUpdate(makeUpdate("arrived at the receiver"), deps);
    expect(state.clocks).toHaveLength(1);
    expect(sent[0]).toMatch(/inside the 2 free hours/);
    await handleBotTeamGroupUpdate(makeUpdate("left the receiver"), deps);
    expect(state.clocks[0]!.ended_at).not.toBeNull();
    expect(sent[1]).toMatch(/^Tracker: Departed/);
  });

  it("flags an escalation at once and never runs a model turn on it", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("the load was refused at the dock"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Tracker: flagging this for Sajacous — load refused/);
    expect(state.audit.some((a) => a.action === "escalation_flagged")).toBe(true);
  });

  it("hands off to Billing when a broker asks about payment — posted in the open and recorded as work", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, broker is asking when the detention pay lands"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Tracker: Billing — I need the invoice and payment status/);
    expect(state.handoffs).toHaveLength(1);
    expect(state.handoffs[0]!.to_bot).toBe("billing");
    expect(state.handoffs[0]!.status).toBe("open");
    expect(state.audit.some((a) => a.action === "handoff_created")).toBe(true);
  });

  it("hands off to Maintenance before confirming an ETA when the truck is in trouble", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { runChat: vi.fn(async () => "should not run") });
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's the ETA? The tire is flat"), deps);
    expect(sent[0]).toMatch(/^Tracker: Maintenance — I need a runnable check/);
    expect(state.handoffs[0]!.to_bot).toBe("maintenance");
  });

  it("does not record the same handoff twice for the same message", async () => {
    const state: StubState = emptyState();
    const { deps } = makeDeps(state, { runChat: vi.fn(async () => "should not run") });
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, broker is asking when the detention pay lands"), deps);
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, broker is asking when the detention pay lands"), deps);
    expect(state.handoffs).toHaveLength(1);
  });

  it("answers a reply to its own message", async () => {
    const state: StubState = emptyState();
    state.groupMessages.push({ text: "Tracker: ETA 4:35 PM.", senderRef: "tracker", telegramMessageId: 99 });
    const runChat = vi.fn(async () => "Still 4:35 PM.");
    const { deps, sent } = makeDeps(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdate("and the detention?", OWNER_ID, false, 99), deps);
    expect(sent[0]).toMatch(/^Tracker:/);
  });

  it("tells the owner plainly when the model key is not configured for a Tracker turn", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's my ETA?"), deps);
    expect(sent[0]).toMatch(/Tracker: I can't answer that yet/);
  });

  it("files a POD receipt and reports the packet state", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { runChat: vi.fn(async () => "should not run") });
    await handleBotTeamGroupUpdate(makeUpdate("POD sent"), deps);
    expect(sent[0]).toMatch(/Paperwork packet incomplete — still missing: BOL/);
    expect(state.packets[0]).toEqual({ load_ref: null, bol_received: false, pod_received: true });
  });
});

describe("bot-team group mode — faces (group-as-channel)", () => {
  function openProposal(): ProposalRow {
    return {
      id: "proposal-1",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-draft",
      title: "New load: Dallas to Houston",
      payload: {},
      source_ref: null,
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    };
  }

  it("the Tracker face answers a message routed to Tracker", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { faceBotSlug: "tracker" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's the ETA on load ABC?"), deps)).toBe("handled");
    expect(sent[0]).toMatch(/^Tracker:/);
  });

  it("a non-target face stays quiet — one message, one answer", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { faceBotSlug: "abel" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("Tracker, what's the ETA on load ABC?"), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toEqual([]);
  });

  it("only Abel's face handles an owner decision", async () => {
    const state: StubState = emptyState();
    state.proposals.push(openProposal());
    const { deps: trackerDeps, sent: trackerSent } = makeDeps(state, { faceBotSlug: "tracker" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("yes"), trackerDeps)).toBe("handled");
    expect(trackerSent).toEqual([]);
    expect(state.proposals[0]!.status).toBe("proposed");

    const { deps: abelDeps, sent: abelSent } = makeDeps(state, { faceBotSlug: "abel" });
    expect(await handleBotTeamGroupUpdate(makeUpdate("yes"), abelDeps)).toBe("handled");
    expect(abelSent[0]).toMatch(/^Approved:/);
    expect(state.proposals[0]!.status).toBe("approved");
  });

  it("Tracker answers Abel in the room when Abel addresses it by name", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    const update = makeUpdate("Tracker, what's the ETA on load ABC?", 111111, true, undefined, "AbelExecutiveBot");
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("handled");
    expect(sent[0]).toMatch(/^Tracker:/);
    expect(state.groupMessages[0]!.senderRef).toBe("abel");
  });

  it("a bot saying yes never decides a proposal", async () => {
    const state: StubState = emptyState();
    state.proposals.push(openProposal());
    const { deps, sent } = makeDeps(state);
    const update = makeUpdate("yes", 111111, true, undefined, "AbelExecutiveBot");
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.proposals[0]!.status).toBe("proposed");
  });

  it("bot chatter addressed to nobody is logged and left alone", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    const update = makeUpdate("noted", 111111, true, undefined, "AbelExecutiveBot");
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
  });
});
