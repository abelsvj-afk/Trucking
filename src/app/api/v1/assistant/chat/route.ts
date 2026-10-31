// Bot intelligence v2 (docs/design/driver-mvp.md §8). The web chat
// window onto the SAME bot brain the Telegram bot uses: same store
// (services/bot/store.ts, channel "web"), same shared timeline in
// telegram_messages, same memories, same snapshot, same standing
// instructions, same agent loop. There is no second context for
// this surface to diverge into - it only differs from the webhook
// in transport and in having a real owner session (so RLS scopes
// every query here, and the dispatch_helper kill switch can be
// honored the same way /api/v1/dispatch-suggest honors it).

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { OpenAiProvider } from "@/services/ai/providers/openai";
import {
  DISPATCH_HELPER_CAPABILITY,
  formatDispatchSuggestion,
  suggestDispatchReply,
} from "@/services/ai/dispatch";
import type { BotChatOutput } from "@/services/ai/bot-chat";
import { createBotStore } from "@/services/bot/store";
import { loadBotContext, runAgentTurn } from "@/services/bot/agent-turn";
import {
  buildDispatchContext,
  classifyTelegramText,
  memoryKindFor,
  stripCapturePrefix,
} from "@/services/telegram/context";

const chatRequestSchema = z.object({
  message: z.string().min(1, "message is required.").max(8000),
});

/** Same fail-closed convention as /api/v1/dispatch-suggest, checked (not thrown) here so a disabled helper just routes the message to the assistant. */
async function isDispatchHelperEnabled(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const [companyResult, capabilityResult] = await Promise.all([
    supabase.from("companies").select("ai_globally_disabled").eq("id", companyId).single(),
    supabase
      .from("ai_capability_settings")
      .select("enabled")
      .eq("company_id", companyId)
      .eq("capability", DISPATCH_HELPER_CAPABILITY)
      .maybeSingle(),
  ]);
  if (companyResult.error || capabilityResult.error) return false;
  const globallyDisabled =
    (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
  const capabilityEnabled =
    (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
  return !globallyDisabled && capabilityEnabled;
}

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const store = createBotStore(supabase, ctx.auth.companyId, "web");
  const [history, pending] = await Promise.all([
    store.loadConversationHistory(40),
    store.loadPendingAction(),
  ]);
  return NextResponse.json({
    data: history,
    pending_summary: pending?.summary ?? null,
  });
});

export const POST = createApiHandler(async (req, ctx) => {
  const body = await validateBody(req, chatRequestSchema);
  const text = body.message.trim();
  const supabase = await createClient();
  const store = createBotStore(supabase, ctx.auth.companyId, "web");

  // Same routing as the Telegram bot (services/telegram/context.ts):
  // forwards can't happen here, so everything is typed text.
  const intent = classifyTelegramText(text, false);
  let output: BotChatOutput;

  if (intent === "remember" || intent === "instruction") {
    const content = stripCapturePrefix(text);
    const kind = intent === "instruction" ? "instruction" : memoryKindFor(content);
    await store.saveMemory(kind, content);
    output = {
      reply:
        kind === "instruction"
          ? `Saved as a standing instruction - I'll follow it on every reply: "${content}"`
          : kind === "expense_hint"
            ? `Saved for review: "${content}". That's captured as a note, not added to your books - add it under Money in the app if it should count.`
            : `Saved to memory: "${content}"`,
    };
  } else if (intent === "dispatch" && (await isDispatchHelperEnabled(supabase, ctx.auth.companyId))) {
    // Dispatch help only when its own capability is on (§8); with it
    // off, the message falls through to the assistant below, whose
    // bot_chat switch governs it instead.
    const botCtx = await loadBotContext(store, text);
    const suggestion = await suggestDispatchReply(new OpenAiProvider(), {
      message: text,
      context: buildDispatchContext(botCtx.snapshotText, botCtx.instructions, botCtx.memories),
    });
    await store.storeExchange(text, suggestion);
    output = { reply: formatDispatchSuggestion(suggestion) };
  } else {
    const botCtx = await loadBotContext(store, text);
    output = await runAgentTurn(
      new OpenAiProvider(),
      store,
      { userText: text, ...botCtx },
      { onToolLog: (entry) => console.log("[assistant] bot tool", entry) },
    );
  }

  await store.saveConversationMessage("user", text);
  await store.saveConversationMessage("assistant", output.reply);

  const pending = await store.loadPendingAction();
  return NextResponse.json({
    reply: output.reply,
    pending_summary: pending?.summary ?? null,
  });
});
