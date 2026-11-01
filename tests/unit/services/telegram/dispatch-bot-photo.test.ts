// §13: photo messages in the Telegram bot's gating/flow rules.
// The same hard rules as text — private chat only, allowlist,
// bootstrap runs nothing — plus the photo branch itself: it stores
// through the wired intake, replies with the intake's own words,
// persists the turn, and never reaches the AI paths.

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
  translation_en: null,
  suggested_reply: "I'll be there.",
  suggested_reply_language: "en",
  recordable_items: [],
  source_language: "en",
};

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: "company-1",
};

const PHOTO = [{ file_id: "large", width: 1280, height: 960, file_size: 180_000 }];

function deps(store: TelegramStore | null = null): TelegramDeps & {
  sendMessage: ReturnType<typeof vi.fn>;
  getSuggestion: ReturnType<typeof vi.fn>;
  runChat: ReturnType<typeof vi.fn>;
  handlePhoto: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
    runChat: vi.fn().mockResolvedValue({ reply: "ok", memory: null }),
    handlePhoto: vi.fn().mockResolvedValue("Saved that photo as a document in your app."),
    store,
  };
}

function fakeStore(): TelegramStore {
  return {
    loadHistory: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    loadMemories: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    storeExchange: vi.fn().mockResolvedValue(undefined),
  };
}

describe("handleTelegramUpdate — photo messages (§13)", () => {
  it("stores the photo through the intake, replies with its words, and persists the turn", async () => {
    const store = fakeStore();
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, photo: PHOTO, caption: "BOL for Georgia" } },
      CONFIG,
      d,
    );
    expect(result).toBe("photo_replied");
    expect(d.handlePhoto).toHaveBeenCalledWith(PHOTO, "BOL for Georgia");
    expect(d.sendMessage).toHaveBeenCalledWith(
      4242,
      "Saved that photo as a document in your app.",
    );
    expect(store.saveMessage).toHaveBeenCalledWith(4242, "user", "[photo] BOL for Georgia");
    expect(store.saveMessage).toHaveBeenCalledWith(
      4242,
      "assistant",
      "Saved that photo as a document in your app.",
    );
    // A photo never reaches the AI paths.
    expect(d.getSuggestion).not.toHaveBeenCalled();
    expect(d.runChat).not.toHaveBeenCalled();
  });

  it("ignores a photo in a group chat, like every other message kind", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: -1001, type: "group" }, photo: PHOTO } },
      CONFIG,
      d,
    );
    expect(result).toBe("ignored_not_private");
    expect(d.handlePhoto).not.toHaveBeenCalled();
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("silently ignores a photo from a non-allowlisted chat", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 9999, type: "private" }, photo: PHOTO } },
      CONFIG,
      d,
    );
    expect(result).toBe("ignored_not_allowlisted");
    expect(d.handlePhoto).not.toHaveBeenCalled();
  });

  it("bootstrap mode answers a photo with only the chat id — no intake runs", async () => {
    const d = deps();
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 777, type: "private" }, photo: PHOTO } },
      { ...CONFIG, allowedChatId: null },
      d,
    );
    expect(result).toBe("bootstrap_replied");
    expect(d.handlePhoto).not.toHaveBeenCalled();
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("777");
  });

  it("says honestly that photo filing isn't configured when no intake is wired", async () => {
    const d = deps();
    const noIntake: TelegramDeps = { ...d, handlePhoto: undefined };
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, photo: PHOTO } },
      CONFIG,
      noIntake,
    );
    expect(result).toBe("photo_replied");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("isn't configured");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("couldn't store it");
  });

  it("survives an intake crash with an honest nothing-was-saved reply", async () => {
    const d = deps();
    d.handlePhoto.mockRejectedValue(new Error("kaboom"));
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, photo: PHOTO } },
      CONFIG,
      d,
    );
    expect(result).toBe("photo_replied");
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("nothing was saved");
  });
});
