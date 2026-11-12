// Frontier 2 (Remember better) — the "What I know about you"
// surface's API. Session-authenticated owner requests over the
// SAME shared brain store the bot uses — one store, every surface.
//
// GET returns the model (beliefs + preferences + lessons with
// evidence) plus the night shift's staleness status, riding along
// so the page can show the same banner as the memories list.
// POST corrects one lesson: a superseding row at max confidence
// with provenance owner_stated (F2-D) — never an in-place edit.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { createBotStore } from "@/services/bot/store";
import { checkConsolidationHealth } from "@/services/bot/consolidation";

const correctSchema = z.object({
  episode_id: z.string().uuid(),
  lesson: z.string().min(1).max(2000),
});

export const GET = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  const model = await store.getWhatIKnow();
  let consolidation = null;
  try {
    const [health, enabled] = await Promise.all([
      checkConsolidationHealth(supabase, ctx.auth.companyId),
      store.isMemoryConsolidationEnabled(),
    ]);
    consolidation = { enabled, ...health };
  } catch {
    consolidation = null;
  }
  return NextResponse.json({ data: model, consolidation });
});

export const POST = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, correctSchema);
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  const newId = await store.correctEpisode(body.episode_id, body.lesson);
  return NextResponse.json({ data: { id: newId } });
});
