// Malik's webhook tools (docs/design/malik-real-tools.md). Telnyx's
// servers call this mid-conversation - no browser session - so it is
// public in src/proxy.ts and enforces its own checks instead, in order:
//   1. Telnyx public key configured (else disabled, 503 - fail closed)
//   2. Ed25519 signature over `timestamp + raw body` (else 401)
//   3. companyId is a UUID of a real company (else 404)
//   4. tool is one of Malik's six allowlisted names (else 404)
// The company id is baked into each tool's URL in the Telnyx assistant
// config (set once by King via the Telnyx API) - it is never a
// model-chosen parameter and never comes from the call itself.
// Read failures return 200 with an honest plain-words result, so the
// assistant can say so on the call instead of guessing.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCallingConfig } from "@/services/calling/config";
import { verifyTelnyxSignature } from "@/services/calling/telnyx";
import { isMalikToolName, runMalikTool, type MalikToolName } from "@/services/calling/malik-tools";

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ companyId: string; tool: string }> },
): Promise<NextResponse> {
  const config = getCallingConfig();
  if (!config.publicKey) {
    // Fail closed: without the public key no signature can be checked.
    return NextResponse.json({ error: "Malik tools are not configured." }, { status: 503 });
  }
  const rawBody = await req.text();
  const signature = req.headers.get("telnyx-signature-ed25519");
  const timestamp = req.headers.get("telnyx-timestamp");
  if (!verifyTelnyxSignature(config.publicKey, timestamp, rawBody, signature)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Bad JSON." }, { status: 400 });
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON." }, { status: 400 });
  }
  const { companyId, tool } = await ctx.params;
  if (!UUID_RE.test(companyId) || !isMalikToolName(tool)) {
    return NextResponse.json({ error: "Unknown tool." }, { status: 404 });
  }
  const client = serviceRoleClient();
  if (!client) {
    return NextResponse.json({ error: "Malik tools are not configured." }, { status: 503 });
  }
  const company = await client.from("companies").select("id").eq("id", companyId).maybeSingle();
  if (company.error) {
    return NextResponse.json({ error: "Malik tools are not configured." }, { status: 503 });
  }
  if (!company.data) {
    return NextResponse.json({ error: "Unknown tool." }, { status: 404 });
  }
  const result = await runMalikTool(client, companyId, tool as MalikToolName, args);
  return NextResponse.json({ result });
}
