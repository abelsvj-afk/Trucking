// GET/POST /api/v1/telegram-webhook - the owner's report on, and repair of, how Telegram delivers updates to
// Abel (docs/design/driver-mvp.md section 4). Session-authenticated like every v1 route. GET reports (getWebhookInfo,
// in plain words); POST re-registers the EXISTING webhook address with message + edited_message + callback_query,
// reusing the secret from the server's own environment. The bot token and the secret are never returned or logged,
// and no address can be supplied by the caller.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { getWebhookReport, repairWebhook } from "@/services/telegram/webhook-admin";

const headers = { "Cache-Control": "no-store" };

export const GET = createApiHandler(async () => {
  const config = getTelegramConfig();
  try {
    return NextResponse.json({ data: await getWebhookReport(config) }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "BAD_GATEWAY", message: err instanceof Error ? err.message : "Couldn't check Telegram." } },
      { status: 502, headers },
    );
  }
});

export const POST = createApiHandler(async () => {
  const config = getTelegramConfig();
  try {
    const result = await repairWebhook(config);
    console.log("[telegram] webhook repair", { repaired: result.repaired, missingBefore: result.before.missing, missingAfter: result.after.missing });
    return NextResponse.json({ data: result }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "BAD_GATEWAY", message: err instanceof Error ? err.message : "Couldn't reach Telegram." } },
      { status: 502, headers },
    );
  }
});
