// Money → This month (docs/design/monthly-income-goal.md). GET the month's projected pay and goal
// (?month=YYYY-MM, default this month on his clock); PUT sets or clears the monthly goal.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { loadMonthIncome, setGoal } from "@/services/api/monthly-income";

const goalSchema = z.object({ target_cents: z.number().int().positive().max(100_000_000).nullable() });

export const GET = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const month = req.nextUrl.searchParams.get("month") ?? undefined;
  return NextResponse.json({ data: await loadMonthIncome(supabase, ctx.auth.companyId, month) });
});

export const PUT = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, goalSchema);
  await setGoal(supabase, ctx.auth.companyId, body.target_cents);
  return NextResponse.json({ data: { target_cents: body.target_cents } });
});
