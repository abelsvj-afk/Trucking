// GET /api/v1/inbox - the company inbox (rung 1, READ-ONLY; docs/design/company-inbox.md): the connection's honest
// status, the messages Abel has read (summaries), and with ?id= one message in full plus its UNSENT drafts. Session
// authenticated like every v1 route. The mailbox password never reaches this route's output. This route only READS: there is no
// POST/PATCH/DELETE here, so nothing can be sent from a page load or the web UI - sending happens only through Abel's approval flow.

import { NextRequest, NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { createEmailStore } from "@/services/email/store";
import { buildAllStatuses } from "@/services/email/status";
import { DISPATCH_SEND_OFF_REASON, getAllEmailConfigs, isSendEnabled, MAILBOXES, type Mailbox } from "@/services/email/config";
import { etTime } from "@/services/email/time";

const headers = { "Cache-Control": "no-store" };
const CLASSES = ["load_offer", "payment", "facility", "other", "junk", "unclassified"];

export const GET = createApiHandler(async (req: NextRequest, { auth }) => {
  const supabase = await createClient();
  const store = createEmailStore(supabase, auth.companyId);
  const url = new URL(req.url);
  const configs = getAllEmailConfigs();
  const states = Object.fromEntries(
    await Promise.all(MAILBOXES.map(async (m) => [m, configs[m].ok ? await store.getPollState(m).catch(() => null) : null] as const)),
  ) as Record<Mailbox, Awaited<ReturnType<typeof store.getPollState>> | null>;
  const statuses = buildAllStatuses(states, new Date(), etTime, configs);
  const anyOn = MAILBOXES.some((m) => configs[m].ok);
  // Sending state per mailbox (owner@ active; dispatch@ dormant behind a flag) and recent send failures, shown in the health area.
  const sending = MAILBOXES.map((m) => ({ mailbox: m, enabled: isSendEnabled(m), reason: isSendEnabled(m) ? null : DISPATCH_SEND_OFF_REASON }));
  const sendFailures = anyOn ? await store.listSendFailures(5).catch(() => []) : [];

  const id = url.searchParams.get("id");
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "VALIDATION", message: "Invalid message id." } }, { status: 400, headers });
    const message = await store.get(id);
    if (!message) return NextResponse.json({ error: { code: "NOT_FOUND", message: "No such message." } }, { status: 404, headers });
    return NextResponse.json({ data: { statuses, sending, message, drafts: await store.listDrafts(id), sent: await store.listSent({ emailMessageId: id, limit: 10 }) } }, { headers });
  }

  const classification = url.searchParams.get("classification");
  const mailbox = url.searchParams.get("mailbox");
  const messages = anyOn
    ? await store.list({
        mailbox: (MAILBOXES as readonly string[]).includes(mailbox ?? "") ? (mailbox as Mailbox) : undefined,
        query: url.searchParams.get("q") ?? undefined,
        classification: classification && CLASSES.includes(classification) ? classification : undefined,
        limit: 50,
      })
    : [];
  // Bodies stay out of the list.
  return NextResponse.json({ data: { statuses, sending, sendFailures: sendFailures.map((d) => ({ id: d.id, mailbox: d.mailbox, toAddress: d.toAddress, subject: d.subject, reason: d.sendError })), messages: messages.map((m) => ({ ...m, bodyText: null })) } }, { headers });
});
