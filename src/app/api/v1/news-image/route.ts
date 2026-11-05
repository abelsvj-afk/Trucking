// GET /api/v1/news-image?signal=<uuid>&i=<0-9> - a news item's image,
// fetched by the SERVER and re-encoded (services/research/news-image.ts).
// Authenticated like every route; the browser can only name a stored
// signal and an index, never a URL, so it cannot be steered at anything.
// Failures are a bare status with no detail: the banner falls back to
// its topic tile.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { isDeepResearchEnabled } from "@/app/api/v1/research-briefings/capability";
import { loadNewsImage } from "@/services/research/news-image";

const querySchema = z.object({
  signal: z.string().uuid(),
  i: z.coerce.number().int().min(0).max(9),
});

export const GET = createApiHandler(async (req, ctx) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw notFound();
  const supabase = await createClient();
  // Image fetching rides the deep_research switch (the source of the signals):
  // off, or unverifiable, means no outbound fetch at all (ai-authority-matrix G2).
  if (!(await isDeepResearchEnabled(supabase, ctx.auth.companyId))) return new NextResponse(null, { status: 404 });
  const result = await loadNewsImage(supabase, parsed.data.signal, parsed.data.i);
  if (!result.ok) return new NextResponse(null, { status: result.status });
  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});
