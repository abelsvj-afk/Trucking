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
  likely_sender_role: "dispatcher",
  sender_reasoning: "Assigns a time.",
  whats_being_asked: "Arrival time.",
  meaning_notes: null,
  translation_en: "Arrive at 6.",
  suggested_reply: "Entendido.",
  suggested_reply_language: "es",
  recordable_items: [],
  source_language: "es",
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

  it("routes a forwarded Spanish text to dispatch, replies, and stores the exchange", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Necesito que llegues a las 6 de la mañana", forward_date: 123 } },
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

  it("shows no Translation section when the gate stripped it (English forward)", async () => {
    const englishSuggestion: DispatchSuggestion = {
      ...SUGGESTION,
      source_language: "en",
      translation_en: null,
      meaning_notes: "'Be at the dock' = arrive at the dock.",
      suggested_reply: "I'll be there at 6.",
      suggested_reply_language: "en",
    };
    const d = deps();
    d.getSuggestion.mockResolvedValue(englishSuggestion);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Be at the dock at 6", forward_date: 123 } },
      CONFIG,
      d,
    );
    expect(result).toBe("replied");
    const sent = d.sendMessage.mock.calls[0]?.[1] as string;
    expect(sent).not.toContain("Translation:");
    expect(sent).toContain("What they mean:");
    expect(sent).toContain("Suggested reply (English):");
    expect(sent).not.toContain("Suggested reply (Spanish):");
  });

  it("stages recordables spotted in a forward as a propose->yes batch (§11)", async () => {
    const withItems: DispatchSuggestion = {
      ...SUGGESTION,
      recordable_items: [
        {
          tool_name: "create_load",
          args: { origin: "Savannah, GA", destination: "Atlanta, GA" },
          source_quote: "carga para Atlanta",
          confidence: "high",
        },
      ],
    };
    const d = deps();
    d.getSuggestion.mockResolvedValue(withItems);
    const stageRecordables = vi.fn().mockResolvedValue({
      proposals: [
        {
          tool: "create_load",
          args: { origin: "Savannah, GA", destination: "Atlanta, GA" },
          summary: "Load: Savannah, GA → Atlanta, GA",
          batchId: "batch-1",
          sourceQuote: "carga para Atlanta",
          confidence: "high",
        },
      ],
      rejected: [],
      blockedByPending: false,
    });
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Tengo una carga para Atlanta", forward_date: 123 } },
      CONFIG,
      { ...d, stageRecordables },
    );
    expect(result).toBe("replied");
    expect(stageRecordables).toHaveBeenCalledTimes(1);
    const sent = d.sendMessage.mock.calls[0]?.[1] as string;
    expect(sent).toContain("I have NOT recorded any of this yet");
    expect(sent).toContain("Load: Savannah, GA → Atlanta, GA");
  });

  // Lane 1 (audit B-7): superseded behavior - staging used to be
  // BLOCKED by a waiting proposal and the items were dropped. Now
  // the batch queues behind it and the reply says so (no YES
  // grammar for a batch that isn't at the front of the queue).
  it("one rule (telegram audit P0-5): the new batch is what a YES answers, and the earlier waiting proposal is named", async () => {
    const withItems: DispatchSuggestion = {
      ...SUGGESTION,
      recordable_items: [
        {
          tool_name: "create_load",
          args: { origin: "Savannah, GA", destination: "Atlanta, GA" },
          source_quote: "carga para Atlanta",
          confidence: "high",
        },
      ],
    };
    const d = deps();
    d.getSuggestion.mockResolvedValue(withItems);
    const stageRecordables = vi.fn().mockResolvedValue({
      proposals: [
        {
          tool: "create_load",
          args: { origin: "Savannah, GA", destination: "Atlanta, GA" },
          summary: "Load: Savannah, GA → Atlanta, GA",
          sourceQuote: "carga para Atlanta",
          confidence: "high",
        },
      ],
      rejected: [],
      blockedByPending: false,
      queuedBehindPending: true,
      earlierPending: "Expense $40",
    });
    await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Tengo una carga para Atlanta", forward_date: 123 } },
      CONFIG,
      { ...d, stageRecordables },
    );
    const sent = d.sendMessage.mock.calls[0]?.[1] as string;
    expect(sent).not.toContain("queued");
    expect(sent).toContain("A YES now answers the list above");
    expect(sent).toContain("still waiting: Expense $40");
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
      { message: { chat: { id: 4242, type: "private" }, text: "Necesito que llegues mañana", forward_date: 123 } },
      CONFIG,
      d,
    );
    expect(result).toBe("replied");
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  // Lane 1 (audit L-2): the owner typing Spanish himself is
  // conversation - he gets an answer, not a workup of his own words.
  it("treats the owner's own Spanish as conversation, not a dispatch workup", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Necesito saber cuánto gané esta semana" } },
      CONFIG,
      d,
    );
    expect(result).toBe("chatted");
    expect(d.getSuggestion).not.toHaveBeenCalled();
    expect(d.runChat).toHaveBeenCalledTimes(1);
  });

  // Lane 1 (audit B-1): the dispatch_helper toggle + global AI kill
  // switch must gate the Telegram dispatch path, like the web does.
  it("does not run dispatch help on Telegram when the capability is off", async () => {
    const store = fakeStore();
    const d = {
      ...deps(store),
      isDispatchHelperEnabled: vi.fn().mockResolvedValue(false),
    };
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "Be there at 6", forward_date: 123 } },
      CONFIG,
      d,
    );
    expect(result).toBe("dispatch_disabled");
    expect(d.getSuggestion).not.toHaveBeenCalled();
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("turned off");
  });

  // Lane 1 (audit B-2): a Telegram retry of the same update must
  // never run the turn twice (no double-logged writes, no
  // double-stored photos).
  it("ignores a redelivered update_id instead of processing it twice", async () => {
    const claimed = new Set<number>();
    const store = fakeStore({
      claimTelegramUpdate: vi.fn(async (updateId: number) => {
        if (claimed.has(updateId)) return false;
        claimed.add(updateId);
        return true;
      }),
    });
    const d = deps(store);
    const update = {
      update_id: 9001,
      message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" },
    };
    const first = await handleTelegramUpdate(update, CONFIG, d);
    const second = await handleTelegramUpdate(update, CONFIG, d);
    expect(first).toBe("chatted");
    expect(second).toBe("duplicate_ignored");
    expect(d.runChat).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  // Fix round (pitfall hunt CD-6): the claim's price - if the turn
  // fails AFTER claiming (above all when the reply send fails), the
  // standing claim would swallow Telegram's redelivery and the
  // message would be lost. The claim is released so the retry
  // reprocesses; completed turns keep theirs.
  function claimStore() {
    const claims = new Set<number>();
    return {
      claims,
      store: fakeStore({
        claimTelegramUpdate: vi.fn(async (updateId: number) => {
          if (claims.has(updateId)) return false;
          claims.add(updateId);
          return true;
        }),
        releaseTelegramUpdate: vi.fn(async (updateId: number) => {
          claims.delete(updateId);
        }),
      }),
    };
  }

  it("CD-6: releases the claim when the reply send fails, so the redelivery reprocesses", async () => {
    const { claims, store } = claimStore();
    const d = deps(store);
    d.sendMessage.mockRejectedValue(new Error("telegram down"));
    const update = {
      update_id: 777001,
      message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" },
    };
    await expect(handleTelegramUpdate(update, CONFIG, d)).rejects.toThrow("telegram down");
    expect(store.releaseTelegramUpdate).toHaveBeenCalledWith(777001);
    expect(claims.has(777001)).toBe(false);

    // Telegram redelivers after the webhook's error - this time the
    // send works and the turn runs again instead of being ignored.
    d.sendMessage.mockResolvedValue(undefined);
    const retry = await handleTelegramUpdate(update, CONFIG, d);
    expect(retry).toBe("chatted");
    expect(d.runChat).toHaveBeenCalledTimes(2);
  });

  it("CD-6: a completed turn keeps its claim (no release, redelivery still ignored)", async () => {
    const { store } = claimStore();
    const d = deps(store);
    const update = {
      update_id: 777002,
      message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" },
    };
    expect(await handleTelegramUpdate(update, CONFIG, d)).toBe("chatted");
    expect(await handleTelegramUpdate(update, CONFIG, d)).toBe("duplicate_ignored");
    expect(store.releaseTelegramUpdate).not.toHaveBeenCalled();
  });

  it("CD-6: a failed release logs loudly and the original failure still surfaces", async () => {
    const { store } = claimStore();
    (store.releaseTelegramUpdate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db gone"));
    const d = deps(store);
    d.sendMessage.mockRejectedValue(new Error("telegram down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        handleTelegramUpdate(
          { update_id: 777003, message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" } },
          CONFIG,
          d,
        ),
      ).rejects.toThrow("telegram down");
      const loud = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("FAILED to release the update claim")),
      );
      expect(loud).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Lane 1 (audit B-4): when his records fail to load, the reply
  // must SAY so - never a silently dumber answer.
  it("tells the owner when his context failed to load", async () => {
    const store = fakeStore({
      loadHistory: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" } },
      CONFIG,
      d,
    );
    expect(result).toBe("chatted");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("couldn't pull up your records");
  });
});
