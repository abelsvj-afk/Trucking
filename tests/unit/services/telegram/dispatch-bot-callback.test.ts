// Photo intelligence §3.3: inline-keyboard taps in the Telegram
// bot. A tap is an update like any other - same private/allowlist
// gates, same Lane 1 dedup claim (a double-tap or Telegram retry
// settles exactly once, acceptance A2) - and it settles a photo's
// PURPOSE only, through the wired resolver.

import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
} from "@/services/telegram/dispatch-bot";
import type { TelegramStore } from "@/services/telegram/store";

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: "company-1",
};

const ASK_ID = "26262626-2626-4626-8626-262626262626";

function fakeStore() {
  const claimed = new Set<number>();
  return {
    loadHistory: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    loadMemories: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    storeExchange: vi.fn().mockResolvedValue(undefined),
    claimTelegramUpdate: vi.fn(async (updateId: number) => {
      if (claimed.has(updateId)) return false;
      claimed.add(updateId);
      return true;
    }),
    releaseTelegramUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramStore;
}

function deps(store: TelegramStore | null = fakeStore()) {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSuggestion: vi.fn(),
    runChat: vi.fn(),
    sendAskMessage: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    resolvePhotoAsk: vi.fn().mockResolvedValue("Done — marked as the trailer."),
    isPhotoIntelligenceEnabled: vi.fn().mockResolvedValue(true),
    store,
  } as unknown as TelegramDeps & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendAskMessage: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    resolvePhotoAsk: ReturnType<typeof vi.fn>;
    isPhotoIntelligenceEnabled: ReturnType<typeof vi.fn>;
  };
}

function tapUpdate(updateId: number, data: string, chatId = 4242) {
  return {
    update_id: updateId,
    callback_query: {
      id: `q-${updateId}`,
      data,
      message: { message_id: 9, chat: { id: chatId, type: "private" } },
    },
  };
}

describe("handleTelegramUpdate — callback_query (§3.3)", () => {
  it("resolves the tap, answers the callback, and sends the settle reply", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(tapUpdate(7001, `pp:${ASK_ID}:trailer`), CONFIG, d);
    expect(result).toBe("callback_replied");
    expect(d.resolvePhotoAsk).toHaveBeenCalledWith(ASK_ID, "trailer");
    expect(d.answerCallbackQuery).toHaveBeenCalledWith("q-7001", undefined);
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "Done — marked as the trailer.");
  });

  it("a double-tap / Telegram retry of the same tap settles exactly once (A2)", async () => {
    const d = deps();
    const update = tapUpdate(7002, `pp:${ASK_ID}:truck_exterior`);
    const first = await handleTelegramUpdate(update, CONFIG, d);
    const second = await handleTelegramUpdate(update, CONFIG, d);
    expect(first).toBe("callback_replied");
    expect(second).toBe("duplicate_ignored");
    expect(d.resolvePhotoAsk).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("silently ignores a tap from a non-allowlisted chat", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(tapUpdate(7003, `pp:${ASK_ID}:trailer`, 9999), CONFIG, d);
    expect(result).toBe("ignored_not_allowlisted");
    expect(d.resolvePhotoAsk).not.toHaveBeenCalled();
    expect(d.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("malformed tap data answers the spinner and settles nothing", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(tapUpdate(7004, "something-else"), CONFIG, d);
    expect(result).toBe("callback_ignored");
    expect(d.answerCallbackQuery).toHaveBeenCalledWith("q-7004", "That button doesn't work anymore.");
    expect(d.resolvePhotoAsk).not.toHaveBeenCalled();
  });

  it("with photo understanding off, a tap settles nothing (§3.4 gate)", async () => {
    const d = deps();
    d.isPhotoIntelligenceEnabled.mockResolvedValue(false);
    const result = await handleTelegramUpdate(tapUpdate(7005, `pp:${ASK_ID}:trailer`), CONFIG, d);
    expect(result).toBe("callback_ignored");
    expect(d.answerCallbackQuery).toHaveBeenCalledWith(
      "q-7005",
      "Photo understanding is turned off right now.",
    );
    expect(d.resolvePhotoAsk).not.toHaveBeenCalled();
  });
});

describe("handleTelegramUpdate — photo ask delivery (§3.3)", () => {
  const PHOTO = [{ file_id: "large", width: 1280, height: 960, file_size: 180_000 }];

  function photoDeps(handlePhoto: ReturnType<typeof vi.fn>) {
    const d = deps();
    return { ...d, handlePhoto } as typeof d & { handlePhoto: ReturnType<typeof vi.fn> };
  }

  it("sends the ask with buttons built from the staged options", async () => {
    const handlePhoto = vi.fn().mockResolvedValue({
      text: "Looks like the trailer. Am I right?",
      ask: {
        pendingId: ASK_ID,
        options: [
          { label: "🚚 The trailer", choice: "trailer" },
          { label: "🚛 The truck", choice: "truck_exterior" },
          { label: "🗂 Just file it", choice: "store" },
        ],
      },
    });
    const d = photoDeps(handlePhoto);
    const result = await handleTelegramUpdate(
      { update_id: 7010, message: { chat: { id: 4242, type: "private" }, photo: PHOTO } },
      CONFIG,
      d as unknown as TelegramDeps,
    );
    expect(result).toBe("photo_replied");
    expect(d.sendAskMessage).toHaveBeenCalledTimes(1);
    const [, text, buttons] = d.sendAskMessage.mock.calls[0]! as unknown as [
      number,
      string,
      { text: string; callback_data: string }[][],
    ];
    expect(text).toContain("Am I right?");
    const flat = buttons.flat();
    expect(flat.map((b) => b.callback_data)).toEqual([
      `pp:${ASK_ID}:trailer`,
      `pp:${ASK_ID}:truck_exterior`,
      `pp:${ASK_ID}:store`,
    ]);
    // The plain send path is not used when buttons land.
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("button delivery failing degrades to the same choices as numbered text", async () => {
    const handlePhoto = vi.fn().mockResolvedValue({
      text: "Looks like the trailer. Am I right?",
      ask: {
        pendingId: ASK_ID,
        options: [
          { label: "🚚 The trailer", choice: "trailer" },
          { label: "🗂 Just file it", choice: "store" },
        ],
      },
    });
    const d = photoDeps(handlePhoto);
    d.sendAskMessage.mockRejectedValue(new Error("no buttons today"));
    const result = await handleTelegramUpdate(
      { update_id: 7011, message: { chat: { id: 4242, type: "private" }, photo: PHOTO } },
      CONFIG,
      d as unknown as TelegramDeps,
    );
    expect(result).toBe("photo_replied");
    const sent = d.sendMessage.mock.calls[0]?.[1] as string;
    expect(sent).toContain("1. 🚚 The trailer");
    expect(sent).toContain("2. 🗂 Just file it");
    expect(sent).toContain("Reply with a number");
  });
});

describe("Yes / No buttons on proposals", () => {
  function textUpdate(updateId: number, text: string) {
    return { update_id: updateId, message: { message_id: 1, chat: { id: 4242, type: "private" }, text, date: 1 } };
  }

  it("a reply that asks for a yes/no goes out with Yes and No buttons", async () => {
    const d = deps();
    (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({
      reply: "I have NOT recorded this yet. Reply YES to confirm, or NO to drop it:\n- Expense: $88.00",
      memory: null,
    });
    await handleTelegramUpdate(textUpdate(60, "the tire was 88"), CONFIG, d);
    expect(d.sendAskMessage).toHaveBeenCalledTimes(1);
    const [, , buttons] = d.sendAskMessage.mock.calls[0]! as unknown as [number, string, { callback_data: string }[][]];
    expect(buttons[0]!.map((b) => b.callback_data)).toEqual(["yn:yes", "yn:no"]);
  });

  it("an ordinary reply carries no buttons, and failed buttons degrade to plain text", async () => {
    const plain = deps();
    (plain as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "You have 3h left.", memory: null });
    await handleTelegramUpdate(textUpdate(61, "how much time"), CONFIG, plain);
    expect(plain.sendAskMessage).not.toHaveBeenCalled();
    expect(plain.sendMessage).toHaveBeenCalledWith(4242, "You have 3h left.");

    const broken = deps();
    broken.sendAskMessage.mockRejectedValue(new Error("no buttons today"));
    (broken as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "Reply YES to confirm", memory: null });
    await handleTelegramUpdate(textUpdate(62, "x"), CONFIG, broken);
    expect(broken.sendMessage).toHaveBeenCalledWith(4242, "Reply YES to confirm");
  });

  it("a fresh tap runs exactly the typed 'yes' through the bot", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    runChat.mockResolvedValue({ reply: "Done - recorded.", memory: null });
    const now = Math.floor(Date.now() / 1000);
    const update = tapUpdate(63, "yn:yes");
    update.callback_query.message = { ...update.callback_query.message, date: now - 30 } as typeof update.callback_query.message;
    expect(await handleTelegramUpdate(update, CONFIG, d)).toBe("callback_replied");
    expect(runChat.mock.calls[0]![0].userText).toBe("yes");
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "Done - recorded.");
  });

  it("a tap on a message from long ago is refused, never answered as a yes", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    const update = tapUpdate(64, "yn:yes");
    update.callback_query.message = { ...update.callback_query.message, date: Math.floor(Date.now() / 1000) - 3600 } as typeof update.callback_query.message;
    expect(await handleTelegramUpdate(update, CONFIG, d)).toBe("callback_ignored");
    expect(runChat).not.toHaveBeenCalled();
    expect(d.answerCallbackQuery).toHaveBeenCalledWith("q-64", expect.stringContaining("a while back"));
  });
});
