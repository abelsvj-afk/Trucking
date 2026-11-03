// Abel Intelligence Upgrade, Phase C (design §4). Automatic
// thread capture on the Telegram dispatch path: when a forwarded
// conversation gets its dispatch workup, the same text is ALSO
// reconstructed into a stored thread record, so the open loop
// survives after the chat scrolls away. Best-effort by design -
// capture runs after the reply is sent and the exchange stored; a
// capture failure is logged and changes nothing for the owner (the
// conversation still lives in his timeline + dispatch history).
// The reconstruction itself is the governed extraction
// (thread-extraction.ts: verbatim bodies, §11 untouched), and the
// thread links to the exchange the workup stored - the voice
// corpus link Phase E drafts from.

import type { AiProvider } from "@/services/ai/provider";
import { extractThreadStructure } from "@/services/ai/thread-extraction";
import type { BotBrainStore } from "./store";

export async function captureForwardThread(
  store: BotBrainStore,
  provider: AiProvider,
  rawText: string,
): Promise<void> {
  const extraction = await extractThreadStructure(provider, rawText);
  const exchangeId = await store.findExchangeIdByIncoming(rawText).catch(() => null);
  await store.recordForwardThread({
    title: extraction.title ?? null,
    participants: extraction.participants,
    messages: extraction.messages.map((m) => ({
      senderName: m.sender,
      body: m.body,
      language: m.language,
      sentAt: m.sent_at ?? null,
    })),
    theAsk: extraction.the_ask ?? null,
    askOf: extraction.ask_of ?? null,
    deadlineText: extraction.deadline_text ?? null,
    unanswered: extraction.unanswered,
    source: "forward",
    exchangeId,
  });
}
