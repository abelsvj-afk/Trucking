// Telegram fix round: ChatGPT T-004 (claim-failure write refusal)
// and brief fix 7 (a photo joins an open burst bundle).
//
// T-004: the update_id claim is the ONLY thing standing between a
// Telegram redelivery and a doubled write. When the claim call
// itself fails, dedup is not established - these tests pin that the
// turn then runs read-only: no photo filed, no tap settled, no
// burst queued, and the agent is told writes are refused. A claim
// that answers "already claimed" still dedups exactly, including
// for two deliveries racing at once.

import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
  type TelegramUpdate,
} from "@/services/telegram/dispatch-bot";
import { createTelegramBurstCollector } from "@/services/telegram/burst";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { TelegramStore } from "@/services/telegram/store";

const SUGGESTION: DispatchSuggestion = {
  likely_sender_role: "dispatcher",
  sender_reasoning: "Assigns a trip.",
  whats_being_asked: "New trip.",
  meaning_notes: null,
  translation_en: null,
  suggested_reply: null,
  suggested_reply_language: "en",
  recordable_items: [],
  source_language: "en",
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

class ManualScheduler {
  clock = 0;
  time = (): number => this.clock;
  private nextId = 1;
  private timers: Timer[] = [];
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.clock + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.clock = due.at;
      due.fn();
      for (let i = 0; i < 30; i++) await Promise.resolve();
    }
    this.clock = target;
  }
}

function fakeStore(overrides: Partial<TelegramStore> = {}): TelegramStore {
  return {
    loadHistory: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    loadMemories: vi.fn().mockResolvedValue([]),
    saveMemory: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue(null),
    storeExchange: vi.fn().mockResolvedValue(undefined),
    claimTelegramUpdate: vi.fn().mockResolvedValue(true),
    releaseTelegramUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: null,
};

function textUpdate(updateId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { chat: { id: 4242, type: "private" }, text } };
}

function forwardUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: 4242, type: "private" },
      text,
      forward_origin: { type: "user", sender_user: { first_name: "Dispatch" } },
      forward_date: 1_700_000_000,
    },
  };
}

function photoUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: 4242, type: "private" },
      photo: [{ file_id: "small" }, { file_id: "large", file_size: 1000 }],
    },
  };
}

describe("T-004: claim failure makes the turn read-only", () => {
  it("a photo is NOT filed when the claim fails - he is told, in words", async () => {
    const store = fakeStore({ claimTelegramUpdate: vi.fn().mockRejectedValue(new Error("db down")) });
    const handlePhoto = vi.fn().mockResolvedValue("filed");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps: TelegramDeps = {
      sendMessage,
      getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
      runChat: vi.fn().mockResolvedValue({ reply: "ok", memory: null }),
      handlePhoto,
      store,
    };
    const result = await handleTelegramUpdate(photoUpdate(501), CONFIG, deps);
    expect(result).toBe("photo_replied");
    expect(handlePhoto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("didn't store it");
  });

  it("a text turn still answers, but the agent is told writes are refused and nothing joins a burst", async () => {
    const store = fakeStore({ claimTelegramUpdate: vi.fn().mockRejectedValue(new Error("db down")) });
    const runAgent = vi.fn().mockResolvedValue({ reply: "Here is what I found." });
    const collector = createTelegramBurstCollector({ scheduler: new ManualScheduler() });
    const enqueueSpy = vi.spyOn(collector, "enqueue");
    const deps: TelegramDeps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
      runChat: vi.fn().mockResolvedValue({ reply: "unused", memory: null }),
      runAgent,
      burstCollector: collector,
      store,
    };
    const result = await handleTelegramUpdate(textUpdate(502, "what loads do I have"), CONFIG, deps);
    expect(result).toBe("chatted");
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ writesRefused: true, chatId: "4242" });
  });

  it("a button tap settles nothing when the claim fails", async () => {
    const store = fakeStore({ claimTelegramUpdate: vi.fn().mockRejectedValue(new Error("db down")) });
    const resolvePhotoAsk = vi.fn().mockResolvedValue("settled");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const pendingId = "123e4567-e89b-42d3-a456-426614174000";
    const deps: TelegramDeps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
      runChat: vi.fn().mockResolvedValue({ reply: "ok", memory: null }),
      resolvePhotoAsk,
      answerCallbackQuery,
      store,
    };
    const update: TelegramUpdate = {
      update_id: 503,
      callback_query: {
        id: "q1",
        data: `pp:${pendingId}:bol`,
        message: { chat: { id: 4242, type: "private" }, date: Math.floor(Date.now() / 1000) },
      },
    };
    const result = await handleTelegramUpdate(update, CONFIG, deps);
    expect(result).toBe("callback_ignored");
    expect(resolvePhotoAsk).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous deliveries of the same update: exactly one is worked", async () => {
    const claimed = new Set<number>();
    const store = fakeStore({
      claimTelegramUpdate: vi.fn(async (updateId: number) => {
        // Yield so both deliveries reach the claim before either resolves it.
        await Promise.resolve();
        if (claimed.has(updateId)) return false;
        claimed.add(updateId);
        return true;
      }),
    });
    const runChat = vi.fn().mockResolvedValue({ reply: "answer", memory: null });
    const deps: TelegramDeps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
      runChat,
      store,
    };
    const update = textUpdate(504, "hello Abel");
    const [first, second] = await Promise.all([
      handleTelegramUpdate(update, CONFIG, deps),
      handleTelegramUpdate(update, CONFIG, deps),
    ]);
    expect([first, second].filter((r) => r === "duplicate_ignored")).toHaveLength(1);
    expect(runChat).toHaveBeenCalledTimes(1);
  });
});

describe("fix 7: a photo joins an open burst bundle", () => {
  it("forwards + trailer photo = ONE consolidated reply, photo filed at the flush, documents handed to staging", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const store = fakeStore();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const handlePhoto = vi.fn().mockResolvedValue({
      text: "Saved that photo and read it: trailer H11887, pickup #94405.",
      filed: {
        documentId: "55555555-5555-4555-8555-555555555555",
        fileName: "telegram-photo-1.jpg",
        identifiers: { trailerNumber: "H11887", pickupNumber: "94405" },
      },
    });
    const suggestionWithItems: DispatchSuggestion = { ...SUGGESTION, recordable_items: [{ tool_name: "create_load" }] as never };
    const stageRecordables = vi.fn().mockResolvedValue({
      proposals: [{ tool: "create_load", args: {}, summary: "Create load", batchId: "b1" }],
      rejected: [],
      blockedByPending: false,
      queuedBehindPending: false,
      review: "TRIP 1874 REVIEW",
    });
    const deps: TelegramDeps = {
      sendMessage,
      getSuggestion: vi.fn().mockResolvedValue(suggestionWithItems),
      runChat: vi.fn().mockResolvedValue({ reply: "unused", memory: null }),
      handlePhoto,
      stageRecordables,
      burstCollector: collector,
      store,
    };

    const r1 = await handleTelegramUpdate(forwardUpdate(601, "🚛 NEW TRIP 1874 HAS BEEN ASSIGNED"), CONFIG, deps);
    expect(r1).toBe("burst_queued");
    const r2 = await handleTelegramUpdate(photoUpdate(602), CONFIG, deps);
    expect(r2).toBe("burst_queued");
    expect(handlePhoto).not.toHaveBeenCalled();

    await scheduler.advance(3_000);
    await vi.waitFor(() => expect(handlePhoto).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(stageRecordables).toHaveBeenCalledTimes(1);
    const bundleArg = stageRecordables.mock.calls[0]?.[2] as { documents?: { documentId: string }[] } | undefined;
    expect(bundleArg?.documents?.[0]?.documentId).toBe("55555555-5555-4555-8555-555555555555");
    const replyText = String(sendMessage.mock.calls[0]?.[1]);
    expect(replyText).toContain("TRIP 1874 REVIEW");
  });

  it("a photo with NO open bundle keeps the solo path", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const store = fakeStore();
    const handlePhoto = vi.fn().mockResolvedValue("Saved that photo.");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps: TelegramDeps = {
      sendMessage,
      getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
      runChat: vi.fn().mockResolvedValue({ reply: "unused", memory: null }),
      handlePhoto,
      burstCollector: collector,
      store,
    };
    const result = await handleTelegramUpdate(photoUpdate(603), CONFIG, deps);
    expect(result).toBe("photo_replied");
    expect(handlePhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
