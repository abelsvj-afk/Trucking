// Bot-team group mode: fail-closed allowlist, owner-only room, routing,
// proposal yes/no in plain words, spend cap in front of the model.
import { describe, expect, it, vi } from "vitest";
import { handleBotTeamGroupUpdate, isMissingTableError, resetGroupSetupNotices, type GroupHandlerDeps } from "@/services/bots/group";
import type { BillingBrokerRow, BillingDataStore, BillingLoadRow } from "@/services/bots/billing";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";
import type { TelegramUpdate } from "@/services/telegram/dispatch-bot";
import { SPEND_CAP_REACHED_TEXT } from "@/services/bots/spend";

const OWNER_ID = 8975172276;
const GROUP_ID = -1001234567890;

function makeUpdate(text: string, fromId: number = OWNER_ID, isBot = false, username?: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: fromId, is_bot: isBot, ...(username ? { username } : {}) },
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
    findGroupMessage: async () => null,
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
    loadBotMemories: async () =>
      (state.memories ?? []).map((memory, index) => ({
        id: `memory-${index + 1}`,
        bot_slug: "dispatch-scout",
        kind: "preference",
        source: "test",
        content: memory.content,
        created_at: new Date().toISOString(),
      })),
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

  it("records a bot's room chatter without acting on it — bot messages start no model turn, workup, or decision", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("noted", OWNER_ID, true), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
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

  it("sends Scout's replies from his own bot when scoutSendMessage is wired", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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

  it("seats Billing: what's-unpaid is answered from the records, in money facts", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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

  it("adds Billing's note after an unseated POD notice — the invoice can now be drafted", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    await handleBotTeamGroupUpdate(makeUpdate("POD signed for the Detroit load"), deps);
    expect(sent[0]).toMatch(/isn't in the room yet/);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Billing: POD noted");
    expect(sent[1]).toContain("waiting on an invoice");
  });

  it("works a Billing invoice draft into a proposal and approves it on 'yes'", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    expect(await handleBotTeamGroupUpdate(makeBotUpdate("Billing: invoice ready — $1,850.00 from FastFreight"), deps)).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("a reply to one of Billing's messages is addressed to Billing even without naming it", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, { billingData: makeBillingData() });
    const store = deps.store!;
    store.findGroupMessage = async () => ({ senderKind: "bot", senderRef: "billing", text: "Billing: which load?" });
    const result = await handleBotTeamGroupUpdate(makeBotUpdate("Tracker: here it is — POD attached", 21, 7), deps);
    expect(result).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Billing");
  });

  it("a message claimed once is not answered twice (duplicate delivery)", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
      state.groupMessages.push({ text: input.text });
    };
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("ignored");
    expect(sent).toHaveLength(1);
  });

  it("the same bot message delivered twice runs Billing's turn once", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state, {
      billingData: makeBillingData(),
      runChat: async () => "All good — nothing to do.",
    });
    expect(await handleBotTeamGroupUpdate(makeUpdate("hey Abel"), deps)).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(state.proposals).toEqual([]);
  });

  it("no fan-out once Billing's own webhook is live (Telegram delivers it instead)", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    // Team room: the Auditor speaks TO the draft's author, by name,
    // and asks for the missing source instead of failing silently.
    // The draft has no rate and no windows: the Auditor says so, it does not guess.
    expect(sent[sent.length - 1]).toMatch(/^Dispatch Scout — I can't finish checking "/);
    expect(sent[sent.length - 1]).toMatch(/Post the source and I'll re-run it\./);
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

  it("a teammate's message naming the Auditor runs the check — the group is the shared channel (Bot-to-Bot Mode)", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(await handleBotTeamGroupUpdate(makeUpdate("found a good load to Dallas", 999, true), deps)).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.groupMessages).toHaveLength(1);
  });

  it("a bot's 'yes' never decides a proposal — only the owner decides", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    const { deps, sent } = makeDeps(state);
    expect(
      await handleBotTeamGroupUpdate(makeUpdate("Dispatch Scout, scan from Dallas", 999, true), deps),
    ).toBe("handled");
    expect(sent).toEqual([]);
    expect(state.proposals).toHaveLength(0);
  });

  it("the Auditor flags a draft TO its author by name, with both numbers shown", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
// Audit F-023/F-024: the cap is fail-closed and reserved BEFORE the call.
describe("Abel's spend cap in the group (audit F-023/F-024)", () => {
  it("no bot-team store: no cap check, so no model call — and says why", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
    let modelCalled = false;
    const { deps, sent } = makeDeps(state, { store: null, runChat: async () => ((modelCalled = true), "x") });
    await handleBotTeamGroupUpdate(makeUpdate("hey abel, good morning"), deps);
    expect(modelCalled).toBe(false);
    expect(sent.join(" ")).toContain("won't call the model");
  });

  it("two turns at once with room for one: only one reaches the model", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [], groupMessages: [] };
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
