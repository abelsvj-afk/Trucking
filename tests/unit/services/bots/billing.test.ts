// Billing bot: invoice math in code, speak/quiet + team-room
// handoffs, and the group turn. Money is integer cents; the model
// never invents an amount.
import { describe, expect, it, vi } from "vitest";
import {
  addDaysToDateString,
  auditInvoiceDraft,
  BILLING_VOICE_ID,
  billingCallPlan,
  billingInstructions,
  billingNeedsPodAsk,
  billingNeedsRateConAsk,
  billingRoomContribution,
  billingShouldSpeak,
  buildInvoiceDraft,
  buildRoomHandoff,
  daysBetweenDateStrings,
  detectShortPay,
  findLoadByPlace,
  findOpenProposalForLoad,
  formatDraftBlockedMessage,
  formatInvoiceReadyMessage,
  formatOverdueFlag,
  formatShortPayFlag,
  formatUnpaidSummary,
  handleBillingGroupTurn,
  invoiceState,
  type BillingBrokerRow,
  type BillingDataStore,
  type BillingInvoiceRow,
  type BillingLoadRow,
} from "@/services/bots/billing";
import { routeGroupMessage } from "@/services/bots/router";
import type { BotTeamStore, ProposalRow } from "@/services/bots/store";

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

function invoice(overrides: Partial<BillingInvoiceRow> = {}): BillingInvoiceRow {
  return {
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
    ...overrides,
  };
}

describe("invoice dates", () => {
  it("adds days across a month boundary", () => {
    expect(addDaysToDateString("2026-11-18", 30)).toBe("2026-12-18");
    expect(addDaysToDateString("2026-11-18", 21)).toBe("2026-12-09");
  });

  it("counts whole days between dates", () => {
    expect(daysBetweenDateStrings("2026-12-09", "2026-12-12")).toBe(3);
    expect(daysBetweenDateStrings("2026-12-09", "2026-12-09")).toBe(0);
  });
});

describe("invoice draft math", () => {
  it("invoices the rate confirmation total on the delivery date, due in the broker's terms", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: LOAD.rate_cents,
      deliveryDate: LOAD.delivery_date,
      paymentTermsDays: BROKER.payment_terms_days,
    });
    expect(draft.amountCents).toBe(185000);
    expect(draft.invoiceDate).toBe("2026-11-18");
    expect(draft.dueDate).toBe("2026-12-09");
    expect(draft.paymentTermsDays).toBe(21);
  });

  it("defaults to 30-day terms when the broker states none", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: "Unknown Broker",
      origin: "Dallas",
      destination: "Detroit",
      rateCents: 185000,
      deliveryDate: "2026-11-18",
      paymentTermsDays: null,
    });
    expect(draft.paymentTermsDays).toBe(30);
    expect(draft.dueDate).toBe("2026-12-18");
  });

  it("has no amount and no due date without a rate or a delivery date", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: "FastFreight",
      origin: "Dallas",
      destination: "Detroit",
      rateCents: null,
      deliveryDate: null,
    });
    expect(draft.amountCents).toBeNull();
    expect(draft.dueDate).toBeNull();
  });

  it("passes the audit when the amount equals the rate confirmation", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: LOAD.rate_cents,
      deliveryDate: LOAD.delivery_date,
      paymentTermsDays: 21,
    });
    const audit = auditInvoiceDraft(draft, LOAD.rate_cents);
    expect(audit.passed).toBe(true);
    expect(audit.flags).toHaveLength(0);
  });

  it("flags a mismatch with both figures, never a silent fix", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: LOAD.rate_cents,
      deliveryDate: LOAD.delivery_date,
      paymentTermsDays: 21,
    });
    const wrong = { ...draft, amountCents: 190000 };
    const audit = auditInvoiceDraft(wrong, LOAD.rate_cents);
    expect(audit.passed).toBe(false);
    expect(audit.flags[0]!.field).toBe("amount");
    expect(audit.flags[0]!.detail).toContain("$1,900.00");
    expect(audit.flags[0]!.detail).toContain("$1,850.00");
  });

  it("flags a missing rate confirmation as unverifiable, naming the missing piece", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: null,
      deliveryDate: LOAD.delivery_date,
    });
    const audit = auditInvoiceDraft(draft, null);
    expect(audit.flags.some((f) => f.field === "rate" && f.severity === "unverifiable")).toBe(true);
  });
});

describe("invoice status", () => {
  it("is unpaid before the due date, overdue after it", () => {
    expect(invoiceState(invoice(), "2026-11-20").status).toBe("unpaid");
    const overdue = invoiceState(invoice(), "2026-12-12");
    expect(overdue.status).toBe("overdue");
    expect(overdue.daysOverdue).toBe(3);
    expect(overdue.balanceCents).toBe(185000);
  });

  it("is paid only when paid in full — evidence, not a guess", () => {
    expect(invoiceState(invoice({ paid_amount_cents: 185000, paid_on: "2026-12-01" }), "2026-12-12").status).toBe("paid");
    expect(invoiceState(invoice({ paid_amount_cents: 100000 }), "2026-12-01").status).toBe("short-paid");
  });

  it("detects a short-pay with the evidence attached", () => {
    const short = detectShortPay(invoice({ paid_amount_cents: 150000 }));
    expect(short.shortPaid).toBe(true);
    expect(short.shortCents).toBe(35000);
    expect(detectShortPay(invoice({ paid_amount_cents: 185000 })).shortPaid).toBe(false);
    expect(detectShortPay(invoice()).shortPaid).toBe(false);
  });
});

describe("group-chat lines", () => {
  it("posts invoice-ready with amount, broker, due date, and the auditor's verdict", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: LOAD.rate_cents,
      deliveryDate: LOAD.delivery_date,
      paymentTermsDays: 21,
    });
    const msg = formatInvoiceReadyMessage(draft, auditInvoiceDraft(draft, LOAD.rate_cents));
    expect(msg).toContain("Billing — invoice ready");
    expect(msg).toContain("$1,850.00");
    expect(msg).toContain("FastFreight");
    expect(msg).toContain("due 2026-12-09");
    expect(msg).toContain("checks out");
    expect(msg).toContain("Reply Yes to approve");
  });

  it("flags overdue and short-pay with both figures", () => {
    expect(formatOverdueFlag(invoice(), "FastFreight", "2026-12-12")).toContain("overdue: $1,850.00 from FastFreight, due 2026-12-09, 3 days past due");
    expect(formatShortPayFlag(invoice({ paid_amount_cents: 150000 }), "FastFreight")).toContain("short $350.00");
    expect(formatShortPayFlag(invoice({ paid_amount_cents: 150000 }), "FastFreight")).toContain("invoice $1,850.00 vs payment $1,500.00");
  });

  it("summarises unpaid invoices and says plainly when none are open", () => {
    const summary = formatUnpaidSummary(
      [invoice(), invoice({ id: "inv-2", amount_cents: 90000, paid_amount_cents: 90000 })],
      new Map([["broker-1", "FastFreight"]]),
      "2026-11-20",
    );
    expect(summary).toContain("$1,850.00 from FastFreight");
    expect(summary).not.toContain("$900.00");
    expect(formatUnpaidSummary([invoice({ paid_amount_cents: 185000 })], new Map(), "2026-11-20")).toContain("nothing unpaid");
  });
});

describe("when Billing speaks (team room)", () => {
  const billingRoute = routeGroupMessage({ text: "Billing, what's unpaid?", senderKind: "owner" });
  const scoutRoute = routeGroupMessage({ text: "find me a load to Dallas", senderKind: "owner" });

  it("speaks when called by name or routed to it", () => {
    expect(billingShouldSpeak(billingRoute).speak).toBe(true);
    expect(billingShouldSpeak(billingRoute).reason).toBe("called-by-name");
    expect(billingShouldSpeak(scoutRoute, { abelRouted: true }).speak).toBe(true);
  });

  it("speaks on its own turn — invoice ready, overdue, short-pay", () => {
    expect(billingShouldSpeak(billingRoute, { ownTurn: true }).reason).toBe("called-by-name");
    const keyword = routeGroupMessage({ text: "that invoice is overdue", senderKind: "owner" });
    expect(billingShouldSpeak(keyword, { ownTurn: true }).speak).toBe(true);
  });

  it("stays quiet on another bot's job when it has nothing money-specific to add", () => {
    const decision = billingShouldSpeak(scoutRoute);
    expect(decision.speak).toBe(false);
    expect(decision.reason).toBe("not-my-job");
  });

  it("speaks once, to the room, when it has a concrete money fact for another bot's thread", () => {
    const decision = billingShouldSpeak(scoutRoute, { contribution: true });
    expect(decision.speak).toBe(true);
    expect(decision.reason).toBe("room-contribution");
  });

  it("answers an in-process handoff from another bot by name", () => {
    const decision = billingShouldSpeak(billingRoute, { fromBot: true });
    expect(decision.speak).toBe(true);
    expect(decision.reason).toBe("called-by-name");
  });
});

describe("handoffs by name", () => {
  it("asks Tracker for the signed POD and Scout for the rate confirmation", () => {
    expect(billingNeedsPodAsk(LOAD)).toContain("Tracker, I need the signed POD for Dallas → Detroit");
    expect(billingNeedsRateConAsk(LOAD)).toContain("Dispatch Scout, I need the rate confirmation details for Dallas → Detroit");
  });

  it("reports a blocked draft with what is missing and who holds it", () => {
    const draft = buildInvoiceDraft({
      loadId: LOAD.id,
      brokerName: BROKER.name,
      origin: LOAD.origin,
      destination: LOAD.destination,
      rateCents: null,
      deliveryDate: null,
    });
    const msg = formatDraftBlockedMessage(LOAD, auditInvoiceDraft(draft, null));
    expect(msg).toContain("invoice draft blocked");
    expect(msg).toContain("Tracker, I need the signed POD");
    expect(msg).toContain("Dispatch Scout, I need the rate confirmation");
    expect(msg).toContain("Nothing was drafted");
  });
});

describe("room contribution", () => {
  function dataStore(loads: BillingLoadRow[]): BillingDataStore {
    return {
      listInvoices: async () => [],
      listDeliveredLoadsWithoutInvoice: async () => loads,
      loadBroker: async () => BROKER,
    };
  }

  it("notes a POD-signed load that is waiting on an invoice", async () => {
    const note = await billingRoomContribution("POD signed for the Detroit load", dataStore([LOAD]));
    expect(note).toContain("Billing: POD noted");
    expect(note).toContain("Dallas → Detroit");
    expect(note).toContain("waiting on an invoice");
  });

  it("stays quiet with no delivery signal, no matching load, or no data", async () => {
    expect(await billingRoomContribution("find me a load", dataStore([LOAD]))).toBeNull();
    expect(await billingRoomContribution("POD signed", dataStore([]))).toBeNull();
    expect(await billingRoomContribution("POD signed for the Detroit load", null)).toBeNull();
    // Two loads match "Detroit" only if both name it — ambiguous means quiet.
    const other: BillingLoadRow = { ...LOAD, id: "load-2", origin: "Houston" };
    expect(await billingRoomContribution("POD signed for the Detroit load", dataStore([LOAD, other]))).toBeNull();
  });
});

describe("Billing's instructions and voice", () => {
  it("wires Bella's voice id and the shared number — never another voice", () => {
    expect(BILLING_VOICE_ID).toBe("hpp4J3VqNfWAUOO0d1Us");
    expect(billingInstructions().join("\n")).toContain("hpp4J3VqNfWAUOO0d1Us");
    expect(billingInstructions().join("\n")).toContain("+1 320-369-0102");
  });

  it("carries all fifteen reasoning forms and its scoped tools only", () => {
    const text = billingInstructions().join("\n");
    expect(text).toContain("TIME:");
    expect(text).toContain("KNOW WHEN TO STOP");
    expect(text).toContain("CHECK BEFORE YOU SEND");
    expect(text).toContain("Loads READ");
    expect(text).toContain("Email WRITE-GATED");
    expect(text).toContain("You have NO access to HOS or Maps");
    expect(text).toContain("Never send an invoice");
    expect(text).toContain("never finalise a settlement");
  });

  it("plans a broker call on the shared number with its voice, never dialing here", () => {
    const plan = billingCallPlan({ brokerName: "FastFreight", brokerPhone: "+1 555-0100", invoiceRef: "inv-1", purpose: "Payment status" });
    expect(plan.botSlug).toBe("billing");
    expect(plan.voiceId).toBe(BILLING_VOICE_ID);
    expect(plan.approvedProposalId).toBeNull();
    expect(plan.greeting).toContain("Road to Legacy Trucking");
  });
});

describe("findLoadByPlace", () => {
  it("matches one load by origin or destination city, and stays quiet on ambiguity", () => {
    expect(findLoadByPlace("invoice the Detroit load", [LOAD])?.id).toBe("load-1");
    expect(findLoadByPlace("invoice the Dallas load", [LOAD])?.id).toBe("load-1");
    expect(findLoadByPlace("invoice the load", [LOAD])).toBeNull();
    expect(findLoadByPlace("invoice the Detroit load", [LOAD, { ...LOAD, id: "load-2", origin: "Houston" }])).toBeNull();
  });
});

describe("Billing group turn", () => {
  interface StubState {
    proposals: ProposalRow[];
    spentCents: number;
    audit: { action: string; targetRef: string | null; detail?: Record<string, unknown> }[];
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
        if (!row) throw new Error("not found");
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
      recordGroupMessage: async () => {},
      findGroupMessage: async () => null,
      hasAuditorCheck: async () => false,
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
      loadBotMemories: async () => [],
    };
  }

  function makeData(overrides: Partial<BillingDataStore> = {}): BillingDataStore {
    return {
      listInvoices: async () => [invoice()],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
      ...overrides,
    };
  }

  async function runTurn(
    text: string,
    state: StubState,
    deps: { billingData?: BillingDataStore | null; runChat?: (input: { instructions: { content: string }[] }) => Promise<string | null> },
  ): Promise<string[]> {
    const sent: string[] = [];
    const route = routeGroupMessage({ text, senderKind: "owner" });
    await handleBillingGroupTurn(1, text, route, {
      store: makeStore(state),
      billingData: deps.billingData ?? makeData(),
      sendMessage: async (_chatId, msg) => {
        sent.push(msg);
        return [1];
      },
      runChat: deps.runChat as never,
    });
    return sent;
  }

  it("answers what's-unpaid from the records, in code — no model call", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const runChat = vi.fn(async () => "should not run");
    const sent = await runTurn("Billing, what's unpaid?", state, { runChat });
    expect(runChat).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Billing — unpaid invoices:");
    expect(sent[0]).toContain("$1,850.00 from FastFreight");
  });

  it("works a delivered load into an auditor-checked invoice-draft proposal", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const sent = await runTurn("Billing, invoice the Detroit load", state, {});
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("invoice-draft");
    expect(state.proposals[0]!.bot_slug).toBe("billing");
    expect(state.proposals[0]!.payload.amountCents).toBe(185000);
    expect(state.proposals[0]!.payload.dueDate).toBe("2026-12-09");
    expect(sent[0]).toContain("Billing — invoice ready");
    expect(sent[0]).toContain("Reply Yes to approve");
  });

  it("blocks a draft with no rate, asks Scout by name, and records the handoff — no proposal", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const noRate: BillingLoadRow = { ...LOAD, rate_cents: null };
    const sent = await runTurn("Billing, invoice the Detroit load", state, {
      billingData: makeData({ listDeliveredLoadsWithoutInvoice: async () => [noRate] }),
    });
    expect(state.proposals).toHaveLength(0);
    expect(sent[0]).toContain("invoice draft blocked");
    expect(sent[0]).toContain("Dispatch Scout, I need the rate confirmation");
    expect(state.audit.some((a) => a.action === "handoff_requested" && a.detail?.to === "dispatch-scout")).toBe(true);
  });

  it("asks which load when several delivered loads wait on an invoice", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const other: BillingLoadRow = { ...LOAD, id: "load-2", origin: "Houston", destination: "Atlanta" };
    const sent = await runTurn("Billing, draft an invoice", state, {
      billingData: makeData({ listDeliveredLoadsWithoutInvoice: async () => [LOAD, other] }),
    });
    expect(state.proposals).toHaveLength(0);
    expect(sent[0]).toContain("which delivered load?");
  });

  it("says plainly when no delivered load waits on an invoice", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const sent = await runTurn("Billing, invoice the Detroit load", state, {
      billingData: makeData({ listDeliveredLoadsWithoutInvoice: async () => [] }),
    });
    expect(sent[0]).toContain("no delivered load is waiting on an invoice");
  });

  it("pulls a factoring packet as a proposal, never sending from here", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const sent = await runTurn("Billing, factor the FastFreight invoice", state, {});
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe("factoring-packet");
    expect(state.proposals[0]!.payload.includes).toEqual(["invoice", "rate-confirmation", "pod"]);
    expect(sent[0]).toContain("factoring packet ready");
  });

  it("answers a general billing question with Billing's own instructions, never Abel's", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    let captured: { content: string }[] = [];
    const runChat = vi.fn(async (input: { instructions: { content: string }[] }) => {
      captured = input.instructions;
      return "Brokers usually pay in 15–45 days.";
    });
    const sent = await runTurn("Billing, how long do brokers take to pay?", state, { runChat });
    expect(runChat).toHaveBeenCalledTimes(1);
    const text = captured.map((row) => row.content).join("\n");
    expect(text).toContain("You are Billing");
    expect(text).toContain("TIME:");
    expect(text).toContain("KNOW WHEN TO STOP");
    expect(text).not.toContain("You are the assistant inside this driver's own trucking app");
    expect(sent[0]).toMatch(/^Billing: Brokers usually pay/);
    expect(state.spentCents).toBeGreaterThan(0);
  });

  it("answers an in-process handoff from Tracker by name", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    const sent: string[] = [];
    const runChat = vi.fn(async () => "Got it — I'll draft it now.");
    const route = routeGroupMessage({ text: "Billing, POD signed for Detroit", senderKind: "bot", senderSlug: "tracker" });
    await handleBillingGroupTurn(
      1,
      "Billing, POD signed for Detroit",
      route,
      {
        store: makeStore(state),
        billingData: makeData(),
        sendMessage: async (_chatId, msg) => {
          sent.push(msg);
          return [1];
        },
        runChat: runChat as never,
      },
      { fromBot: "tracker" },
    );
    expect(sent[0]).toContain("Billing: Tracker, Got it");
  });
});

describe("Room handoffs (validated state only)", () => {
  function makeData(): BillingDataStore {
    return {
      listInvoices: async () => [invoice()],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
    };
  }

  it("builds a pod-ready handoff with the matched load, not raw text", async () => {
    const handoff = await buildRoomHandoff("tracker", "Tracker: Billing, POD signed for the Dallas → Detroit load", makeData());
    expect(handoff.kind).toBe("pod-ready");
    expect(handoff.from).toBe("tracker");
    expect(handoff.to).toBe("billing");
    expect(handoff.loadId).toBe("load-1");
    expect(handoff.loadRef).toBe("Dallas → Detroit");
    expect(handoff.summary.length).toBeLessThanOrEqual(240);
    expect(handoff.summary).toContain("Tracker");
    expect(handoff.summary).not.toContain("Tracker: Billing, POD signed for the Dallas");
  });

  it("builds a rate-con-ready handoff for Dispatch Scout", async () => {
    const handoff = await buildRoomHandoff("dispatch-scout", "Dispatch Scout: Billing, rate confirmation in hand for the Detroit load", makeData());
    expect(handoff.kind).toBe("rate-con-ready");
    expect(handoff.loadId).toBe("load-1");
  });

  it("hands off as general with no load when nothing matches", async () => {
    const handoff = await buildRoomHandoff("tracker", "Tracker: Billing, what time is the meeting?", makeData());
    expect(handoff.kind).toBe("general");
    expect(handoff.loadId).toBeNull();
  });
});

describe("Idempotent proposals (one open draft per load)", () => {
  interface StubState {
    proposals: ProposalRow[];
    spentCents: number;
    audit: { action: string; targetRef: string | null; detail?: Record<string, unknown> }[];
  }

  function makeStore(state: StubState): BotTeamStore {
    let seq = 100;
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
        if (!row) throw new Error("not found");
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
      recordGroupMessage: async () => {},
      findGroupMessage: async () => null,
      hasAuditorCheck: async () => false,
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
      loadBotMemories: async () => [],
    };
  }

  function makeData(): BillingDataStore {
    return {
      listInvoices: async () => [invoice()],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
    };
  }

  function seedProposal(state: StubState, kind: "invoice-draft" | "factoring-packet"): void {
    state.proposals.push({
      id: `proposal-seeded-${kind}`,
      company_id: "company-1",
      bot_slug: "billing",
      kind,
      title: `Seeded ${kind} — $1,850.00 from FastFreight, Dallas → Detroit`,
      payload: {},
      source_ref: "telegram-group:load-1",
      status: "proposed",
      created_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
    });
  }

  it("findOpenProposalForLoad finds the open draft by idempotency key", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    seedProposal(state, "invoice-draft");
    const found = await findOpenProposalForLoad(makeStore(state), "invoice-draft", "load-1");
    expect(found?.id).toBe("proposal-seeded-invoice-draft");
    expect(await findOpenProposalForLoad(makeStore(state), "factoring-packet", "load-1")).toBeNull();
    expect(await findOpenProposalForLoad(makeStore(state), "invoice-draft", "load-9")).toBeNull();
  });

  it("a second draft ask for the same load points at the open proposal instead of duplicating it", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    seedProposal(state, "invoice-draft");
    const sent: string[] = [];
    const route = routeGroupMessage({ text: "Billing, invoice the Detroit load", senderKind: "owner" });
    await handleBillingGroupTurn(
      1,
      "Billing, invoice the Detroit load",
      route,
      {
        store: makeStore(state),
        billingData: makeData(),
        sendMessage: async (_chatId, msg) => {
          sent.push(msg);
          return [1];
        },
      },
    );
    expect(state.proposals).toHaveLength(1);
    expect(sent[0]).toContain("already waiting on your yes");
  });

  it("a second factoring ask for the same load points at the open packet instead of duplicating it", async () => {
    const state: StubState = { proposals: [], spentCents: 0, audit: [] };
    seedProposal(state, "factoring-packet");
    const sent: string[] = [];
    const route = routeGroupMessage({ text: "Billing, factor the FastFreight invoice", senderKind: "owner" });
    await handleBillingGroupTurn(
      1,
      "Billing, factor the FastFreight invoice",
      route,
      {
        store: makeStore(state),
        billingData: makeData(),
        sendMessage: async (_chatId, msg) => {
          sent.push(msg);
          return [1];
        },
      },
    );
    expect(state.proposals).toHaveLength(1);
    expect(sent[0]).toContain("already waiting on your yes");
  });
});

describe("Handoff in the model turn", () => {
  it("the model sees the handoff as one validated summary line, never the raw chat", async () => {
    const state: { proposals: ProposalRow[]; spentCents: number; audit: { action: string; targetRef: string | null }[] } = {
      proposals: [],
      spentCents: 0,
      audit: [],
    };
    const store: BotTeamStore = {
      companyId: "company-1",
      createProposal: async () => {
        throw new Error("not used");
      },
      listOpenProposals: async () => [],
      getProposal: async () => null,
      decideProposal: async () => {
        throw new Error("not used");
      },
      logAudit: async () => {},
      recordLoadOutcome: async () => {},
      ensureGroupRoom: async () => {},
      recordGroupMessage: async () => {},
      findGroupMessage: async () => null,
      hasAuditorCheck: async () => false,
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
      loadBotMemories: async () => [],
    };
    const data: BillingDataStore = {
      listInvoices: async () => [invoice()],
      listDeliveredLoadsWithoutInvoice: async () => [LOAD],
      loadBroker: async () => BROKER,
    };
    // A rate-con-ready handoff reaches the model turn. A pod-ready
    // handoff does not: it drafts the invoice directly (same-day
    // rule — covered by the group tests, "a POD note from Tracker
    // addressed to Billing drafts the invoice — once").
    const handoff = await buildRoomHandoff("tracker", "Tracker: Billing, rate confirmation in hand for the Dallas → Detroit load", data);
    const seenInstructions: string[] = [];
    const runChat = vi.fn(async (input: { instructions: { content: string }[] }) => {
      for (const row of input.instructions) seenInstructions.push(row.content);
      return "On it.";
    });
    const sent: string[] = [];
    const route = routeGroupMessage({ text: "Billing, the rate confirmation is in for Detroit", senderKind: "bot", senderSlug: "tracker" });
    await handleBillingGroupTurn(
      1,
      "Billing, the rate confirmation is in for Detroit",
      route,
      {
        store,
        billingData: data,
        sendMessage: async (_chatId, msg) => {
          sent.push(msg);
          return [1];
        },
        runChat: runChat as never,
      },
      { fromBot: "tracker", handoff },
    );
    expect(seenInstructions.some((content) => content.includes("Handoff from Tracker") && content.includes("rate confirmation in hand"))).toBe(true);
    expect(seenInstructions.some((content) => content.includes("Tracker: Billing, rate confirmation in hand for the Dallas"))).toBe(false);
    expect(sent[0]).toContain("Billing: Tracker, On it.");
  });
});
