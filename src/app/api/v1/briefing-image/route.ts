// GET /api/v1/briefing-image?briefing=<uuid>&i=<0-19> - the preview
// image of the article one briefing finding cites, fetched by the
// SERVER and re-encoded (services/research/briefing-image.ts, on the
// news-image pipeline). Authenticated like every route; the browser
// can only name a stored briefing and a finding index, never a URL,
// so it cannot be steered at anything. Failures are a bare status
// with no detail: the Research page renders that finding imageless.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { notFound } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { isDeepResearchEnabled } from "@/app/api/v1/research-briefings/capability";
import { loadBriefingImage } from "@/services/research/briefing-image";

const querySchema = z.object({
  briefing: z.string().uuid(),
  i: z.coerce.number().int().min(0).max(19),
});

export const GET = createApiHandler(async (req, ctx) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw notFound();
  const supabase = await createClient();
  // Image fetching rides the deep_research switch (the source of the
  // briefings): off, or unverifiable, means no outbound fetch at all
  // (ai-authority-matrix G2) - same rule as the news-image route.
  if (!(await isDeepResearchEnabled(supabase, ctx.auth.companyId))) return new NextResponse(null, { status: 404 });
  const result = await loadBriefingImage(supabase, parsed.data.briefing, parsed.data.i);
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
