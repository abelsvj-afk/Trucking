// POST /api/v1/roadside/send (docs/design/eld-roadside-overlay.md).
// The web roadside send: the /roadside page shows the officer's email and
// the FULL packet before its Send button - that confirmation IS the
// approval - and this route then does the same thing Abel's tools do, in
// one call: build the packet from the one HOS read, file it, save it as a
// standalone owner@ draft, and send it through sendApprovedDraft (which
// re-checks the fingerprint of the exact text being sent). Session auth,
// tenant from the session - never from the body.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { createEmailStore } from "@/services/email/store";
import { bodyFingerprint, sendApprovedDraft, SINGLE_ADDRESS } from "@/services/email/send";
import { createTelegramNotifier } from "@/services/telegram/notify";
import { buildLivePacket, filePacket, markPacketEmailed } from "@/services/roadside/packet-service";

export const POST = createApiHandler(async (req, ctx) => {
  const body = (await req.json().catch(() => null)) as { to?: unknown } | null;
  const to = typeof body?.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!SINGLE_ADDRESS.test(to)) throw validationError("The officer's email must be one plain email address.");

  const supabase = await createClient();
  const companyId = ctx.auth.companyId;
  const packet = await buildLivePacket(supabase, companyId);
  const emailStore = createEmailStore(supabase, companyId);

  let filed: { packetId: string; documentId: string | null };
  let draftId: string;
  try {
    filed = await filePacket(supabase, companyId, packet);
    const draft = await emailStore.createStandaloneDraft(to, packet.subject, packet.text, "owner");
    draftId = draft.id;
  } catch (err) {
    // Pre-migration-00086 (or a storage failure): say exactly that, send nothing.
    console.error("[roadside] packet staging failed", err instanceof Error ? err.message.slice(0, 160) : "error");
    return NextResponse.json(
      {
        error: {
          code: "packet_staging_failed",
          message: "The packet was built but couldn't be filed or staged - the roadside database step (migration 00086) may not be applied yet. Nothing was sent. You can still show the packet on this screen.",
        },
      },
      { status: 503 },
    );
  }

  const result = await sendApprovedDraft(
    { emailStore, now: () => new Date(), notify: (text) => createTelegramNotifier().notifyOwner(text) },
    {
      draftId,
      approvedFingerprint: bodyFingerprint(packet.text),
      attachments: [{ fileName: packet.fileName, contentType: "text/plain", text: packet.text }],
    },
  );
  if (!result.ok) {
    return NextResponse.json({ error: { code: "packet_send_failed", message: result.reason } }, { status: 422 });
  }
  await markPacketEmailed(supabase, companyId, filed.packetId, result.sent.toAddress, result.sent.id || null).catch(() => undefined);
  return NextResponse.json({
    data: {
      sent: true,
      to: result.sent.toAddress,
      subject: result.sent.subject,
      packetId: filed.packetId,
      ...(result.warning ? { warning: result.warning } : {}),
    },
  });
});
