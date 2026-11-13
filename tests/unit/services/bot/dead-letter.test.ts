// D12 (Telegram review 2026-11-12): a persist failure must retry once,
// then land a dead-letter row, then surface a one-line warning - never
// silently hold the only copy in memory.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBotStore } from "@/services/bot/store";
import { createThreadMemoryStore } from "@/services/bot/store-entities";
import { saveDeadLetterRow } from "@/services/bot/dead-letter";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
} from "@/services/telegram/dispatch-bot";
import type { TelegramStore } from "@/services/telegram/store";

const COMPANY = "company-1";

type Row = Record<string, unknown>;

interface ClientOpts {
  /** Fail the first N telegram_messages inserts, then succeed. Infinity = always fail. */
  failMessages?: number;
  /** Fail the first N telegram_pending_bursts upserts, then succeed. Infinity = always fail. */
  failBursts?: number;
  /** The dead-letter insert itself fails. */
  failDeadLetters?: boolean;
  /** The dead-letter insert throws instead of returning an error. */
  throwDeadLetters?: boolean;
  /** Burst upserts fail with a missing-table error (pre-migration degradation). */
  burstMissingTable?: boolean;
}

/** A counting fake client: only the insert/upsert shapes the D12 paths use. */
function makeClient(opts: ClientOpts = {}) {
  const calls = { messageInserts: 0, burstUpserts: 0, deadLetterAttempts: 0, deadLetters: [] as Row[] };
  const messageFailsLeft = { n: opts.failMessages ?? 0 };
  const burstFailsLeft = { n: opts.failBursts ?? 0 };
  const queryFor = (table: string) => ({
    insert: (row: Row) => {
      if (table === "telegram_messages") {
        calls.messageInserts += 1;
        if (messageFailsLeft.n > 0) {
          messageFailsLeft.n -= 1;
          return Promise.resolve({ error: { message: "db down" }, data: null });
        }
        return Promise.resolve({ error: null, data: row });
      }
      if (table === "telegram_dead_letters") {
        calls.deadLetterAttempts += 1;
        if (opts.throwDeadLetters) throw new Error("dead-letter table gone");
        if (opts.failDeadLetters) return Promise.resolve({ error: { message: "dead-letter insert failed" }, data: null });
        calls.deadLetters.push(row);
        return Promise.resolve({ error: null, data: row });
      }
      return Promise.resolve({ error: null, data: row });
    },
    upsert: (row: Row) => {
      calls.burstUpserts += 1;
      if (opts.burstMissingTable) {
        return Promise.resolve({ error: { message: 'relation "telegram_pending_bursts" does not exist' }, data: null });
      }
      if (burstFailsLeft.n > 0) {
        burstFailsLeft.n -= 1;
        return Promise.resolve({ error: { message: "db down" }, data: null });
      }
      return Promise.resolve({ error: null, data: row });
    },
  });
  const client = { from: (table: string) => queryFor(table) } as unknown as SupabaseClient;
  return { client, calls };
}

describe("D12: message persist retries once, then dead-letters, then throws", () => {
  it("saveMessage succeeds on the retry after one failure - no dead letter", async () => {
    const { client, calls } = makeClient({ failMessages: 1 });
    const store = createBotStore(client, COMPANY, "telegram");
    await store.saveMessage(4242, "user", "hello");
    expect(calls.messageInserts).toBe(2);
    expect(calls.deadLetters).toHaveLength(0);
  });

  it("saveMessage failing twice throws and leaves one dead letter with the text", async () => {
    const { client, calls } = makeClient({ failMessages: Infinity });
    const store = createBotStore(client, COMPANY, "telegram");
    await expect(store.saveMessage(4242, "user", "the load is delivered")).rejects.toThrow("db down");
    expect(calls.messageInserts).toBe(2);
    expect(calls.deadLetters).toHaveLength(1);
    expect(calls.deadLetters[0]).toMatchObject({
      company_id: COMPANY,
      chat_id: "4242",
      kind: "message",
      error: "db down",
    });
    expect((calls.deadLetters[0]!.payload as Row).text).toBe("the load is delivered");
    expect((calls.deadLetters[0]!.payload as Row).role).toBe("user");
  });

  it("saveConversationMessage dead-letters with a null chat id", async () => {
    const { client, calls } = makeClient({ failMessages: Infinity });
    const store = createBotStore(client, COMPANY, "telegram");
    await expect(store.saveConversationMessage("assistant", "done")).rejects.toThrow("db down");
    expect(calls.deadLetters).toHaveLength(1);
    expect((calls.deadLetters[0]!.payload as Row).chat_id).toBeNull();
  });

  it("a failing dead-letter write never masks the original throw", async () => {
    const { client, calls } = makeClient({ failMessages: Infinity, failDeadLetters: true });
    const store = createBotStore(client, COMPANY, "telegram");
    await expect(store.saveMessage(4242, "user", "hello")).rejects.toThrow("db down");
    expect(calls.deadLetterAttempts).toBe(1);
    expect(calls.deadLetters).toHaveLength(0);
  });
});

describe("D12: pending-burst persist retries once, then dead-letters, never throws", () => {
  const ITEMS = [{ text: "first" }, { text: "second" }];

  it("savePendingBurst succeeds on the retry after one failure - no dead letter", async () => {
    const { client, calls } = makeClient({ failBursts: 1 });
    const store = createThreadMemoryStore(client, COMPANY, "telegram");
    await store.savePendingBurst("4242", ITEMS, "2026-11-12T18:00:00.000Z");
    expect(calls.burstUpserts).toBe(2);
    expect(calls.deadLetters).toHaveLength(0);
  });

  it("savePendingBurst failing twice resolves and leaves one pending_burst dead letter", async () => {
    const { client, calls } = makeClient({ failBursts: Infinity });
    const store = createThreadMemoryStore(client, COMPANY, "telegram");
    await store.savePendingBurst("4242", ITEMS, "2026-11-12T18:00:00.000Z");
    expect(calls.burstUpserts).toBe(2);
    expect(calls.deadLetters).toHaveLength(1);
    expect(calls.deadLetters[0]).toMatchObject({ kind: "pending_burst", error: "db down" });
    expect((calls.deadLetters[0]!.payload as Row).items).toEqual(ITEMS);
  });

  it("a missing bursts table is still silent degradation: no retry, no dead letter", async () => {
    const { client, calls } = makeClient({ burstMissingTable: true });
    const store = createThreadMemoryStore(client, COMPANY, "telegram");
    await store.savePendingBurst("4242", ITEMS, "2026-11-12T18:00:00.000Z");
    expect(calls.burstUpserts).toBe(1);
    expect(calls.deadLetters).toHaveLength(0);
  });
});

describe("D12: saveDeadLetterRow never throws", () => {
  it("returns true on success, false on error or throw", async () => {
    const ok = makeClient();
    expect(await saveDeadLetterRow(ok.client, COMPANY, "message", { text: "hi" }, "db down", 4242)).toBe(true);
    const failing = makeClient({ failDeadLetters: true });
    expect(await saveDeadLetterRow(failing.client, COMPANY, "message", { text: "hi" }, "db down", 4242)).toBe(false);
    const throwing = makeClient({ throwDeadLetters: true });
    expect(await saveDeadLetterRow(throwing.client, COMPANY, "message", { text: "hi" }, "db down", 4242)).toBe(false);
  });
});

describe("D12: the owner gets one warning line when a turn won't persist", () => {
  const CONFIG: TelegramConfig = { botToken: "test-token", webhookSecret: null, allowedChatId: "4242", companyId: null };

  function deps(store: TelegramStore | null): TelegramDeps & { sendMessage: ReturnType<typeof vi.fn> } {
    return {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSuggestion: vi.fn().mockResolvedValue({
        likely_sender_role: "dispatcher",
        sender_reasoning: "",
        whats_being_asked: "",
        meaning_notes: null,
        translation_en: null,
        suggested_reply: "",
        suggested_reply_language: "en",
        recordable_items: [],
        source_language: "en",
      }),
      runChat: vi.fn().mockResolvedValue({ reply: "Your 14 runs out at 8 PM.", memory: null }),
      store,
    };
  }

  function fakeStore(overrides: Partial<TelegramStore> = {}): TelegramStore {
    return {
      loadHistory: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn().mockResolvedValue(undefined),
      loadSnapshot: vi.fn().mockResolvedValue(null),
      storeExchange: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("a failing persist still sends the reply, then the warning - and nothing else", async () => {
    const store = fakeStore({ saveMessage: vi.fn().mockRejectedValue(new Error("db down")) });
    const d = deps(store);
    const result = await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "how much do I have left on my 14?" } },
      CONFIG,
      d,
    );
    expect(result).toBe("chatted");
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
    expect(d.sendMessage.mock.calls[0]?.[1]).toContain("Your 14 runs out at 8 PM.");
    expect(d.sendMessage.mock.calls[1]?.[1]).toBe("I couldn't save that to your record — still done, just not stored");
  });

  it("a healthy persist sends no warning", async () => {
    const store = fakeStore();
    const d = deps(store);
    await handleTelegramUpdate(
      { message: { chat: { id: 4242, type: "private" }, text: "how much do I have left on my 14?" } },
      CONFIG,
      d,
    );
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.saveMessage).toHaveBeenCalledWith(4242, "user", "how much do I have left on my 14?");
    expect(store.saveMessage).toHaveBeenCalledWith(4242, "assistant", expect.stringContaining("Your 14 runs out"));
  });
});
