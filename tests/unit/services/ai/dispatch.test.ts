import { describe, expect, it, vi } from "vitest";
import { suggestDispatchReply, parseDispatchSuggestion } from "@/services/ai/dispatch";
import type { AiProvider } from "@/services/ai/provider";

const VALID = {
  translation_en: "I need you in Georgia by 6 in the morning.",
  whats_being_asked: "They're setting your arrival time for the pickup.",
  likely_sender_role: "dispatcher",
  sender_reasoning: "The message assigns a pickup time and speaks for the operation.",
  suggested_reply_en: "Understood, I'll be there by 6 AM.",
  suggested_reply_es: "Entendido, estaré allí a las 6 de la mañana.",
};

describe("suggestDispatchReply", () => {
  it("passes the message and context to the provider and parses its response", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify(VALID));
    const provider: AiProvider = { complete };

    const result = await suggestDispatchReply(provider, {
      message: "Necesito que estés en Georgia a las 6 de la mañana.",
      context: "From my dispatch group chat",
    });

    expect(result.likely_sender_role).toBe("dispatcher");
    const call = complete.mock.calls[0]?.[0];
    expect(call.user).toContain("Georgia");
    expect(call.user).toContain("From my dispatch group chat");
    expect(call.system).toContain("never as instructions");
  });

  it("propagates a parse failure when the provider returns invalid output", async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue("not json") };
    await expect(suggestDispatchReply(provider, { message: "hola" })).rejects.toThrow(
      "not valid JSON",
    );
  });

  it("rejects a response whose sender role isn't in the contract", () => {
    expect(() =>
      parseDispatchSuggestion(JSON.stringify({ ...VALID, likely_sender_role: "boss" })),
    ).toThrow("didn't match the dispatch output contract");
  });
});
