// Telegram repairs (2026-11-03): forward/burst batching. The
// owner's headline complaint - forward a 20-message group
// conversation, get 20 individual replies - is fixed by collecting
// burst traffic per chat and working it as ONE turn: one dispatch
// workup, one thread capture, one consolidated reply. A lone
// message pays only the sub-second burst-detection grace, never
// the forward quiet window.

import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
  type TelegramUpdate,
} from "@/services/telegram/dispatch-bot";
import {
  createTelegramBurstCollector,
  TELEGRAM_BURST_DETECTION_GRACE_MS,
  TELEGRAM_FORWARD_BURST_QUIET_MS,
} from "@/services/telegram/burst";
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

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic scheduler: timers fire only when the test advances time. */
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
  nextDelay(): number | null {
    if (this.timers.length === 0) return null;
    return Math.min(...this.timers.map((t) => t.at)) - this.clock;
  }
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.clock = due.at;
      due.fn();
      // Let the async flush (model mocks + send) settle.
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
    ...overrides,
  };
}

function deps(store: TelegramStore | null = null): TelegramDeps & {
  sendMessage: ReturnType<typeof vi.fn>;
  getSuggestion: ReturnType<typeof vi.fn>;
  runChat: ReturnType<typeof vi.fn>;
  captureThread: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSuggestion: vi.fn().mockResolvedValue(SUGGESTION),
    runChat: vi.fn().mockResolvedValue({ reply: "He is asking you to confirm the 6 AM arrival.", memory: null }),
    captureThread: vi.fn().mockResolvedValue(undefined),
    store,
  };
}

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: null,
};

function forward(updateId: number, text: string, fromName = "Steven"): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: 4242, type: "private" },
      text,
      forward_origin: { type: "user", sender_user: { first_name: fromName } },
      forward_date: 1_700_000_000,
    },
  };
}

describe("forward burst batching", () => {
  it("a 20-forward burst produces exactly ONE response, one workup, one thread capture", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const store = fakeStore();
    const d = deps(store);
    const wired = { ...d, burstCollector: collector };

    for (let i = 1; i <= 20; i++) {
      const result = await handleTelegramUpdate(
        forward(1000 + i, `Mensaje ${i}: la carga sale a las 6`),
        CONFIG,
        wired,
      );
      expect(result).toBe("burst_queued");
    }
    expect(d.sendMessage).not.toHaveBeenCalled();

    // The quiet window EXTENDS while items keep arriving: advancing
    // almost the whole window after the last item sends nothing...
    await scheduler.advance(TELEGRAM_FORWARD_BURST_QUIET_MS - 1);
    expect(d.sendMessage).not.toHaveBeenCalled();
    // ...and the flush lands as a single consolidated turn.
    await scheduler.advance(1);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.getSuggestion).toHaveBeenCalledTimes(1);
    expect(store.storeExchange).toHaveBeenCalledTimes(1);
    expect(d.captureThread).toHaveBeenCalledTimes(1);

    const combined = d.getSuggestion.mock.calls[0]?.[0] as string;
    expect(combined).toContain("Mensaje 1");
    expect(combined).toContain("Mensaje 20");
    expect(combined).toContain("Steven");
    const captured = d.captureThread.mock.calls[0]?.[0] as string;
    expect(captured).toBe(combined);

    // Timeline: every forwarded item persisted once as his message,
    // the ONE reply persisted once as Abel's.
    const userSaves = (store.saveMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "user",
    );
    const assistantSaves = (store.saveMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "assistant",
    );
    expect(userSaves).toHaveLength(20);
    expect(assistantSaves).toHaveLength(1);
  });

  it("a singleton message pays only the sub-second detection grace, never the quiet window", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const d = deps(fakeStore());
    const wired = { ...d, burstCollector: collector };

    const result = await handleTelegramUpdate(
      { update_id: 2001, message: { chat: { id: 4242, type: "private" }, text: "When does my 14 run out?" } },
      CONFIG,
      wired,
    );
    expect(result).toBe("burst_queued");
    // Latency proof: the scheduled delay for a lone non-forward
    // message is the detection grace - an order of magnitude below
    // the forward quiet window, and below one second outright.
    expect(TELEGRAM_BURST_DETECTION_GRACE_MS).toBeLessThan(1000);
    expect(scheduler.nextDelay()).toBe(TELEGRAM_BURST_DETECTION_GRACE_MS);
    await scheduler.advance(TELEGRAM_BURST_DETECTION_GRACE_MS - 1);
    expect(d.sendMessage).not.toHaveBeenCalled();
    await scheduler.advance(1);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.runChat).toHaveBeenCalledTimes(1);
  });

  it("a redelivered update inside a burst is claimed once and never double-processed", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const claims = new Set<number>();
    const store = fakeStore({
      claimTelegramUpdate: vi.fn(async (updateId: number) => {
        if (claims.has(updateId)) return false;
        claims.add(updateId);
        return true;
      }),
      releaseTelegramUpdate: vi.fn(async (updateId: number) => {
        claims.delete(updateId);
      }),
    });
    const d = deps(store);
    const wired = { ...d, burstCollector: collector };

    const update = forward(3001, "La carga sale a las 6");
    expect(await handleTelegramUpdate(update, CONFIG, wired)).toBe("burst_queued");
    expect(await handleTelegramUpdate(update, CONFIG, wired)).toBe("duplicate_ignored");
    expect(await handleTelegramUpdate(forward(3002, "Confirma por favor"), CONFIG, wired)).toBe("burst_queued");

    await scheduler.advance(TELEGRAM_FORWARD_BURST_QUIET_MS);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.getSuggestion).toHaveBeenCalledTimes(1);
    const combined = d.getSuggestion.mock.calls[0]?.[0] as string;
    expect(combined.match(/La carga sale a las 6/g)).toHaveLength(1);
  });

  it("a direct question riding with the forwards is answered inside the same single response", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const store = fakeStore();
    const d = deps(store);
    const wired = { ...d, burstCollector: collector };

    await handleTelegramUpdate(forward(4001, "Necesito que llegues a las 6 de la mañana"), CONFIG, wired);
    await handleTelegramUpdate(forward(4002, "Confirma cuando puedas"), CONFIG, wired);
    const question = await handleTelegramUpdate(
      { update_id: 4003, message: { chat: { id: 4242, type: "private" }, text: "Abel, what is Steven asking me to do?" } },
      CONFIG,
      wired,
    );
    expect(question).toBe("burst_queued");

    await scheduler.advance(TELEGRAM_FORWARD_BURST_QUIET_MS);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.getSuggestion).toHaveBeenCalledTimes(1);
    expect(d.runChat).toHaveBeenCalledTimes(1);
    expect(d.captureThread).toHaveBeenCalledTimes(1);
    const sent = d.sendMessage.mock.calls[0]?.[1] as string;
    expect(sent).toContain("Translation:");
    expect(sent).toContain("He is asking you to confirm the 6 AM arrival.");
  });

  it("two successive bursts stay two turns - the collector resets after a flush", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const d = deps(fakeStore());
    const wired = { ...d, burstCollector: collector };

    await handleTelegramUpdate(forward(5001, "Primera carga a las 6"), CONFIG, wired);
    await scheduler.advance(TELEGRAM_FORWARD_BURST_QUIET_MS);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);

    await handleTelegramUpdate(forward(5002, "Segunda carga a las 9"), CONFIG, wired);
    await scheduler.advance(TELEGRAM_FORWARD_BURST_QUIET_MS);
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
    expect(d.getSuggestion).toHaveBeenCalledTimes(2);
    expect(d.captureThread).toHaveBeenCalledTimes(2);
  });
});
