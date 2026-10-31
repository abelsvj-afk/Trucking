import { describe, expect, it, vi } from "vitest";
import { runBotChat, parseBotChatOutput } from "@/services/ai/bot-chat";
import type { AiProvider } from "@/services/ai/provider";

describe("runBotChat", () => {
  it("assembles snapshot, instructions, memories, and history into the prompt", async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({ reply: "Your 14 ends at 8 PM.", memory: null }),
    );
    const provider: AiProvider = { complete };

    const result = await runBotChat(provider, {
      userText: "When does my 14 run out?",
      history: [{ role: "user", text: "I started at 6 AM" }],
      snapshotText: "COMPANY SNAPSHOT: window elapsed 6h 00m of 14h",
      instructions: [{ kind: "instruction", content: "Answer short", created_at: "2026-10-31T00:00:00Z" }],
      memories: [{ kind: "fact", content: "Steven pays on Fridays", created_at: "2026-10-31T00:00:00Z" }],
    });

    expect(result.reply).toContain("8 PM");
    const call = complete.mock.calls[0]?.[0];
    // Guaranteed context: every block is in the prompt the MODEL
    // received - assembled by code, not fetched at model discretion.
    expect(call.user).toContain("window elapsed 6h 00m");
    expect(call.user).toContain("Answer short");
    expect(call.user).toContain("Steven pays on Fridays");
    expect(call.user).toContain("I started at 6 AM");
    expect(call.user).toContain("When does my 14 run out?");
    expect(call.system).toContain("never estimate or invent");
  });

  it("rejects output that doesn't match the contract", () => {
    expect(() => parseBotChatOutput(JSON.stringify({ nope: true }))).toThrow(
      "didn't match the bot-chat output contract",
    );
  });
});
