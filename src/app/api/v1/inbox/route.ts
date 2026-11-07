// GET /api/v1/inbox - the company inbox (rung 1, READ-ONLY; docs/design/company-inbox.md): the connection's honest
// status, the messages Abel has read (summaries), and with ?id= one message in full plus its UNSENT drafts. Session
// authenticated like every v1 route. The mailbox password never reaches this route's output. Nothing here sends or
// changes mail - there is no POST/PATCH/DELETE.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { createEmailStore } from "@/services/email/store";
import { buildEmailStatus } from "@/services/email/status";
import { getEmailConfig } from "@/services/email/config";
import { etTime } from "@/services/email/time";

const headers = { "Cache-Control": "no-store" };
const CLASSES = ["load_offer", "payment", "facility", "other", "junk", "unclassified"];

export const GET = createApiHandler(async (req: NextRequest, { auth }) => {
  const supabase = await createClient();
  const store = createEmailStore(supabase, auth.companyId);
  const url = new URL(req.url);
  const config = getEmailConfig();
  const status = buildEmailStatus(config, config.ok ? await store.getPollState().catch(() => null) : null, new Date(), etTime);

  const id = url.searchParams.get("id");
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid message id." } }, { status: 400, headers });
    const message = await store.get(id);
    if (!message) return NextResponse.json({ error: { code: "NOT_FOUND", message: "No such message." } }, { status: 404, headers });
    return NextResponse.json({ data: { status, message, drafts: await store.listDrafts(id) } }, { headers });
  }

  const classification = url.searchParams.get("classification");
  const messages = config.ok
    ? await store.list({
        query: url.searchParams.get("q") ?? undefined,
        classification: classification && CLASSES.includes(classification) ? classification : undefined,
        limit: 50,
      })
    : [];
  // Bodies stay out of the list.
  return NextResponse.json({ data: { status, messages: messages.map((m) => ({ ...m, bodyText: null })) } }, { headers });
});
