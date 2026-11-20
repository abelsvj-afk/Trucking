// GET /api/bots/proposals — the bot team's open proposals, newest first.
// POST /api/bots/proposals — decide one: { id, decision: "approved" | "denied" }.
// Session-authenticated like every v1 route; company-scoped. A decision
// here is the owner's tap: it moves the proposal to approved/denied and
// writes the audit row. It executes nothing — turning an approved
// proposal into a load / record / message is a Phase 1 build
// (docs/bot-team-build-plan.md). An approval unanswered by its
// deadline counts as denied; the sweeper marks stale rows expired.
// Deciding is the OWNER's tap (audit F-022): any other role gets 403, and
// the decision records which user made it, not just the word "owner".

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { ApiError, validationError } from "@/services/api/errors";
import { createBotTeamStore } from "@/services/bots/store";

export const GET = createApiHandler(async (_req: NextRequest, ctx) => {
  const store = createBotTeamStore(ctx.auth.companyId);
  if (!store) {
    throw validationError("Bot team storage is not configured on the server (TELEGRAM_COMPANY_ID / Supabase keys).");
  }
  const proposals = await store.listOpenProposals(50);
  return NextResponse.json({ data: proposals }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  if (ctx.auth.role !== "owner") {
    throw new ApiError(403, "forbidden", "Only the owner can approve or deny a bot proposal.");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw validationError("Request body must be valid JSON.");
  }
  const record = body as { id?: unknown; decision?: unknown };
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw validationError("id is required.");
  }
  if (record.decision !== "approved" && record.decision !== "denied") {
    throw validationError('decision must be "approved" or "denied".');
  }
  const store = createBotTeamStore(ctx.auth.companyId);
  if (!store) {
    throw validationError("Bot team storage is not configured on the server (TELEGRAM_COMPANY_ID / Supabase keys).");
  }
  const decided = await store.decideProposal(record.id, record.decision, `owner:${ctx.auth.userId}`);
  await store.logAudit({
    botSlug: decided.bot_slug,
    actor: "owner",
    action: `proposal_${record.decision}`,
    targetRef: decided.id,
    detail: { title: decided.title, via: "app", userId: ctx.auth.userId },
  });
  return NextResponse.json({ data: decided }, { headers: { "Cache-Control": "no-store" } });
});
