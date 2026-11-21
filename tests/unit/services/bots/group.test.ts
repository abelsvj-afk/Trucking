// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, isMissingTableError, resetGroupSetupNotices, type BotSlug, type GroupHandlerDeps } from "@/services/bots/group";
import { sendTelegramMessage } from "@/services/telegram/bot-api";
import type { BillingBrokerRow, BillingDataStore, BillingLoadRow } from "@/services/bots/billing";
import type { BotTeamStore, DetentionClockRow, HandoffStatus, ProposalRow } from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";
import type { AiAgentMessage, AiToolTurnResult } from "@/services/ai/provider";

const OWNER_ID = 8975172276;
const GROUP_ID = -1001234567890;

function makeUpdate(text: string, fromId: number = OWNER_ID, isBot = false, replyToMessageIdOrUsername?: number | string, username?: string): TelegramUpdate {
  // Two call shapes live in this file's history: the Phase 0/2 tests
  // pass a username as the 4th argument; Tracker's tests pass a
  // reply-to message id (number) 4th and the username 5th.
  const replyToMessageId = typeof replyToMessageIdOrUsername === "number" ? replyToMessageIdOrUsername : undefined;
  const effectiveUsername = typeof replyToMessageIdOrUsername === "string" ? replyToMessageIdOrUsername : username;
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, is_bot: isBot, ...(effectiveUsername !== undefined ? { username: effectiveUsername } : {}) },
      chat: { id: GROUP_ID, type: "supergroup" },
      text,
      ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  };
}

interface StubState {
  proposals: ProposalRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null; detail?: Record<string, unknown> }[];
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
      state.audit.push({ action: input.action, targetRef: input.targetRef ?? null, detail: input.detail });
    },
    hasAuditorCheck: async (checkKey) =>
      state.audit.some((a) => a.action === "auditor_check" && a.detail?.check_key === checkKey),
    recordLoadOutcome: async (input) => {
      if (state.ledger) state.ledger.push({ loadRef: input.loadRef, outcome: input.outcome, notes: input.notes ?? null });
    },
    ensureGroupRoom: async () => {},
    recordGroupMessage: async (input) => {
      state.groupMessages.push({ text: input.text, senderRef: input.senderRef, telegramMessageId: input.telegramMessageId });
    },
    findGroupMessage: async () => null,
    reserveSpend: async (input) => {
      // Mirrors reserve_bot_spend (00109): reserve only while it still fits under the cap.
      if (state.spentCents + input.estimatedCents > input.capCents) return null;
      state.spentCents += input.estimatedCents;
      return "reservation";
    },
    settleSpend: async () => {},
    claimJob: async () => true,
    releaseJob: async () => {},
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
    listComplianceDeadlines: async () => [],
    upsertComplianceDeadline: async (input) => ({
      id: "deadline-1",
      company_id: "company-1",
      kind: input.kind,
      subject_ref: input.subjectRef ?? null,
      due_date: input.dueDate ?? null,
      status: input.status ?? "filed",
      source: input.source ?? null,
      notes: input.notes ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    listOpenDefects: async () => [],
    listRecentDutySegments: async () => [],
    hasRecentAlert: async () => false,
    listRecentAudit: async () => [],
    hasRecentAuditFingerprint: async () => false,
    listHandoffsFor: async () => [],
    listRecentGroupMessages: async () => [],
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
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: "-999", notifyOwner: async (t) => void owner.push(t) });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello"), deps)).toBe("unconfigured");
    expect(sent).toEqual([]);
    expect(owner[0]).toContain("-999");
    expect(owner[0]).toContain(String(GROUP_ID));
  });

  it("a stranger in an unconfigured group never triggers anything", async () => {
    resetGroupSetupNotices();
    const state: StubState = emptyState();
    const owner: string[] = [];
    const { deps, sent } = makeDeps(state, { groupChatId: null, notifyOwner: async (t) => void owner.push(t) });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
    expect(owner).toEqual([]);
  });

  it("the group was upgraded to a supergroup: the owner gets the NEW id", async () => {
    resetGroupSetupNotices();
    const state: StubState = emptyState();
    const owner: string[] = [];
    const { deps } = makeDeps(state, { notifyOwner: async (t) => void owner.push(t) });
    const update = makeUpdate("");
    (update.message as Record<string, unknown>).migrate_to_chat_id = -1009999999999;
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("unconfigured");
    expect(owner[0]).toContain("-1009999999999");
  });

  it("ignores anyone who is not the owner — the room has no third parties", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hello", 12345), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("records a bot's room chatter without acting on it — bot messages start no model turn, workup, or decision", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
  });

  it("answers the owner through Abel with the bot's name first", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Hi/);
    expect(state.groupMessages.length).toBeGreaterThan(0);
  });

  it("carries the shared reasoning layer and Abel's own memory context into his group turn", async () => {
    const state: StubState = { ...emptyState(), memories: [{ content: "cost per mile: $1.20" }] };
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

  it("sends Scout's replies from his own bot when scoutSendMessage is wired", async () => {
    const state: StubState = emptyState();
    const scoutSent: string[] = [];
    const { deps, sent } = makeDeps(state, {
      scoutSendMessage: async (_chatId, text) => {
        scoutSent.push(text);
        return [1];
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("find me a load"), deps);
    expect(sent).toEqual([]);
    expect(scoutSent).toHaveLength(1);
    expect(scoutSent[0]).toMatch(/can't scan boards yet/);
  });

  it("sends Scout's worked-up draft from his own bot when scoutSendMessage is wired", async () => {
    const state: StubState = emptyState();
    const scoutSent: string[] = [];
    const { deps, sent } = makeDeps(state, {
      scoutSendMessage: async (_chatId, text) => {
        scoutSent.push(text);
        return [1];
      },
    });
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(scoutSent).toHaveLength(1);
    expect(scoutSent[0]).toMatch(/Dispatch Scout/);
    expect(scoutSent[0]).toMatch(/Reply Yes to approve/);
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

  // Owner 2026-11-21: "Yes" with nothing waiting got a system line ("Nothing is waiting on a yes or no
  // right now."). Now it is conversation: no system line, and the team answers it like a person.
  it("a 'yes' with nothing waiting is conversation, never a system line", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(sent.join(" ")).not.toMatch(/Nothing is waiting on a yes or no/);
    // Without the team's AI it is still answered (never silence), in plain words.
    expect(sent).toHaveLength(1);
  });

  it("seats Billing: what's-unpaid is answered from the records, in money facts", async () => {
    const state: StubState = emptyState();
    const runChat = vi.fn(async () => "should not run");
    const { deps, sent } = makeDeps(state, {
      runChat,
      billingData: {
        listInvoices: async () => [
          {
            id: "inv-1",
            load_id: "load-1",
            broker_id: "broker-1",
            invoice_date: "2026-11-18",
            due_date: "2026-12-09",
            amount_cents: 185000,
            paid_amount_cents: 0,
            paid_on: null,
            factored: false,
            factor_fee_cents: null,
            factor_reserve_cents: null,
          },
        ],
        listDeliveredLoadsWithoutInvoice: async () => [],
        loadBroker: async () => ({ id: "broker-1", name: "FastFreight", payment_terms_days: 21 }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("Billing, what's unpaid?"), deps);
    expect(runChat).not.toHaveBeenCalled();
    expect(sent[0]).toContain("Billing — unpaid invoices:");
    expect(sent[0]).toContain("$1,850.00 from FastFreight");
  });

  it("works a Billing invoice draft into a proposal and approves it on 'yes'", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, {
      billingData: {
        listInvoices: async () => [],
        listDeliveredLoadsWithoutInvoice: async () => [
          {
            id: "load-1",
            broker_id: "broker-1",
            origin: "Dallas",
            destination: "Detroit",
            delivery_date: "2026-11-18",
            rate_cents: 185000,
            trip_number: "1874",
            broker_reference: null,
            status: "completed",
          },
        ],
        loadBroker: async () => ({ id: "broker-1", name: "FastFreight", payment_terms_days: 21 }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("Billing, invoice the Detroit load"), deps);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("invoice-draft");
    expect(sent[0]).toContain("Billing — invoice ready");
    await handleBotTeamGroupUpdate(makeUpdate("yes"), deps);
    expect(state.proposals[0]!.status).toBe("approved");
    expect(sent[sent.length - 1]).toMatch(/^Approved:/);
  });
});

describe("bot-to-bot delivery in the group (Bot API 9.6)", () => {
  const LOAD: BillingLoadRow = {
    id: "load-1",
    broker_id: "broker-1",
    origin: "Dallas",
    destination: "Detroit",
    delivery_date: "2026-11-18",
    rate_cents: 185000,
    trip_number: "1874",
    broker_reference: "REF-1",
    status: "completed",
  };
  const BROKER: BillingBrokerRow = { id: "broker-1", name: "FastFreight", payment_terms_days: 21 };

  function makeBillingData(): BillingDataStore {
    return {
      listInvoices: async () => [],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
    };
  }

  function makeBotUpdate(text: string, messageId = 20, replyToMessageId: number | null = null): TelegramUpdate {
    return {
      update_id: 2,
      message: {
        message_id: messageId,
        from: { id: 777000, is_bot: true },
        chat: { id: GROUP_ID, type: "supergroup" },
        text,
        ...(replyToMessageId !== null ? { reply_to_message: { message_id: replyToMessageId } } : {}),
      },
    };
  }

  it("a POD note from Tracker addressed to Billing drafts the invoice — once", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: Billing, POD signed for the Dallas → Detroit load"), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Billing");
    expect(sent[0]).toContain("waiting on your yes");
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("invoice-draft");
  });

  it("a bot message that does not address Billing stays quiet", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    // Union semantics (Billing + Auditor): the message is not
    // Billing's, so Billing never speaks — but the room records
    // every bot message (the Auditor's room log), so the result is
    // "handled" (recorded), not "ignored". Quiet = no speech, no
    // proposals, exactly as asserted below.
    expect(await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: ETA 2pm for the Detroit load"), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.proposals).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
  });

  it("Billing's own message never triggers its own turn (loop guard)", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    // Logged to the room (BT-005: through the common path), but never a Billing turn.
    expect(await handleBotTeamGroupUpdate(makeBotUpdate("Billing: invoice ready — $1,850.00 from FastFreight"), deps)).not.toBe("unconfigured");
    expect(sent).toEqual([]);
  });

  // BT-005: a handoff to Billing goes through the same chain cap as every bot message.
  it("a Billing handoff at the bot-chain cap gets no Billing turn", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    deps.store!.listRecentGroupMessages = async () =>
      [1, 2, 3, 4].map((i) => ({ sender_kind: "bot", telegram_message_id: 100 + i })) as never;
    await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: Billing, POD signed for the Dallas → Detroit load", 31), deps);
    expect(sent).toEqual([]);
    expect(state.proposals).toHaveLength(0);
  });

  // BT-003: a claim that can't be made means no Billing turn at all.
  it("a Billing handoff whose claim fails (non-duplicate error) does not run", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    deps.store!.recordGroupMessage = async () => {
      throw new Error("connection reset");
    };
    await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: Billing, POD signed for the Dallas → Detroit load", 32), deps);
    expect(sent).toEqual([]);
    expect(state.proposals).toHaveLength(0);
  });

  it("a reply to one of Billing's messages is addressed to Billing even without naming it", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    const store = deps.store!;
    store.findGroupMessage = async () => ({ senderKind: "bot", senderRef: "billing", text: "Billing: which load?" });
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: here it is — POD attached", 21, 7), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Billing");
  });

  it("a message claimed once is not answered twice (duplicate delivery)", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    const store = deps.store!;
    const seen = new Set<string>();
    store.recordGroupMessage = async (input) => {
      const key = `${input.telegramChatId}:${input.telegramMessageId}:${input.senderKind}`;
      if (seen.has(key)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
        err.code = "23505";
        throw err;
      }
      seen.add(key);
      state.groupMessages.push({ text: input.text, senderRef: input.senderRef, telegramMessageId: input.telegramMessageId });
    };
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("ignored");
    expect(sent).toHaveLength(1);
  });

  it("the same bot message delivered twice runs Billing's turn once", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    const store = deps.store!;
    const seen = new Set<string>();
    const realRecord = store.recordGroupMessage;
    store.recordGroupMessage = async (input) => {
      const key = `${input.telegramChatId}:${input.telegramMessageId}:${input.senderKind}`;
      if (seen.has(key)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
        err.code = "23505";
        throw err;
      }
      seen.add(key);
      await realRecord(input);
    };
    const update = makeBotUpdate("Tracker: Billing, POD signed for the Dallas → Detroit load");
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("handled");
    expect(await handleBotTeamGroupUpdate(update, deps)).toBe("ignored");
    expect(state.proposals).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("Abel→Billing fan-out (bridge until Billing's own webhook is live)", () => {
  const LOAD: BillingLoadRow = {
    id: "load-1",
    broker_id: "broker-1",
    origin: "Dallas",
    destination: "Detroit",
    delivery_date: "2026-11-18",
    rate_cents: 185000,
    trip_number: "1874",
    broker_reference: "REF-1",
    status: "completed",
  };
  const BROKER: BillingBrokerRow = { id: "broker-1", name: "FastFreight", payment_terms_days: 21 };

  function makeBillingData(): BillingDataStore {
    return {
      listInvoices: async () => [],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
    };
  }

  it("Abel's reply naming Billing runs Billing's turn once, in the room", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, {
      billingData: makeBillingData(),
      runChat: async () => "Billing, please draft the invoice for the Dallas → Detroit load.",
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^Abel: Billing, please draft/);
    expect(sent[1]).toContain("Billing");
    expect(sent[1]).toContain("waiting on your yes");
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("invoice-draft");
  });

  it("no fan-out when Abel's reply does not name Billing", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, {
      billingData: makeBillingData(),
      runChat: async () => "All good — nothing to do.",
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(state.proposals).toEqual([]);
  });

  it("no fan-out once Billing's own webhook is live (Telegram delivers it instead)", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, {
      billingData: makeBillingData(),
      billingSeparateWebhookLive: true,
      runChat: async () => "Billing, please draft the invoice for the Dallas → Detroit load.",
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(state.proposals).toEqual([]);
  });

  it("asks where the truck is when a scan names no origin", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state, {
      browserRuntime: {
        route: "shared-vm",
        readBoard: async () => ({ boardSlug: "trulos", status: "ok", loads: [], note: "ok", readAtIso: new Date().toISOString() }),
        watchUrl: () => "https://browser.example/watch/run-1",
        stopRun: async () => ({ stopped: true, reason: "Stopped." }),
      },
    });
    await handleBotTeamGroupUpdate(makeUpdate("scout, scan"), deps);
    expect(sent[0]).toMatch(/Where's the truck right now/);
    // Never command syntax (owner 2026-11-21: no specific way to phrase things).
    expect(sent[0]).not.toMatch(/Say '|<city/);
  });

  it("asks for the missing cost numbers instead of inventing them", async () => {
    const state: StubState = emptyState();
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
    const state: StubState = { ...emptyState(), memories: [{ content: "cost per mile: $1.20" }, { content: "floor: 50c" }, { content: "diesel $3.50" }, { content: "mpg 7" }] };
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
    const state: StubState = { ...emptyState(), proposals: [shortlistRow], ledger: [] };
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("no"), deps);
    expect(sent[sent.length - 1]).toMatch(/^Dropped:/);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger?.[0]?.outcome).toBe("skipped");
    expect(state.ledger?.[0]?.notes).toContain("passed on the shortlist");
  });

  it("Auditor, called by name with numbers, recomputes and flags the pay gap — and writes nothing", async () => {
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check this"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: nothing to check right now/);
  });

  it("Auditor re-checks the newest open draft when asked with no numbers", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    await handleBotTeamGroupUpdate(
      makeUpdate("New load: pickup Dallas, delivery Houston, pay $1850, 240 miles, broker FastFreight"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check the latest draft"), deps);
    // Team room: the Auditor speaks TO the draft's author, by name,
    // and asks for the missing source instead of failing silently.
    // The draft has no rate and no windows: the Auditor says so, it does not guess.
    expect(sent[sent.length - 1]).toMatch(/^Dispatch Scout — I can't finish checking "/);
    expect(sent[sent.length - 1]).toMatch(/Post the source and I'll re-run it\./);
    expect(state.proposals).toHaveLength(1);
  });

  it("Auditor stays quiet on a keyword alone — Abel gets the message with a routing hint", async () => {
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
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
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    const text = "Auditor, check this load: pay $1,400, rate $3.00/mi, 500 loaded miles, deadhead 100 miles";
    await handleBotTeamGroupUpdate(makeUpdate(text), deps);
    await handleBotTeamGroupUpdate(makeUpdate(text), deps);
    expect(sent).toHaveLength(1);
    expect(state.audit.filter((a) => a.action === "auditor_check")).toHaveLength(1);
  });

  it("a teammate's message naming the Auditor runs the check — the group is the shared channel (Bot-to-Bot Mode)", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(
      await handleBotTeamGroupUpdate(
        makeUpdate("Auditor, check this load: pay $1,400, rate $3.00/mi, 500 loaded miles", 999, true, "DispatchScoutBot"),
        deps,
      ),
    ).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Auditor: /);
    expect(sent[0]).toMatch(/\$1,500\.00/);
    expect(state.audit.some((a) => a.action === "auditor_check")).toBe(true);
  });

  it("a bot message that does not route to the Auditor is recorded, never acted on", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("found a good load to Dallas", 999, true), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
  });

  it("a bot's 'yes' never decides a proposal — only the owner decides", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    state.proposals.push({
      id: "proposal-draft-1",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-draft",
      title: "Load draft — Dallas → Houston",
      payload: { payCents: 150000, rateCentsPerLoadedMile: 300, loadedMiles: 500, deadheadMiles: 100 },
      source_ref: null,
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("yes", 999, true, "DispatchScoutBot"), deps)).toBe("handled");
    expect(state.proposals[0]?.status).toBe("proposed");
    expect(sent).toEqual([]);
  });

  it("a bot message naming another bot starts none of that bot's actions", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    expect(
      await handleBotTeamGroupUpdate(makeUpdate("Dispatch Scout, scan from Dallas", 999, true), deps),
    ).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.proposals).toHaveLength(0);
  });

  it("the Auditor flags a draft TO its author by name, with both numbers shown", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    state.proposals.push({
      id: "proposal-draft-2",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-draft",
      title: "Load draft — Dallas → Houston",
      payload: { payCents: 140000, rateCentsPerLoadedMile: 300, loadedMiles: 500, deadheadMiles: 100 },
      source_ref: null,
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    });
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check the latest draft"), deps);
    expect(sent[sent.length - 1]).toMatch(/^Dispatch Scout — flag on your draft "Load draft — Dallas → Houston": /);
    expect(sent[sent.length - 1]).toMatch(/\$1,500\.00/);
    const check = state.audit.find((a) => a.action === "auditor_check");
    expect(check?.detail?.addressed_to).toBe("dispatch-scout");
  });

  it("the Auditor reports a clean draft to its author out loud, in one line", async () => {
    const state: StubState = emptyState();
    const { deps, sent } = makeDeps(state);
    state.proposals.push({
      id: "proposal-draft-3",
      company_id: "company-1",
      bot_slug: "dispatch-scout",
      kind: "load-draft",
      title: "Load draft — Dallas → Houston",
      payload: {
        payCents: 150000,
        rateCentsPerLoadedMile: 300,
        loadedMiles: 500,
        deadheadMiles: 100,
        pickupWindowStart: "2026-11-20T08:00:00.000Z",
        pickupWindowEnd: "2026-11-20T12:00:00.000Z",
        deliveryWindowStart: "2026-11-21T08:00:00.000Z",
        deliveryWindowEnd: "2026-11-21T12:00:00.000Z",
      },
      source_ref: null,
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    });
    await handleBotTeamGroupUpdate(makeUpdate("Auditor, check the latest draft"), deps);
    expect(sent[sent.length - 1]).toBe('Dispatch Scout — your draft "Load draft — Dallas → Houston" checks out.');
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
    const state: StubState = emptyState();
    const store = makeStub(state);
    store.reserveSpend = async () => {
      throw new Error('[bot-team] spend failed: relation "bot_spend_ledger" does not exist');
    };
    let modelCalled = false;
    const { deps, sent } = makeDeps(state, { store, runChat: async () => ((modelCalled = true), "x") });
    await handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps);
    expect(modelCalled).toBe(false);
    expect(sent.join(" ")).toContain("00103");
  });
});

describe("adding the bot to a group (2026-11-19)", () => {
  it("the 'bot was added' service message (delivered even in privacy mode) gets the owner the id AND the privacy-mode fix", async () => {
    resetGroupSetupNotices();
    const state: StubState = emptyState();
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

// Audit F-023/F-024: the cap is fail-closed and reserved BEFORE the call.
describe("Abel's spend cap in the group (audit F-023/F-024)", () => {
  it("no bot-team store: no cap check, so no model call — and says why", async () => {
    const state: StubState = emptyState();
    let modelCalled = false;
    const { deps, sent } = makeDeps(state, { store: null, runChat: async () => ((modelCalled = true), "x") });
    await handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps);
    expect(modelCalled).toBe(false);
    // BT-003: with no store the message can't be claimed, so nothing runs; Abel says so once.
    expect(sent.join(" ")).toContain("couldn't log that message");
  });

  it("two turns at once with room for one: only one reaches the model", async () => {
    const state: StubState = emptyState();
    const store = makeStub(state);
    // Room for exactly one reservation this month.
    const realReserve = store.reserveSpend;
    let first = 0;
    store.reserveSpend = async (input) => {
      if (first === 0) first = input.estimatedCents;
      return realReserve({ ...input, capCents: first });
    };
    let modelCalls = 0;
    const { deps } = makeDeps(state, {
      store,
      runChat: async () => {
        modelCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return "ok";
      },
    });
    await Promise.all([
      handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps),
      handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps),
    ]);
    expect(modelCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Maintenance seat + bot-to-bot handoffs (its crew's tests, carried into
// the union file with M-suffixed helpers; the store stub mirrors the
// current BotTeamStore interface, with real claim semantics for jobs).
// ---------------------------------------------------------------------------

vi.mock("@/services/telegram/bot-api", () => ({
  sendTelegramMessage: vi.fn(async () => [99]),
}));

function makeUpdateM(
  text: string,
  fromId: number = OWNER_ID,
  isBot = false,
  messageId = 10,
  extra?: { username?: string; replyTo?: { username?: string; text?: string } },
): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      from: { id: fromId, is_bot: isBot, username: extra?.username },
      chat: { id: GROUP_ID, type: "supergroup" },
      text,
      reply_to_message: extra?.replyTo
        ? { from: { username: extra.replyTo.username }, text: extra.replyTo.text }
        : undefined,
    },
  };
}

interface StubStateM {
  proposals: ProposalRow[];
  spentCents: number;
  audit: { action: string; targetRef: string | null }[];
  groupMessages: { text: string }[];
  memories?: { content: string }[];
  ledger?: { loadRef: string; outcome: string; notes: string | null }[];
  /** Job claims: key -> expires-at ms. Optional: makeStub defaults it. */
  claims?: Map<string, number>;
}

function makeStubM(state: StubStateM): BotTeamStore {
  let seq = 0;
  const claims = (state.claims ??= new Map<string, number>());
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
    reserveSpend: async (input) => {
      // Mirrors reserve_bot_spend (00109): reserve only while it still fits under the cap.
      if (state.spentCents + input.estimatedCents > input.capCents) return null;
      state.spentCents += input.estimatedCents;
      return "reservation";
    },
    settleSpend: async () => {},
    saveBotMemory: async (input) => ({
      id: "memory-new",
      bot_slug: input.botSlug,
      kind: input.kind,
      content: input.content,
      source: input.source ?? "bot",
      created_at: new Date().toISOString(),
    }),
    listComplianceDeadlines: async () => [],
    upsertComplianceDeadline: async () => { throw new Error("not used in this test"); },
    listOpenDefects: async () => [],
    listRecentDutySegments: async () => [],
    hasRecentAlert: async () => false,
    listRecentAudit: async () => [],
    hasRecentAuditFingerprint: async () => false,
    listHandoffsFor: async () => [],
    listRecentGroupMessages: async () => [],
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
    loadBotMemories: async () =>
      (state.memories ?? []).map((memory, index) => ({
        id: `memory-${index + 1}`,
        bot_slug: "dispatch-scout",
        kind: "preference",
        source: "test",
        content: memory.content,
        created_at: new Date().toISOString(),
      })),
    claimJob: async (jobKey, _botSlug, ttlMs = 5 * 60 * 1000) => {
      const now = Date.now();
      const expires = claims.get(jobKey);
      if (expires !== undefined && expires > now) return false;
      claims.set(jobKey, now + ttlMs);
      return true;
    },
    releaseJob: async (jobKey) => {
      claims.delete(jobKey);
    },
  };
}

function makeDepsM(state: StubStateM, overrides: Partial<GroupHandlerDeps> = {}): { deps: GroupHandlerDeps; sent: string[] } {
  const sent: string[] = [];
  const deps: GroupHandlerDeps = {
    botToken: "token",
    allowedChatId: String(OWNER_ID),
    groupChatId: String(GROUP_ID),
    companyId: "company-1",
    store: makeStubM(state),
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return [1];
    },
    runChat: async () => "Hi — I'm Abel.",
    ...overrides,
  };
  return { deps, sent };
}

describe("bot-team group mode — Maintenance seat", () => {
  it("answers when called by name, with its identity and the shared reasoning in the turn", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    type RunChatInput = Parameters<NonNullable<GroupHandlerDeps["runChat"]>>[0];
    const seenInputs: RunChatInput[] = [];
    const runChat = vi.fn(async (input: RunChatInput) => {
      seenInputs.push(input);
      return "Oil change is due in 2,000 miles.";
    });
    const { deps, sent } = makeDepsM(state, { runChat });
    expect(await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, what is due next?"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Maintenance: Oil change/);
    expect(seenInputs).toHaveLength(1);
    const instructions = seenInputs[0]!.instructions;
    expect(instructions.some((row) => row.kind === "identity")).toBe(true);
    expect(instructions.some((row) => row.kind === "scope")).toBe(true);
    expect(instructions.filter((row) => row.kind === "reasoning").length).toBeGreaterThanOrEqual(10);
    // Handoff payload is validated state, not a transcript: the turn
    // carries no chat history and no other bot's raw output.
    expect(seenInputs[0]!.history).toEqual([]);
    expect(state.spentCents).toBeGreaterThan(0);
  });

  it("stays quiet on a keyword-only message until Abel routes it — then Abel's handoff posts and Maintenance answers", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "unused");
    runChat.mockResolvedValueOnce("ROUTE: maintenance");
    runChat.mockResolvedValueOnce("Your DOT inspection is due in 12 days.");
    const { deps, sent } = makeDepsM(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdateM("when is the DOT inspection due?"), deps);
    expect(runChat).toHaveBeenCalledTimes(2);
    // The handoff is VISIBLE first (code-generated, no extra model
    // call), then Maintenance's answer — the owner watches the
    // handoff happen.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/handoff: job=route keywords=inspection,dot hops=0/);
    expect(sent[0]).toMatch(/Abel → Maintenance: routing this one to you/);
    expect(sent[1]).toMatch(/^Maintenance: Your DOT inspection/);
  });

  it("does not answer a keyword-only message Abel does not route — Abel asks the one short question", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Which truck is this about?");
    const { deps, sent } = makeDepsM(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdateM("my tire is flat"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Which truck is this about\?/);
    expect(sent[0]).not.toMatch(/^Maintenance:/);
  });

  it("does not mistake Abel merely mentioning Maintenance for a route", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Maintenance can help with that — what is wrong?");
    const { deps, sent } = makeDepsM(state, { runChat });
    await handleBotTeamGroupUpdate(makeUpdateM("the brakes feel soft"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Abel: Maintenance can help/);
  });

  it("files a reported defect as an open DVIR item and tells Dispatch Scout the truck is down", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, my tire is flat on truck 2"), deps);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("record-draft");
    expect(state.proposals[0]!.bot_slug).toBe("maintenance");
    const payload = state.proposals[0]!.payload as Record<string, unknown>;
    expect(payload.recordKind).toBe("dvir-defect");
    expect(payload.defect).toBe("flat tire");
    expect(payload.status).toBe("open");
    expect(sent[0]).toMatch(/DVIR/);
    expect(sent[0]).toMatch(/Dispatch Scout — truck 2 reported down/);
    expect(sent[0]).toMatch(/Reply Yes to confirm filing/);
  });

  it("drafts a work order with the estimate from the owner's words, never guessed", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    await handleBotTeamGroupUpdate(
      makeUpdateM("Maintenance, draft a work order for the brake problem, estimate $450"),
      deps,
    );
    expect(state.proposals).toHaveLength(1);
    const payload = state.proposals[0]!.payload as Record<string, unknown>;
    expect(payload.recordKind).toBe("work-order");
    expect(payload.estimateCents).toBe(45000);
    expect(sent[0]).toMatch(/work-order draft ready/i);
    expect(sent[0]).toMatch(/\$450\.00/);
    expect(sent[0]).toMatch(/Reply Yes to approve/);
  });

  it("stages a call plan for a shop — a proposal, never a dial", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, call the shop about the estimate"), deps);
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("call-plan");
    expect(state.proposals[0]!.bot_slug).toBe("maintenance");
    expect(sent[0]).toMatch(/call plan recorded/i);
    expect(sent[0]).toMatch(/\+1 320-369-0102/);
    expect(sent[0]).toMatch(/No call is placed until you approve it/);
  });

  it("stays quiet on another bot's job — a load message is Scout's, not Maintenance's", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    await handleBotTeamGroupUpdate(makeUpdateM("find me a load"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/Maintenance:/);
  });

  it("never files the same Telegram message twice — a redelivery replays the already-filed summary", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    const update = makeUpdateM("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42);
    await handleBotTeamGroupUpdate(update, deps);
    await handleBotTeamGroupUpdate(update, deps);
    expect(state.proposals).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/already filed from your earlier message/i);
    expect(sent[1]).toMatch(/Reply Yes to confirm filing/);
  });

  it("files two different messages as two defects — the idempotency key is per message", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps } = makeDepsM(state);
    await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42), deps);
    await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 43), deps);
    expect(state.proposals).toHaveLength(2);
  });

  it("routes a keyword-only message through Abel when the model key is not configured", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state, { runChat: undefined });
    await handleBotTeamGroupUpdate(makeUpdateM("my tire is flat"), deps);
    expect(sent[0]).toMatch(/^Abel: I can't answer that yet/);
  });

  it("posts from Maintenance's own account when its token is configured — no text prefix", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const runChat = vi.fn(async () => "Oil change is due in 2,000 miles.");
    const { deps, sent } = makeDepsM(state, { runChat });
    vi.mocked(sendTelegramMessage).mockClear();
    process.env.TELEGRAM_MAINTENANCE_BOT_TOKEN = "maint-token";
    try {
      await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, what is due next?"), deps);
    } finally {
      delete process.env.TELEGRAM_MAINTENANCE_BOT_TOKEN;
    }
    expect(sendTelegramMessage).toHaveBeenCalledWith("maint-token", GROUP_ID, "Oil change is due in 2,000 miles.");
    expect(sent).toEqual([]);
  });
});

describe("bot-team group mode — bot-to-bot handoffs to Maintenance", () => {
  const BOT_ENVS = {
    TELEGRAM_ABEL_BOT_USERNAME: "AbelBot",
    TELEGRAM_DISPATCH_SCOUT_BOT_USERNAME: "DispatchScoutBot",
    TELEGRAM_MAINTENANCE_BOT_USERNAME: "MaintenanceBot",
    TELEGRAM_TRACKER_BOT_USERNAME: "TrackerBot",
  } as const;

  /** Run with every bot's username configured (and restored after). */
  function withBotUsernames<T>(fn: () => Promise<T>): Promise<T> {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(BOT_ENVS)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    return fn().finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it("answers a runnable handoff from Dispatch Scout with the truck status from open defects", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, my tire is flat on truck 2"), deps);
      expect(state.proposals).toHaveLength(1);
      await handleBotTeamGroupUpdate(
        makeUpdateM(
          "/handoff@MaintenanceBot job=runnable truck=2 hops=0\nDispatch Scout → Maintenance: is truck 2 runnable?",
          555,
          true,
          50,
          { username: "DispatchScoutBot" },
        ),
        deps,
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/Dispatch Scout — Truck status for Dispatch Scout:/);
      expect(sent[1]).toMatch(/Runnable: none reported/);
      expect(sent[1]).toMatch(/Down: truck 2 — flat tire/);
    });
  });

  it("files a defect handoff from another bot through the same intake, idempotent per message", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      const update = makeUpdateM("/handoff@MaintenanceBot job=defect defect=flat-tire truck=2 hops=0", 111, true, 51, {
        username: "AbelBot",
      });
      await handleBotTeamGroupUpdate(update, deps);
      await handleBotTeamGroupUpdate(update, deps);
      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0]!.payload).toMatchObject({ recordKind: "dvir-defect", defect: "flat tire" });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatch(/already filed from your earlier message/i);
    });
  });

  it("works a route handoff from Abel on the owner's message it replies to", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      await handleBotTeamGroupUpdate(
        makeUpdateM("/handoff@MaintenanceBot job=route keywords=tire hops=0", 111, true, 52, {
          username: "AbelBot",
          replyTo: { text: "Maintenance, my tire is flat on truck 2" },
        }),
        deps,
      );
      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0]!.payload).toMatchObject({ recordKind: "dvir-defect", defect: "flat tire" });
      expect(sent[0]).toMatch(/Defect filed as an open DVIR item/);
    });
  });

  it("ignores a handoff to Abel — only Maintenance has a bot-to-bot handler so far", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdateM("/handoff@AbelBot job=progress about=load hops=0", 555, true, 53, { username: "DispatchScoutBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
    });
  });

  it("ignores a bot the team does not know, even when it addresses Maintenance", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdateM("/handoff@MaintenanceBot job=runnable truck=2 hops=0", 999, true, 54, { username: "StrangerBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
    });
  });

  it("audit-logs a malformed handoff and runs nothing", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdateM("/handoff@MaintenanceBot job=bogus hops=0", 111, true, 55, { username: "AbelBot" }),
          deps,
        ),
      ).toBe("ignored");
      expect(sent).toEqual([]);
      expect(state.proposals).toHaveLength(0);
      expect(state.audit.some((a) => a.action === "handoff_malformed")).toBe(true);
    });
  });

  it("drops a handoff that has already passed through three bots — the loop guard", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      await handleBotTeamGroupUpdate(
        makeUpdateM("/handoff@MaintenanceBot job=runnable truck=2 hops=3", 555, true, 56, { username: "DispatchScoutBot" }),
        deps,
      );
      expect(state.proposals).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/dropping this handoff/);
      expect(state.audit.some((a) => a.action === "handoff_dropped_hop_limit")).toBe(true);
    });
  });

  it("files once when the same message arrives twice at the same moment — the job claim is the in-flight guard", async () => {
    const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
    const { deps, sent } = makeDepsM(state);
    const update = makeUpdateM("Maintenance, my tire is flat on truck 2", OWNER_ID, false, 42);
    await Promise.all([handleBotTeamGroupUpdate(update, deps), handleBotTeamGroupUpdate(update, deps)]);
    expect(state.proposals).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("asks Tracker where the truck is, and tells Scout the truck is down, in the urgent-defect message", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      await handleBotTeamGroupUpdate(makeUpdateM("Maintenance, my tire is flat on truck 2"), deps);
      expect(sent[0]).toMatch(/\/handoff@DispatchScoutBot job=progress about=truck-down truck=2 defect=flat-tire hops=0/);
      expect(sent[0]).toMatch(/Dispatch Scout — truck 2 reported down \(flat tire\)/);
      expect(sent[0]).toMatch(/\/handoff@TrackerBot job=location truck=2 hops=0/);
      expect(sent[0]).toMatch(/Maintenance → Tracker: where is truck 2\?/);
    });
  });

  it("answers a known bot that replies to one of Maintenance's messages", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      await handleBotTeamGroupUpdate(
        makeUpdateM("Maintenance, what is due next?", 555, true, 57, {
          username: "DispatchScoutBot",
          replyTo: { username: "MaintenanceBot", text: "Oil change is due in 2,000 miles." },
        }),
        deps,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^Maintenance: Hi/);
    });
  });

  it("leaves unprompted bot chatter unanswered — logged by the room, answered by nobody", async () => {
    await withBotUsernames(async () => {
      const state: StubStateM = { proposals: [], spentCents: 0, audit: [], groupMessages: [], claims: new Map() };
      const { deps, sent } = makeDepsM(state);
      expect(
        await handleBotTeamGroupUpdate(
          makeUpdateM("found a load out of Dallas", 555, true, 58, { username: "DispatchScoutBot" }),
          deps,
        ),
      ).toBe("handled");
      expect(sent).toEqual([]);
      expect(state.groupMessages).toHaveLength(1);
    });
  });
});

// BT-003: a non-duplicate claim failure on the OWNER's message runs nothing, and Abel's webhook says so once.
describe("group claim fails closed (BT-003)", () => {
  it("transient claim error: no model turn; Abel's webhook tells the owner; another face stays silent", async () => {
    for (const receivingBot of ["abel", "dispatch-scout"] as const) {
      const state: StubState = emptyState();
      let modelCalled = false;
      const { deps, sent } = makeDeps(state, { receivingBot, runChat: async () => ((modelCalled = true), "x") });
      deps.store!.recordGroupMessage = async () => {
        throw new Error("connection reset");
      };
      await handleBotTeamGroupUpdate(makeUpdate("hey abel, what's my next load?"), deps);
      expect(modelCalled).toBe(false);
      expect(sent).toEqual(receivingBot === "abel" ? [expect.stringContaining("couldn't log that message")] : []);
    }
  });
});

// BT-006: the Telegram account decides who spoke; a prefix can't impersonate a bot that has its own account.
describe("sender identity (BT-006)", () => {
  it("Scout's account sending 'Billing: ...' is still Scout, and can't make Billing's loop guard misfire", async () => {
    const state: StubState = emptyState();
    const logged: { senderRef: string }[] = [];
    const { deps } = makeDeps(state);
    deps.store!.recordGroupMessage = async (input) => void logged.push({ senderRef: input.senderRef });
    await handleBotTeamGroupUpdate(makeUpdate("Abel: please book load 12", 777001, true, "DispatchScoutBot"), deps);
    expect(logged[0]?.senderRef).toBe("dispatch-scout");
  });
});

// ---- The team talks like a team (owner 2026-11-21, docs/design/bot-team-conversation.md) -------------
// His real group chat, replayed: canned "say 'scout, scan from <city, ST>'" lines, a false "I'll check",
// unprompted "Text only" replies to service messages, and no way to reach Scout without keywords.

type Script = (bot: string, messages: AiAgentMessage[], tools: string[]) => AiToolTurnResult;

function teamProvider(route: (text: string) => { to: string; ask: string }, script: Script) {
  const calls: { bot: string; tools: string[] }[] = [];
  const provider = {
    complete: async (req: { system: string; user: string }) => {
      const text = req.user.split("Owner's newest message: ")[1] ?? "";
      return JSON.stringify({ ...route(text), small_talk: false });
    },
    runToolTurn: async (messages: AiAgentMessage[], tools: { name: string }[]) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const bot = /You are ([A-Za-z ]+?),/.exec(String(system))?.[1] ?? "?";
      calls.push({ bot, tools: tools.map((t) => t.name) });
      return script(bot, messages, tools.map((t) => t.name));
    },
  };
  return { provider, calls };
}

const toolCall = (name: string, args: Record<string, unknown>): AiToolTurnResult => ({
  text: null,
  toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
});
const say = (text: string): AiToolTurnResult => ({ text, toolCalls: [] });
const afterTool = (messages: AiAgentMessage[]) => messages[messages.length - 1]?.role === "tool";

describe("the bot team talks like a team (owner 2026-11-21)", () => {
  it("a Telegram service message (a bot joined) gets NO reply — never 'Text only in the group'", async () => {
    const { deps, sent } = makeDeps(emptyState());
    const update = { update_id: 9, message: { message_id: 90, from: { id: OWNER_ID, is_bot: false }, chat: { id: GROUP_ID, type: "supergroup" }, new_chat_members: [{ id: 5, is_bot: true }] } } as unknown as TelegramUpdate;
    await handleBotTeamGroupUpdate(update, deps);
    expect(sent).toEqual([]);
  });

  it("'How's dispatch' reaches Scout, who answers like a person — no command help, no double name", async () => {
    const { provider, calls } = teamProvider(
      () => ({ to: "dispatch-scout", ask: "how dispatch is going" }),
      () => say("Quiet so far. Where's the truck, and where do you want to head next?"),
    );
    const { deps, sent } = makeDeps(emptyState(), { teamProvider: provider as never });
    await handleBotTeamGroupUpdate(makeUpdate("Hows dispach"), deps);
    expect(calls[0]!.bot).toBe("Dispatch Scout");
    expect(sent).toEqual(["Dispatch Scout: Quiet so far. Where's the truck, and where do you want to head next?"]);
    expect(sent.join(" ")).not.toMatch(/Say '|<city|scout, scan/);
  });

  it("'any lods frm oklahma to florda' (typos, no keywords) → Scout runs the board scan with the places filled in", async () => {
    let scanArgs: Record<string, unknown> | null = null;
    const { provider, calls } = teamProvider(
      () => ({ to: "dispatch-scout", ask: "loads from Oklahoma to Florida" }),
      (_bot, messages) => {
        if (afterTool(messages)) return say("On it — checking the boards from Oklahoma to Florida now.");
        scanArgs = { origin: "Oklahoma", destination: "Florida" };
        return toolCall("scan_load_boards", scanArgs);
      },
    );
    const { deps, sent } = makeDeps(emptyState(), { teamProvider: provider as never });
    await handleBotTeamGroupUpdate(makeUpdate("any lods frm oklahma to florda"), deps);
    expect(calls[0]!.tools).toContain("scan_load_boards");
    expect(scanArgs).toEqual({ origin: "Oklahoma", destination: "Florida" });
    expect(sent.at(-1)).toBe("Dispatch Scout: On it — checking the boards from Oklahoma to Florida now.");
  });

  it("a bot never promises work nothing started ('I'll check … let you know' with no tool or handoff)", async () => {
    const { provider } = teamProvider(
      () => ({ to: "abel", ask: "loads from Oklahoma to Florida" }),
      () => say("I'll check for loads going from Oklahoma to Florida right now. I'll let you know what I find soon."),
    );
    const { deps, sent } = makeDeps(emptyState(), { teamProvider: provider as never });
    await handleBotTeamGroupUpdate(makeUpdate("Any loads in Oklahoma to Florida ?"), deps);
    expect(sent.join(" ")).not.toMatch(/I'll let you know/);
    expect(sent.join(" ")).toMatch(/don't want to promise/);
  });

  it("Abel hands a load search to Scout by name, and Scout takes his turn on it", async () => {
    const { provider, calls } = teamProvider(
      () => ({ to: "abel", ask: "is there a load out of Oklahoma" }),
      (bot, messages) => {
        if (bot === "Abel") return afterTool(messages) ? say("That's Scout's department — passing it over.") : toolCall("hand_off", { to: "dispatch-scout", ask: "find a load out of Oklahoma" });
        return say("Got it — what equipment are you pulling?");
      },
    );
    const { deps, sent } = makeDeps(emptyState(), { teamProvider: provider as never });
    await handleBotTeamGroupUpdate(makeUpdate("isnt that dispatch job"), deps);
    expect(calls.map((c) => c.bot)).toEqual(["Abel", "Abel", "Dispatch Scout"]);
    expect(sent).toEqual([
      "Abel: That's Scout's department — passing it over.",
      "Abel: Dispatch Scout, find a load out of Oklahoma",
      "Dispatch Scout: Got it — what equipment are you pulling?",
    ]);
  });

  it("the room conversation goes into the turn, so 'is he live?' has a 'he'", async () => {
    const state = emptyState();
    let context = "";
    const { provider } = teamProvider(
      () => ({ to: "abel", ask: "is Malik live" }),
      (_bot, messages) => {
        context = String(messages.find((m) => m.role === "user")?.content ?? "");
        return say("Malik's the phone voice — he answers the company line. Want me to check his last calls?");
      },
    );
    const { deps } = makeDeps(state, { teamProvider: provider as never });
    deps.store!.listRecentGroupMessages = async () =>
      [{ id: "1", telegram_message_id: 1, sender_kind: "owner", sender_ref: String(OWNER_ID), text: "Malik", routed_to_bot_slug: null, created_at: "2026-11-21T15:00:00Z" }] as never;
    await handleBotTeamGroupUpdate(makeUpdate("Is he live ?"), deps);
    expect(context).toContain("Sajacous (owner): Malik");
  });

  it("every bot — including future ones — gets the human turn; no model = the old router still answers", async () => {
    const { deps, sent } = makeDeps(emptyState());
    await handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps);
    expect(sent.length).toBeGreaterThan(0);
  });
});
