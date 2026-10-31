// Driver MVP (docs/design/driver-mvp.md §§4/6). The bot's gating rules
// are safety rules, not conveniences - a regression here is the bot
// talking to the wrong chat or acting before it's locked to its owner.
// The intelligence rules matter the same way: context is assembled by
// code (history, snapshot, instructions, memories) on every turn.

import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
} from "@/services/telegram/dispatch-bot";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { TelegramStore } from "@/services/telegram/store";

const SUGGESTION: DispatchSuggestion = {
  translation_en: "Arrive at 6.",
  whats_being_asked: "Arrival time.",
  likely_sender_role: "dispatcher",
  sender_reasoning: "Assigns a time.",
  suggested_reply_en: "Understood.",
  suggested_reply_es: "Entendido.",
};

function deps(store: TelegramStore | null = null): TelegramDeps & {
  sendMessage: ReturnType<typeof vi.fn>;
  getSuggestion: ReturnType<typeof vi.fn>;
  runChat: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
    runChat: vi.fn().mockResolvedValue({ reply: "Your 14 runs out at 8 PM.", memory: null }),
    store,
  };
}

function fakeStore(overrides: Partial<TelegramStore> = {}): TelegramStore {
  return {
    loadHistory: vi.fn().mockResolvedValue([{ role: "user", text: "earlier question" }]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    loadMemories: vi.fn().mockResolvedValue([
      { kind: "instruction", content: "Always give the Spanish reply too", created_at: "2026-10-31T00:00:00Z" },
      { kind: "fact", content: "Steven pays on Fridays", created_at: "2026-10-31T00:00:00Z" },
    ]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    storeExchange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: null,
};

describe("handleTelegramUpdate", () => {
  it("is disabled with no bot token", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "hola" } },
      { ...CONFIG, botToken: null },
      d,
    );
    expect(result).toBe("disabled");
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("never responds in a group chat", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: -1001, type: "group" }, text: "hola" } },
      CONFIG,
      d,
    );
    expect(result).toBe("ignored_not_private");
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.getSuggestion).not.toHaveBeenCalled();
  });

  it("silently ignores any private chat that isn't the allowlisted one", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 9999, type: "private" }, text: "hola" } },
      CONFIG,
      d,
    );
    expect(result).toBe("ignored_not_allowlisted");
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("bootstrap mode replies with only the chat id and runs no AI", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 777, type: "private" }, text: "hola" } },
      { ...CONFIG, allowedChatId: null },
      d,
    );
    expect(result).toBe("bootstrap_replied");
    expect(d.getSuggestion).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("777");
  });

  it("routes Spanish text to dispatch, replies, and stores the exchange", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Necesito que llegues a las 6 de la mañana" } },
      CONFIG,
      d,
    );
    expect(result).toBe("replied");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("Translation:");
    expect(store.storeExchange).toHaveBeenCalledWith(
      "Necesito que llegues a las 6 de la mañana",
      SUGGESTION,
    );
    // The turn is persisted to conversation history.
    expect(store.saveMessage).toHaveBeenCalledWith(4242, "user", "Necesito que llegues a las 6 de la mañana");
  });

  it("injects standing instructions and remembered facts into the dispatch context", async () => {
    const store = fakeStore();
    const d = deps(store);
    await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "¿Cuándo me pagas, Steven?", forward_date: 123 } },
      CONFIG,
      d,
    );
    const contextArg = d.getSuggestion.mock.calls[0]?.[1] as string;
    expect(contextArg).toContain("Always give the Spanish reply too");
    expect(contextArg).toContain("Steven pays on Fridays");
  });

  it("routes a forwarded message to dispatch even in English", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Be at the dock at 6", forward_date: 123 } },
      CONFIG,
      d,
    );
    expect(result).toBe("replied");
    expect(d.getSuggestion).toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
  });

  it("captures a 'remember:' dictation without calling any AI", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Remember: Steven pays on Fridays" } },
      CONFIG,
      d,
    );
    expect(result).toBe("remembered");
    expect(store.saveMemory).toHaveBeenCalledWith("fact", "Steven pays on Fridays");
    expect(d.getSuggestion).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
  });

  it("captures an expense dictation as a hint, acknowledged as not booked", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Remember: fuel was $3.89 at the Pilot on I-75" } },
      CONFIG,
      d,
    );
    expect(result).toBe("remembered");
    expect(store.saveMemory).toHaveBeenCalledWith("expense_hint", expect.stringContaining("$3.89"));
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("not added to your books");
  });

  it("saves a standing instruction and confirms it", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Instruction: keep answers short" } },
      CONFIG,
      d,
    );
    expect(result).toBe("instruction_saved");
    expect(store.saveMemory).toHaveBeenCalledWith("instruction", "keep answers short");
  });

  it("answers a plain question through chat with history and instructions in the input", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" } },
      CONFIG,
      d,
    );
    expect(result).toBe("chatted");
    const chatInput = d.runChat.mock.calls[0]?.[0];
    expect(chatInput.history).toEqual([{ role: "user", text: "earlier question" }]);
    expect(chatInput.instructions[0].content).toContain("Spanish reply");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("14 runs out");
  });

  it("saves a memory the chat model surfaces from a dictation", async () => {
    const store = fakeStore();
    const d = deps(store);
    d.runChat.mockResolvedValue({
      reply: "Noted.",
      memory: { kind: "fact", content: "The Georgia pickup is dock 4" },
    });
    await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "The Georgia pickup is dock 4, writing it here so I don't forget" } },
      CONFIG,
      d,
    );
    expect(store.saveMemory).toHaveBeenCalledWith("fact", "The Georgia pickup is dock 4");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("Saved that to memory");
  });

  it("answers a non-text message with the text-only note", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" } } },
      CONFIG,
      d,
    );
    expect(result).toBe("no_text_replied");
    expect(d.getSuggestion).not.toHaveBeenCalled();
  });

  it("still replies when exchange storage fails", async () => {
    const store = fakeStore({
      storeExchange: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Necesito que llegues mañana" } },
      CONFIG,
      d,
    );
    expect(result).toBe("replied");
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });
});
