// Smart Path v1 (docs/design/driver-mvp.md §8.3). Computed endpoint,
// not a CRUD resource: validates the body, then runs the route check
// against the caller's own records via the session-scoped client
// (RLS applies to every read). Nothing is stored - a route check is
// advice computed from current records, recomputed on every ask.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { routeCheckRequestSchema } from "@/data/schemas/smart-path";
import { runRouteCheck } from "@/services/smart-path/route-check";

export const POST = createApiHandler(async (req) => {
  const body = await validateBody(req, routeCheckRequestSchema);
  const supabase = await createClient();
  const result = await runRouteCheck(supabase, body);
  return NextResponse.json(result);
});
