import { describe, expect, it, vi } from "vitest";
import type { BotBrainStore } from "@/services/bot/store";

const NOW = new Date("2026-11-05T18:00:00Z");
const H = 3_600_000;
const rows = (list: Array<[string, number]>) => list.map(([duty_status, ago]) => ({ duty_status, started_at: new Date(NOW.getTime() - ago * H).toISOString() }));

let DUTY: ReturnType<typeof rows> = [];
vi.mock("@/services/api/hos-window", () => ({
  loadHosWindow: async () => ({ rows: DUTY }),
}));
vi.mock("@/services/telegram/store", () => ({ createTelegramBrainStore: () => null }));
vi.mock("@/services/telegram/notify", () => ({ createTelegramNotifier: () => ({ notifyOwner: async () => true }) }));

import { runRemindersIfDue } from "@/services/bot/reminder-scheduler";

function fakeStore(opts: { enabled?: boolean; existing?: Set<string>; insertError?: { message: string; code?: string } | null }) {
  const keys = opts.existing ?? new Set<string>();
  const deleted: string[] = [];
  const client = {
    from: () => ({
      insert: async (row: { dedupe_key: string }) => {
        if (opts.insertError) return { error: opts.insertError };
        if (keys.has(row.dedupe_key)) return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
        keys.add(row.dedupe_key);
        return { error: null };
      },
      delete: () => ({
        eq: () => ({
          eq: async (_c: string, k: string) => (deleted.push(k), keys.delete(k), { error: null }),
        }),
      }),
    }),
  };
  const store = { client, companyId: "co", isLoggingRemindersEnabled: async () => opts.enabled ?? true } as unknown as BotBrainStore;
  return { store, keys, deleted };
}

const HOS_SOON = () => rows([["off_duty", 30], ["driving", 10.5]]);

describe("runRemindersIfDue", () => {
  it("off (no row) = nothing is read or sent", async () => {
    DUTY = HOS_SOON();
    const notify = vi.fn();
    const { store } = fakeStore({ enabled: false });
    const r = await runRemindersIfDue({ store, notify, now: () => NOW, quietHours: () => false });
    expect(r.skipped).toMatch(/off/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends a due HOS reminder once, then never again for the same window", async () => {
    DUTY = HOS_SOON();
    const notify = vi.fn().mockResolvedValue(true);
    const { store } = fakeStore({});
    const first = await runRemindersIfDue({ store, notify, now: () => NOW, quietHours: () => false });
    expect(first.sent).toBeGreaterThan(0);
    expect(notify.mock.calls[0]![0]).toContain("not an ELD");
    const second = await runRemindersIfDue({ store, notify, now: () => NOW, quietHours: () => false });
    expect(second.sent).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("quiet hours hold the routine stale-status question but never a safety (HOS) warning", async () => {
    // 15 h of "driving": the clocks are long past their limits (critical) AND the log is stale (routine).
    DUTY = rows([["off_duty", 40], ["driving", 15]]);
    const notify = vi.fn().mockResolvedValue(true);
    const quiet = await runRemindersIfDue({ store: fakeStore({}).store, notify, now: () => NOW, quietHours: () => true });
    expect(quiet.held).toBe(1);
    expect(quiet.sent).toBeGreaterThan(0);
    expect(notify.mock.calls[0]![0]).not.toContain("still says");
    notify.mockClear();
    const day = await runRemindersIfDue({ store: fakeStore({}).store, notify, now: () => NOW, quietHours: () => false });
    expect(day.held).toBe(0);
    expect(notify.mock.calls[0]![0]).toContain("still says Driving");
  });

  it("a failed Telegram send releases the dedupe rows so the next tick retries", async () => {
    DUTY = HOS_SOON();
    const { store, keys, deleted } = fakeStore({});
    const failing = vi.fn().mockResolvedValue(false);
    const r = await runRemindersIfDue({ store, notify: failing, now: () => NOW, quietHours: () => false });
    expect(r.sent).toBe(0);
    expect(deleted.length).toBeGreaterThan(0);
    expect(keys.size).toBe(0);
    const ok = vi.fn().mockResolvedValue(true);
    expect((await runRemindersIfDue({ store, notify: ok, now: () => NOW, quietHours: () => false })).sent).toBeGreaterThan(0);
  });

  it("if the dedupe table is missing/unreadable it sends NOTHING (no spam every tick)", async () => {
    DUTY = HOS_SOON();
    const notify = vi.fn();
    const { store } = fakeStore({ insertError: { message: 'relation "reminder_sends" does not exist' } });
    const r = await runRemindersIfDue({ store, notify, now: () => NOW, quietHours: () => false });
    expect(r.sent).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
