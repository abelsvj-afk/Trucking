// Business Credit email watch (docs/design/business-credit.md §4):
// vendor match is data-driven, classification is missed-first,
// updates touch ONLY payment fields, missed routes urgent through
// deliveryDecision (straight through quiet hours), routine holds and
// flushes on a later pass, and every signal is audit-logged with its
// source email.

import { describe, expect, it } from "vitest";
import {
  detectPaymentSignal,
  deliveryClassFor,
  extractAmountCents,
  extractDueDate,
  matchVendorAccount,
  paymentPatchFor,
  runBusinessCreditWatch,
  type WatchMessage,
} from "@/services/business-credit/watch";
import type { BusinessCreditStore } from "@/services/business-credit/store";
import type {
  BusinessCreditAccount,
  BusinessCreditEvent,
} from "@/types/entities";

const NOON_ET = new Date("2026-11-10T17:00:00Z"); // 12:00 EST
const QUIET_ET = new Date("2026-11-10T08:00:00Z"); // 03:00 EST

function account(over: Partial<BusinessCreditAccount> = {}): BusinessCreditAccount {
  return {
    id: "acct-quill",
    company_id: "company-1",
    vendor: "Quill",
    vendor_key: "quill",
    status: "Account established",
    reports_to: ["Dun & Bradstreet"],
    next_action: null,
    payment_state: "none",
    next_due_date: null,
    amount_due_cents: null,
    match_senders: ["quill.com"],
    notes: null,
    sort_order: 2,
    created_at: "2026-11-10T00:00:00Z",
    updated_at: "2026-11-10T00:00:00Z",
    deleted_at: null,
    ...over,
  };
}

function msg(over: Partial<WatchMessage> = {}): WatchMessage {
  return {
    rowId: "email-row-1",
    serverMessageId: "<m1@quill.com>",
    fromAddress: "billing@quill.com",
    fromName: "Quill",
    subject: "Your Quill invoice is ready",
    bodyText: "Invoice total: $112.06. Amount due: $112.06. Payment due January 5, 2027.",
    ...over,
  };
}

interface FakeState {
  accounts: BusinessCreditAccount[];
  events: Record<string, unknown>[];
  patches: { id: string; patch: Record<string, unknown> }[];
  heldEvents: BusinessCreditEvent[];
  duty: string | null;
}

function fakeStore(state: FakeState): BusinessCreditStore {
  return {
    loadAccounts: async () => state.accounts,
    findWatchEvent: async (accountId, emailRowId) =>
      state.events.some(
        (e) => e.account_id === accountId && e.email_message_id === emailRowId,
      )
        ? { id: "existing" }
        : null,
    applyPaymentUpdate: async (id, patch) => {
      state.patches.push({ id, patch: patch as Record<string, unknown> });
      const a = state.accounts.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
    },
    recordEvent: async (row) => {
      state.events.push(row);
      return { id: `event-${state.events.length}` };
    },
    loadHeldEvents: async () => state.heldEvents,
    markBuzzSent: async (eventId) => {
      const e = state.heldEvents.find((x) => x.id === eventId);
      if (e) e.buzz_state = "sent";
    },
    markBuzzHeld: async () => undefined,
    latestDutyStatus: async () => state.duty,
  };
}

function freshState(): FakeState {
  return { accounts: [account()], events: [], patches: [], heldEvents: [], duty: null };
}

describe("vendor matching (data-driven)", () => {
  it("matches by domain and subdomain, never by lookalike", () => {
    const accounts = [account()];
    expect(matchVendorAccount(accounts, { fromAddress: "billing@quill.com" })?.vendor_key).toBe("quill");
    expect(matchVendorAccount(accounts, { fromAddress: "x@mail.quill.com" })?.vendor_key).toBe("quill");
    expect(matchVendorAccount(accounts, { fromAddress: "x@notquill.com" })).toBeNull();
    expect(matchVendorAccount(accounts, { fromAddress: "x@quill.com.evil.example" })).toBeNull();
    expect(matchVendorAccount(accounts, { fromAddress: "someone@gmail.com" })).toBeNull();
  });
});

describe("signal detection", () => {
  it("missed wins over due wording", () => {
    const d = detectPaymentSignal({ subject: "Your payment is past due", bodyText: "Amount due: $40.00. Due date was November 1, 2026." });
    expect(d?.signal).toBe("missed");
  });
  it("payment made beats invoice wording", () => {
    const d = detectPaymentSignal({ subject: "Payment received", bodyText: "We received your payment for invoice 123." });
    expect(d?.signal).toBe("payment_made");
  });
  it("invoice with explicit date + amount extracts both", () => {
    const d = detectPaymentSignal(msg());
    expect(d?.signal).toBe("invoice");
    expect(d?.dueDate).toBe("2027-01-05");
    expect(d?.amountCents).toBe(11206);
  });
  it("no signal in ordinary vendor mail", () => {
    expect(detectPaymentSignal({ subject: "Your order shipped", bodyText: "Thanks for shopping." })).toBeNull();
  });
  it("never invents a due date or amount", () => {
    expect(extractDueDate("Your invoice is ready. Please pay soon.")).toBeNull();
    expect(extractAmountCents("Your invoice is ready.")).toBeNull();
    expect(extractDueDate("Payment due 2027-02-30")).toBeNull();
  });
  it("payment-made patch clears the due date and amount", () => {
    const patch = paymentPatchFor({ signal: "payment_made", dueDate: null, amountCents: null });
    expect(patch).toEqual({ payment_state: "paid", next_due_date: null, amount_due_cents: null });
  });
  it("delivery classes: missed urgent, the rest routine", () => {
    expect(deliveryClassFor("missed")).toBe("urgent");
    expect(deliveryClassFor("invoice")).toBe("routine");
    expect(deliveryClassFor("due_date")).toBe("routine");
    expect(deliveryClassFor("payment_made")).toBe("routine");
  });
});

describe("runBusinessCreditWatch", () => {
  it("invoice at noon ET: updates payment fields ONLY, buzzes, audit-logs with the email id", async () => {
    const state = freshState();
    const sent: string[] = [];
    const res = await runBusinessCreditWatch(
      { store: fakeStore(state), notify: async (t) => (sent.push(t), true), now: () => NOON_ET },
      [msg()],
    );
    expect(res).toMatchObject({ matched: 1, updated: 1, buzzed: 1, held: 0 });
    expect(state.patches).toHaveLength(1);
    expect(Object.keys(state.patches[0]!.patch).sort()).toEqual(
      ["amount_due_cents", "next_due_date", "payment_state"].sort(),
    );
    expect(state.patches[0]!.patch).toMatchObject({
      payment_state: "invoice_open",
      next_due_date: "2027-01-05",
      amount_due_cents: 11206,
    });
    expect(state.accounts[0]!.status).toBe("Account established"); // phase untouched
    expect(sent[0]).toContain("Quill");
    const event = state.events[0]!;
    expect(event).toMatchObject({
      source: "email_watch",
      signal: "invoice",
      email_message_id: "email-row-1",
      email_server_message_id: "<m1@quill.com>",
      buzz_state: "sent",
    });
  });

  it("missed at 3 AM ET sends STRAIGHT THROUGH quiet hours (urgent)", async () => {
    const state = freshState();
    const sent: string[] = [];
    const res = await runBusinessCreditWatch(
      { store: fakeStore(state), notify: async (t) => (sent.push(t), true), now: () => QUIET_ET },
      [msg({ subject: "Your Quill payment is past due", bodyText: "Amount due: $40.00." })],
    );
    expect(res.buzzed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(state.accounts[0]!.payment_state).toBe("missed");
    expect(state.events[0]).toMatchObject({ signal: "missed", buzz_state: "sent" });
  });

  it("routine at 3 AM ET: the UPDATE lands immediately, the buzz holds", async () => {
    const state = freshState();
    const sent: string[] = [];
    const res = await runBusinessCreditWatch(
      { store: fakeStore(state), notify: async (t) => (sent.push(t), true), now: () => QUIET_ET },
      [msg()],
    );
    expect(res).toMatchObject({ updated: 1, buzzed: 0, held: 1 });
    expect(sent).toHaveLength(0);
    expect(state.accounts[0]!.payment_state).toBe("invoice_open");
    expect(state.events[0]).toMatchObject({ buzz_state: "held" });
  });

  it("a held buzz flushes on a later pass once the gate opens", async () => {
    const state = freshState();
    state.heldEvents = [
      {
        id: "event-held",
        company_id: "company-1",
        account_id: "acct-quill",
        source: "email_watch",
        signal: "invoice",
        email_message_id: "email-row-0",
        email_server_message_id: null,
        summary: "Quill invoice",
        detail: {},
        buzz_state: "held",
        buzz_text: "Business credit — Quill: a new invoice.",
        buzz_sent_at: null,
        created_at: "2026-11-10T08:00:00Z",
        updated_at: "2026-11-10T08:00:00Z",
        deleted_at: null,
      },
    ];
    const sent: string[] = [];
    const res = await runBusinessCreditWatch(
      { store: fakeStore(state), notify: async (t) => (sent.push(t), true), now: () => NOON_ET },
      [],
    );
    expect(res.flushed).toBe(1);
    expect(sent).toEqual(["Business credit — Quill: a new invoice."]);
    expect(state.heldEvents[0]!.buzz_state).toBe("sent");
  });

  it("the same email is never watched twice (dedupe by account+email)", async () => {
    const state = freshState();
    const deps = { store: fakeStore(state), notify: async () => true, now: () => NOON_ET };
    await runBusinessCreditWatch(deps, [msg()]);
    const second = await runBusinessCreditWatch(deps, [msg()]);
    expect(second.updated).toBe(0);
    expect(state.events).toHaveLength(1);
    expect(state.patches).toHaveLength(1);
  });

  it("non-vendor mail is ignored entirely", async () => {
    const state = freshState();
    const res = await runBusinessCreditWatch(
      { store: fakeStore(state), notify: async () => true, now: () => NOON_ET },
      [msg({ fromAddress: "deals@spammy.example", subject: "Your payment is past due" })],
    );
    expect(res.matched).toBe(0);
    expect(state.events).toHaveLength(0);
  });
});
