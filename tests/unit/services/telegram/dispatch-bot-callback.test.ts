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

  it("a reply that asks for a yes/no goes out with a Yes / No reply keyboard (works without callback_query delivery)", async () => {
    const d = deps();
    const withKeys = d as unknown as { sendYesNoMessage: ReturnType<typeof vi.fn>; runChat: ReturnType<typeof vi.fn> };
    withKeys.sendYesNoMessage = vi.fn().mockResolvedValue(undefined);
    withKeys.runChat.mockResolvedValue({
      reply: "I have NOT recorded this yet. Reply YES to confirm, or NO to drop it:\n- Expense: $88.00",
      memory: null,
    });
    await handleTelegramUpdate(textUpdate(60, "the tire was 88"), CONFIG, d);
    expect(withKeys.sendYesNoMessage).toHaveBeenCalledTimes(1);
    expect(withKeys.sendYesNoMessage.mock.calls[0]![1]).toContain("Reply YES");
    expect(d.sendAskMessage).not.toHaveBeenCalled();
  });

  it("an ordinary reply carries no keyboard, and a failed keyboard degrades to plain text", async () => {
    const plain = deps();
    const keys = vi.fn().mockResolvedValue(undefined);
    (plain as unknown as { sendYesNoMessage: unknown }).sendYesNoMessage = keys;
    (plain as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "You have 3h left.", memory: null });
    await handleTelegramUpdate(textUpdate(61, "how much time"), CONFIG, plain);
    expect(keys).not.toHaveBeenCalled();
    expect(plain.sendMessage).toHaveBeenCalledWith(4242, "You have 3h left.");

    const broken = deps();
    (broken as unknown as { sendYesNoMessage: unknown }).sendYesNoMessage = vi.fn().mockRejectedValue(new Error("no keyboard today"));
    (broken as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "Reply YES to confirm", memory: null });
    await handleTelegramUpdate(textUpdate(62, "x"), CONFIG, broken);
    expect(broken.sendMessage).toHaveBeenCalledWith(4242, "Reply YES to confirm");
  });

  it("pressing the Yes key is an ordinary message 'Yes' and runs the same path as typing it", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    runChat.mockResolvedValue({ reply: "Done - recorded.", memory: null });
    expect(await handleTelegramUpdate(textUpdate(66, "Yes"), CONFIG, d)).not.toBe("ignored_no_chat");
    expect(runChat.mock.calls[0]![0].userText).toBe("Yes");
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

describe("readable messages: no raw markdown reaches Telegram (owner 2026-11-07)", () => {
  it("stars, headings and bullets from the model are cleaned and emoji-labelled before sending", async () => {
    const d = deps();
    (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({
      reply: "## Pay this week\n**Load**: Macon → Tampa\n* Pay: **$1,700.00**\n- Fuel is on the company card",
      memory: null,
    });
    await handleTelegramUpdate({ update_id: 90, message: { chat: { id: 4242, type: "private" }, text: "how am i doing", date: 1 } }, CONFIG, d);
    const sent = String(d.sendMessage.mock.calls.at(-1)![1]);
    expect(sent).not.toMatch(/[*#]/);
    expect(sent).toContain("💵 Pay this week");
    expect(sent).toContain("🚚 Load: Macon → Tampa");
    expect(sent).toContain("💵 Pay: $1,700.00");
    expect(sent).toContain("⛽ Fuel is on the company card");
  });
});

describe("personality: stickers and reactions (owner 2026-11-07)", () => {
  const update = (id: number, extra: Record<string, unknown>) => ({ update_id: id, message: { chat: { id: 4242, type: "private" }, date: 1, ...extra } });

  it("a sticker he sends reaches Abel as '[sticker 😂]' - not the 'I only work with text' reply", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    runChat.mockResolvedValue({ reply: "😂 Ha - good one.", memory: null });
    await handleTelegramUpdate(update(100, { message_id: 7, sticker: { emoji: "😂" } }) as never, CONFIG, d);
    expect(runChat.mock.calls[0]![0].userText).toBe("[sticker 😂]");
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "😂 Ha - good one.");
    expect(String(d.sendMessage.mock.calls.at(-1)![1])).not.toMatch(/I work with text and photos/);
  });

  it("a GIF reaches Abel as '[GIF]'", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    runChat.mockResolvedValue({ reply: "Nice truck.", memory: null });
    await handleTelegramUpdate(update(101, { animation: { file_id: "g" }, caption: "my rig" }) as never, CONFIG, d);
    expect(runChat.mock.calls[0]![0].userText).toBe("[GIF] my rig");
  });

  it("a sticker can never approve a waiting proposal - it is just text", async () => {
    const d = deps();
    const runChat = (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat;
    runChat.mockResolvedValue({ reply: "Still waiting on your yes.", memory: null });
    await handleTelegramUpdate(update(102, { sticker: { emoji: "👍" } }) as never, CONFIG, d);
    expect(runChat.mock.calls[0]![0].userText).toBe("[sticker 👍]");
  });

  it("the sticker and reaction Abel asked for go out AFTER the clean text; the markers are never shown or stored", async () => {
    const d = deps();
    const sendSticker = vi.fn().mockResolvedValue(undefined);
    const setReaction = vi.fn().mockResolvedValue(undefined);
    Object.assign(d, { sendSticker, setReaction });
    (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({
      reply: "🚚 Delivered - nice work!\n{{sticker:🎉}}\n{{react:🔥}}",
      memory: null,
    });
    await handleTelegramUpdate(update(103, { message_id: 55, text: "delivered the load" }) as never, CONFIG, d);
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "🚚 Delivered - nice work!");
    expect(sendSticker).toHaveBeenCalledWith(4242, "🎉");
    expect(setReaction).toHaveBeenCalledWith(4242, 55, "🔥");
    const store = (d as unknown as { store: { saveMessage: ReturnType<typeof vi.fn> } }).store;
    const stored = store.saveMessage.mock.calls.map((c) => String(c[2])).join("\n");
    expect(stored).not.toContain("{{");
  });

  it("no sticker or reaction on a warning or an approval request, even if Abel asked", async () => {
    const d = deps();
    const sendSticker = vi.fn();
    const setReaction = vi.fn();
    Object.assign(d, { sendSticker, setReaction });
    (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "⚠️ You're close to your 14-hour limit {{sticker:😂}} {{react:👍}}", memory: null });
    await handleTelegramUpdate(update(104, { message_id: 56, text: "how long do i have" }) as never, CONFIG, d);
    expect(sendSticker).not.toHaveBeenCalled();
    expect(setReaction).not.toHaveBeenCalled();
    expect(String(d.sendMessage.mock.calls.at(-1)![1])).not.toContain("{{");
  });

  it("a failing sticker or reaction never breaks the turn - the text already went out", async () => {
    const d = deps();
    Object.assign(d, { sendSticker: vi.fn().mockRejectedValue(new Error("boom")), setReaction: vi.fn().mockRejectedValue(new Error("boom")) });
    (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply: "Great news {{sticker:🎉}} {{react:🎉}}", memory: null });
    const r = await handleTelegramUpdate(update(105, { message_id: 57, text: "paycheck came in" }) as never, CONFIG, d);
    expect(r).not.toBe("error");
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "Great news");
  });
});

describe("GIF memes through the dispatch path", () => {
  it("a {{gif:...}} marker is stripped from the text and sent via sendGif after the text; none on a serious message", async () => {
    const d = deps();
    const sendGif = vi.fn().mockResolvedValue(undefined);
    Object.assign(d, { sendGif });
    const chat = (reply: string, id: number) => {
      (d as unknown as { runChat: ReturnType<typeof vi.fn> }).runChat.mockResolvedValue({ reply, memory: null });
      return handleTelegramUpdate({ update_id: id, message: { chat: { id: 4242, type: "private" }, text: "hello", date: 1 } } as never, CONFIG, d);
    };
    await chat("🎉 Paycheck landed!\n{{gif:money rain}}", 110);
    expect(d.sendMessage).toHaveBeenCalledWith(4242, "🎉 Paycheck landed!");
    expect(sendGif).toHaveBeenCalledWith(4242, "money rain");
    sendGif.mockClear();
    await chat("⚠️ You're over your limit {{gif:facepalm}}", 111);
    expect(sendGif).not.toHaveBeenCalled();
  });
});
