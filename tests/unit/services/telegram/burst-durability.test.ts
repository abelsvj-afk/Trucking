// Telegram fix round (ChatGPT T-002): pending bursts are durable.
// Before this round the collector was memory-only - a process
// restart between Telegram's ack and the flush lost the bundle
// forever (and the update claims meant redelivery was ignored as
// duplicates). These tests pin the persistence contract: mirror on
// every schedule, claim before flushing (a claimed-elsewhere bundle
// stands down), clear after success, release after failure, and a
// recovery sweep that works overdue bundles exactly once.

import { describe, expect, it, vi } from "vitest";
import {
  createTelegramBurstCollector,
  type TelegramBurstItem,
  type TelegramBurstPersistence,
} from "@/services/telegram/burst";

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

function fakePersistence(overrides: Partial<TelegramBurstPersistence> = {}): TelegramBurstPersistence {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(true),
    claimDue: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const item = (text: string, updateId = 1): TelegramBurstItem => ({ text, isForwarded: true, updateId });

describe("durable burst collector", () => {
  it("mirrors the bundle to persistence on enqueue, claims before flushing, clears after", async () => {
    const scheduler = new ManualScheduler();
    const persistence = fakePersistence();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time, persistence });
    const flush = vi.fn().mockResolvedValue(undefined);

    collector.enqueue("4242", item("dispatch text"), flush);
    expect(persistence.save).toHaveBeenCalledTimes(1);
    const savedItems = (persistence.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as TelegramBurstItem[];
    expect(savedItems.map((i) => i.text)).toEqual(["dispatch text"]);

    await scheduler.advance(3_000);
    expect(persistence.claim).toHaveBeenCalledWith("4242");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(persistence.clear).toHaveBeenCalledWith("4242");
    expect(persistence.release).not.toHaveBeenCalled();
  });

  it("stands down when the persisted bundle is already claimed by a recovery sweep", async () => {
    const scheduler = new ManualScheduler();
    const persistence = fakePersistence({ claim: vi.fn().mockResolvedValue(false) });
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time, persistence });
    const flush = vi.fn().mockResolvedValue(undefined);

    collector.enqueue("4242", item("dispatch text"), flush);
    await scheduler.advance(3_000);
    expect(flush).not.toHaveBeenCalled();
    expect(persistence.clear).not.toHaveBeenCalled();
  });

  it("releases the persisted claim when the flush fails, so the sweep can retry", async () => {
    const scheduler = new ManualScheduler();
    const persistence = fakePersistence();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time, persistence });
    const flush = vi.fn().mockRejectedValue(new Error("send failed"));
    const onError = vi.fn().mockResolvedValue(undefined);

    collector.enqueue("4242", item("dispatch text"), flush, onError);
    await scheduler.advance(3_000);
    expect(persistence.release).toHaveBeenCalledWith("4242");
    expect(persistence.clear).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("recoverDue works an overdue persisted bundle through the caller's handlers, once", async () => {
    const scheduler = new ManualScheduler();
    const recovered = [item("recovered dispatch", 77)];
    const persistence = fakePersistence({ claimDue: vi.fn().mockResolvedValue([{ key: "4242", items: recovered }]) });
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time, persistence });
    const flush = vi.fn().mockResolvedValue(undefined);

    const worked = await collector.recoverDue(() => ({ flush }));
    expect(worked).toBe(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect((flush.mock.calls[0]?.[0] as TelegramBurstItem[]).map((i) => i.text)).toEqual(["recovered dispatch"]);
    expect(persistence.clear).toHaveBeenCalledWith("4242");
  });

  it("recoverDue hands the claim back when the same chat has a live in-memory bundle", async () => {
    const scheduler = new ManualScheduler();
    const persistence = fakePersistence({
      claimDue: vi.fn().mockResolvedValue([{ key: "4242", items: [item("old copy", 78)] }]),
    });
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time, persistence });
    const liveFlush = vi.fn().mockResolvedValue(undefined);
    collector.enqueue("4242", item("live dispatch"), liveFlush);

    const sweepFlush = vi.fn().mockResolvedValue(undefined);
    const worked = await collector.recoverDue(() => ({ flush: sweepFlush }));
    expect(worked).toBe(0);
    expect(sweepFlush).not.toHaveBeenCalled();
    expect(persistence.release).toHaveBeenCalledWith("4242");
  });

  it("collectMedia joins an open bundle and returns false when none is open", async () => {
    const scheduler = new ManualScheduler();
    const collector = createTelegramBurstCollector({ scheduler, now: scheduler.time });
    const flush = vi.fn().mockResolvedValue(undefined);
    const photoItem: TelegramBurstItem = {
      text: "",
      isForwarded: false,
      updateId: 9,
      media: { kind: "photo", photo: [{ file_id: "p1" }] },
    };

    expect(collector.collectMedia("4242", photoItem, flush)).toBe(false);
    collector.enqueue("4242", item("trip text"), flush);
    expect(collector.collectMedia("4242", photoItem, flush)).toBe(true);

    await scheduler.advance(3_000);
    expect(flush).toHaveBeenCalledTimes(1);
    const flushed = flush.mock.calls[0]?.[0] as TelegramBurstItem[];
    expect(flushed).toHaveLength(2);
    expect(flushed[1]?.media?.photo[0]?.file_id).toBe("p1");
  });
});
