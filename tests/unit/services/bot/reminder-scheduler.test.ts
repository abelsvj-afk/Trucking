import { describe, expect, it, vi } from "vitest";
import type { BotBrainStore } from "@/services/bot/store";

const NOW = new Date("2026-11-05T18:00:00Z");
const H = 3_600_000;
const rows = (list: Array<[string, number]>) => list.map(([duty_status, ago]) => ({ duty_status, started_at: new Date(NOW.getTime() - ago * H).toISOString() }));

let DUTY: ReturnType<typeof rows> = [];
vi.mock("@/services/api/hos-window", () => ({
  loadHosWindow: async () => ({ rows: DUTY }),
  toWindowSummary: () => null,
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

  it("a stale log (15 h of 'driving') holds the hours warnings and sends ONLY the stale-log question - even in quiet hours (owner 2026-11-16)", async () => {
    DUTY = rows([["off_duty", 40], ["driving", 15]]);
    const notify = vi.fn().mockResolvedValue(true);
    const quiet = await runRemindersIfDue({ store: fakeStore({}).store, notify, now: () => NOW, quietHours: () => true });
    expect(quiet.held).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain("still says Driving");
    expect(text).toContain("paused the hours warnings");
    expect(text).not.toMatch(/14-hour window|11 hours of driving|left in your/);
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

describe("the daily check-in rides the same tick (docs/design/abel-do-what-i-ask.md section 6)", () => {
  // 9:05 AM Eastern: the morning check-in is due, and so is a 30-minute driving warning.
  const MORNING = new Date("2026-11-16T14:05:00Z");
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order", "limit", "in", "gte", "lte", "not"]) q[m] = () => q;
    q.then = (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve(ok({ data: [], error: null }));
    q.maybeSingle = async () => ({ data: null, error: null });
    return q;
  };
  function storeWith(checkinRefused: boolean) {
    const kinds: string[] = [];
    const client = {
      from: (table: string) =>
        table === "reminder_sends"
          ? {
              insert: async (r: { kind: string }) => {
                if (checkinRefused && r.kind === "checkin") return { error: { message: 'violates check constraint "reminder_sends_kind_check"' } };
                kinds.push(r.kind);
                return { error: null };
              },
              delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
            }
          : chain(),
    };
    const store = { client, companyId: "co", isLoggingRemindersEnabled: async () => true, loadOpenPendingRows: async () => [] } as unknown as BotBrainStore;
    return { store, kinds };
  }
  const drivingSince = (h: number) => [{ duty_status: "off_duty", started_at: new Date(MORNING.getTime() - 20 * H).toISOString() }, { duty_status: "driving", started_at: new Date(MORNING.getTime() - h * H).toISOString() }];

  it("the morning check-in goes out with the hours warning, in one message", async () => {
    DUTY = drivingSince(10.5);
    const notify = vi.fn().mockResolvedValue(true);
    const { store, kinds } = storeWith(false);
    await runRemindersIfDue({ store, notify, now: () => MORNING, quietHours: () => false });
    expect(kinds).toContain("checkin");
    expect(notify.mock.calls[0]![0]).toContain("Good morning");
  });

  it("a refused check-in (migration 00098 not applied) never blocks the hours warning", async () => {
    DUTY = drivingSince(10.5);
    const notify = vi.fn().mockResolvedValue(true);
    const { store, kinds } = storeWith(true);
    const r = await runRemindersIfDue({ store, notify, now: () => MORNING, quietHours: () => false });
    expect(r.sent).toBeGreaterThan(0);
    expect(kinds).toContain("hos");
    expect(notify.mock.calls[0]![0]).toContain("not an ELD");
    expect(notify.mock.calls[0]![0]).not.toContain("Good morning");
  });
});
