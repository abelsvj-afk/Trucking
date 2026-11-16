// Paycheck confirmations (docs/design/confirm-paycheck.md). Session-authenticated owner requests:
// POST confirms one paycheck (its pay week, the deposit that landed, optionally the statement document);
// DELETE undoes it. The paycheck picture itself is read through GET /api/v1/pay-summary.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { confirmPaycheck, undoPaycheckConfirmation } from "@/services/api/paycheck-confirmations";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const confirmSchema = z
  .object({
    period_start: day,
    period_end: day,
    payday: day.nullable(),
    received_cents: z.number().int().min(0).max(100_000_000),
    statement_document_id: z.string().uuid().nullable().optional(),
  })
  .refine((b) => b.period_end >= b.period_start, { message: "period_end must not be before period_start" });

const undoSchema = z.object({ period_start: day });

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, confirmSchema);
  const id = await confirmPaycheck(supabase, ctx.auth.companyId, {
    periodStart: body.period_start,
    periodEnd: body.period_end,
    payday: body.payday,
    receivedCents: body.received_cents,
    statementDocumentId: body.statement_document_id ?? null,
    source: "app",
  });
  return NextResponse.json({ data: { id } });
});

export const DELETE = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, undoSchema);
  await undoPaycheckConfirmation(supabase, ctx.auth.companyId, body.period_start);
  return NextResponse.json({ data: { period_start: body.period_start, undone: true } });
});
