// Lane 2 (Abel Intelligence Upgrade, Phase B) — the "What Abel
// remembers" surface's API (audit B-3: until now NO view/edit/delete
// surface for memories existed anywhere). Session-authenticated
// owner requests over the SAME shared brain store the bot uses -
// one store, every surface.
//
// Edit semantics follow the memory lifecycle (design §3.4): an edit
// never rewrites a row. It saves the corrected fact as a new row
// that supersedes the old one, so history keeps what Abel used to
// believe and when it changed. Delete is the store's soft delete.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { createBotStore } from "@/services/bot/store";

const editSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(2000),
});

const deleteSchema = z.object({
  id: z.string().uuid(),
});

export const GET = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  const includeHistory = req.nextUrl.searchParams.get("history") === "1";
  const memories = await store.listMemories({ includeHistory });
  return NextResponse.json({ data: memories });
});

export const PATCH = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, editSchema);
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  const newId = await store.editMemory(body.id, body.content);
  return NextResponse.json({ data: { id: newId } });
});

export const DELETE = createApiHandler(async (req, ctx) => {
  const supabase = await createClient();
  const body = await validateBody(req, deleteSchema);
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  await store.deleteMemory(body.id);
  return NextResponse.json({ data: { id: body.id, deleted: true } });
});
