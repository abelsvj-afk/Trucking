// Propose-only guardrails, enforced in code. A bot may read, draft,
// and flag on its own; anything execute-class needs an approved
// proposal — and in Phase 0 there is no execution path at all, so
// even an approved proposal refuses with a plain reason.
import { describe, expect, it } from "vitest";
import { checkBotAction, proposalIsLive, PROPOSAL_EXPIRY_MS } from "@/services/bots/guardrails";

describe("bot guardrails", () => {
  it("lets Dispatch Scout draft on app actions but not draft loads directly", () => {
    expect(checkBotAction({ botSlug: "dispatch-scout", actionKind: "draft_load", group: "app-actions" }).allowed).toBe(true);
    const denied = checkBotAction({ botSlug: "dispatch-scout", actionKind: "draft_load", group: "loads" });
    expect(denied.allowed).toBe(false);
  });

  it("denies every execute-class action without an approved proposal", () => {
    for (const actionKind of ["book_load", "pay", "send_to_broker", "sign_document", "change_hos_log", "delete_record"] as const) {
      const verdict = checkBotAction({ botSlug: "abel", actionKind, group: "loads" });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(/approved proposal/);
    }
  });

  it("still refuses execute-class actions WITH an approved proposal in Phase 0 — no execution path exists yet", () => {
    const verdict = checkBotAction({ botSlug: "abel", actionKind: "book_load", group: "loads", hasApprovedProposal: true });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/no execution path/i);
  });

  it("lets Maintenance draft work orders and call plans on app actions, and file defect records on documents", () => {
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "draft_work_order", group: "app-actions" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "draft_call_plan", group: "app-actions" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "internal_note", group: "documents" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "draft_message", group: "email" }).allowed).toBe(true);
  });

  it("never lets Maintenance touch HOS, flag, or draft on a group it cannot see", () => {
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "read", group: "hos" }).allowed).toBe(false);
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "flag", group: "loads" }).allowed).toBe(false);
    expect(checkBotAction({ botSlug: "maintenance", actionKind: "draft_work_order", group: "loads" }).allowed).toBe(false);
  });

  it("treats messaging a shop/vendor as execute-class: denied without approval, and still denied with one — no execution path yet", () => {
    const denied = checkBotAction({ botSlug: "maintenance", actionKind: "send_to_vendor", group: "email" });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toMatch(/approved proposal/);
    const approved = checkBotAction({ botSlug: "maintenance", actionKind: "send_to_vendor", group: "email", hasApprovedProposal: true });
    expect(approved.allowed).toBe(false);
    if (!approved.allowed) expect(approved.reason).toMatch(/no execution path/i);
  });

  it("treats a call-out as execute-class for Maintenance too — a call plan is a proposal, never a dial", () => {
    const verdict = checkBotAction({ botSlug: "maintenance", actionKind: "call_outbound", group: "calls" });
    expect(verdict.allowed).toBe(false);
  });
  it("lets the Auditor flag but never draft or read-write", () => {
    expect(checkBotAction({ botSlug: "auditor", actionKind: "flag", group: "loads" }).allowed).toBe(true);
    expect(checkBotAction({ botSlug: "auditor", actionKind: "draft_load", group: "app-actions" }).allowed).toBe(false);
    expect(checkBotAction({ botSlug: "auditor", actionKind: "read", group: "money" }).allowed).toBe(true);
  });

  it("denies an unknown bot everything", () => {
    expect(checkBotAction({ botSlug: "mallory", actionKind: "read", group: "loads" }).allowed).toBe(false);
  });

  it("treats a proposal as live only while proposed and inside its deadline", () => {
    const now = Date.now();
    expect(proposalIsLive({ status: "proposed", created_at: new Date(now - 1000).toISOString() }, now)).toBe(true);
    expect(proposalIsLive({ status: "approved", created_at: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(proposalIsLive({ status: "proposed", created_at: new Date(now - PROPOSAL_EXPIRY_MS - 1000).toISOString() }, now)).toBe(false);
  });
});
