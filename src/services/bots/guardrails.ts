// Propose-only guardrails, enforced in code — not just in the bots'
// governing MD files (docs/bots/<slug>/CLAUDE.md).
//
// The rule, in one line: a bot may read, draft, and flag on its own;
// anything anyone outside the app would see, or that changes the
// business, is a proposal first, and the owner's tap approves it.
// An approval unanswered by its deadline counts as denied.
//
// This module is the gate. It decides; it does not execute. There is
// deliberately NO execution path in the Phase 0 baseline: an approved
// proposal is a durable record (bot_proposals), and turning an approved
// proposal into a load / record / message is a Phase 1 build. A gate
// that said "allowed" with nowhere to execute would be a lie, so an
// execute-class action with an approved proposal is still refused here
// — with a reason that says exactly that — until the execution path
// exists. Fail closed, always.

import { canDraft, canFlag, canRead, isBotSlug, type BotSlug, type ToolGroup } from "./registry";

/** Actions that change the world outside the app, or the business. */
export const EXECUTE_ACTION_KINDS = [
  "book_load",
  "pay",
  "move_money",
  "send_to_broker",
  "send_to_shipper",
  "send_to_driver",
  "send_to_vendor",
  "sign_document",
  "file_document",
  "change_hos_log",
  "delete_record",
  "change_permissions",
  "call_outbound",
] as const;

export type ExecuteActionKind = (typeof EXECUTE_ACTION_KINDS)[number];

/** Actions that stay inside the app: drafts, notes, shortlists. */
export const DRAFT_ACTION_KINDS = [
  "draft_load",
  "draft_shortlist",
  "draft_message",
  "draft_invoice",
  "draft_work_order",
  "draft_call_plan",
  "internal_note",
  // Tracker internal writes (governing file: reversible internal writes
  // are automatic) — check-call log, load status/ETA update, POD/BOL
  // filing, detention-clock start. Anything anyone outside the app
  // would see stays execute-class (send_to_broker, send_to_shipper,
  // call_outbound) and needs an approved proposal.
  "log_check_call",
  "update_load_status",
  // "record_document" is the internal write — recording a received
  // POD/BOL in the packet. It is NOT the execute-class "file_document"
  // (filing a document with an outside party), which stays denied
  // without an approved proposal. Same word, different action.
  "record_document",
  "start_detention",
] as const;

export type DraftActionKind = (typeof DRAFT_ACTION_KINDS)[number];

export type BotActionKind = ExecuteActionKind | DraftActionKind | "read" | "flag";

export function isExecuteAction(kind: string): kind is ExecuteActionKind {
  return (EXECUTE_ACTION_KINDS as readonly string[]).includes(kind);
}

export function isDraftAction(kind: string): kind is DraftActionKind {
  return (DRAFT_ACTION_KINDS as readonly string[]).includes(kind);
}

/** Default proposal deadline: 24 hours. Unanswered = denied. */
export const PROPOSAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type GuardrailVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface GuardrailCheckInput {
  botSlug: string;
  actionKind: BotActionKind;
  /** Tool group the action touches (loads, money, ...). */
  group: ToolGroup;
  /** An approved proposal for this exact action, when one exists. */
  hasApprovedProposal?: boolean;
}

/**
 * The gate. Pure — no database, no network — so every caller gets the
 * same answer and the tests can prove it.
 *
 * - Unknown bot: denied.
 * - Read: allowed only inside the bot's scope.
 * - Draft: allowed only inside the bot's draft scope.
 * - Flag: allowed only for bots with flag scope on that group.
 * - Execute-class: denied without an approved proposal (the attempt is
 *   a blocked attempt — the caller logs it to bot_audit_log); denied
 *   WITH an approved proposal too in Phase 0, because no execution
 *   path exists yet. The reason says so plainly.
 */
export function checkBotAction(input: GuardrailCheckInput): GuardrailVerdict {
  const { botSlug, actionKind, group } = input;
  if (!isBotSlug(botSlug)) {
    return { allowed: false, reason: `Unknown bot "${botSlug}" — no bot may act without an identity.` };
  }
  if (isExecuteAction(actionKind)) {
    if (!input.hasApprovedProposal) {
      return {
        allowed: false,
        reason:
          `"${actionKind}" is an execute-class action. It needs an approved proposal first — ` +
          `the owner has not approved this one. Logged as a blocked attempt.`,
      };
    }
    return {
      allowed: false,
      reason:
        `"${actionKind}" has an approved proposal, but no execution path is built yet ` +
        `(Phase 1). The approval is recorded; nothing executed.`,
    };
  }
  if (actionKind === "flag") {
    if (!canFlag(botSlug, group)) {
      return { allowed: false, reason: `"${botSlug}" may not flag on "${group}".` };
    }
    return { allowed: true };
  }
  if (isDraftAction(actionKind)) {
    if (!canDraft(botSlug, group)) {
      return { allowed: false, reason: `"${botSlug}" may not draft on "${group}".` };
    }
    return { allowed: true };
  }
  // "read"
  if (!canRead(botSlug, group)) {
    return { allowed: false, reason: `"${botSlug}" may not read "${group}".` };
  }
  return { allowed: true };
}

export interface ProposalLike {
  status: string;
  created_at: string;
  /** Per-proposal deadline override in ms; default PROPOSAL_EXPIRY_MS. */
  deadline_ms?: number | null;
}

/** A proposal is live only while proposed and inside its deadline. */
export function proposalIsLive(proposal: ProposalLike, nowMs: number = Date.now()): boolean {
  if (proposal.status !== "proposed") return false;
  const deadlineMs = proposal.deadline_ms ?? PROPOSAL_EXPIRY_MS;
  return nowMs - new Date(proposal.created_at).getTime() <= deadlineMs;
}

/** The one-line owner-facing text for a denied action. No jargon. */
export function denialText(verdict: Extract<GuardrailVerdict, { allowed: false }>): string {
  return `I can't do that on my own — ${verdict.reason}`;
}

export type { BotSlug };
