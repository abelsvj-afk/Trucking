// GET/POST /api/v1/telegram-webhook - the owner's report on, and repair of, how Telegram delivers updates to
// Abel (docs/design/driver-mvp.md section 4). Session-authenticated like every v1 route. GET reports (getWebhookInfo,
// in plain words); POST re-registers the EXISTING webhook address with message + edited_message + callback_query,
// reusing the secret from the server's own environment. The bot token and the secret are never returned or logged,
// and no address can be supplied by the caller.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { getTelegramConfig } from "@/services/telegram/dispatch-bot";
import { faceContext, getTeamWebhookReports, getWebhookReport, repairWebhook, type TeamFace } from "@/services/telegram/webhook-admin";
import { BOT_FACES, botFaceToken } from "@/services/bots/faces";
import type { BotSlug } from "@/services/bots/registry";

const headers = { "Cache-Control": "no-store" };

/** Every bot face with its token from the server's environment (BT-007). Tokens never leave the server. */
function teamFaces(): TeamFace[] {
  return Object.values(BOT_FACES).map((f) => ({ slug: f.slug, name: f.displayName, username: f.username, tokenEnvVar: f.tokenEnvVar, token: botFaceToken(f.slug) }));
}

export const GET = createApiHandler(async () => {
  const config = getTelegramConfig();
  try {
    const [data, faces] = await Promise.all([getWebhookReport(config), getTeamWebhookReports(teamFaces(), config.webhookSecret)]);
    return NextResponse.json({ data, faces }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "BAD_GATEWAY", message: err instanceof Error ? err.message : "Couldn't check Telegram." } },
      { status: 502, headers },
    );
  }
});

export const POST = createApiHandler(async (req) => {
  const config = getTelegramConfig();
  // ?bot=<slug> repairs that face's webhook with ITS token; no parameter = Abel's (as before).
  const slug = new URL(req.url).searchParams.get("bot");
  const face = slug ? teamFaces().find((f) => f.slug === (slug as BotSlug)) : null;
  if (slug && !face) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: `Unknown bot: ${slug}.` } }, { status: 400, headers });
  }
  try {
    const result = face
      ? await repairWebhook({ botToken: face.token, webhookSecret: config.webhookSecret }, fetch, faceContext(face))
      : await repairWebhook(config);
    console.log("[telegram] webhook repair", { repaired: result.repaired, missingBefore: result.before.missing, missingAfter: result.after.missing });
    return NextResponse.json({ data: result }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "BAD_GATEWAY", message: err instanceof Error ? err.message : "Couldn't reach Telegram." } },
      { status: 502, headers },
    );
  }
});
