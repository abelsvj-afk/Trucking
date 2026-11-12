// Fix round (pitfall hunt CD-1/CD-2) - the night shift's due-check:
// - runConsolidationIfDue is exported and self-contained: the
//   research endpoint's hourly piggyback (documented in that lane's
//   docs/runtime.md) calls it with zero arguments post-merge so
//   consolidation no longer depends on the app being awake (CD-1).
// - A due run takes the advisory lock for the whole pass; when
//   another machine holds it, the pass is skipped cleanly (CD-2).

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore } from "@/services/bot/store";
import {
  CONSOLIDATION_LOCK_KEY,
  runConsolidationIfDue,
} from "@/services/bot/consolidation-scheduler";
import type { ConsolidationResult } from "@/services/bot/consolidation";

const COMPANY = "company-1";
const HOUR = 60 * 60 * 1000;

function runsClient(ranAt: string | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: ranAt ? [{ ran_at: ranAt }] : [], error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function fakeStore(ranAt: string | null): BotBrainStore {
  return {
    client: runsClient(ranAt),
    companyId: COMPANY,
  } as unknown as BotBrainStore;
}

const RAN: ConsolidationResult = {
  ran: true,
  embedded: 0,
  summariesRefreshed: 1,
  proposalsStaged: 0,
  updatesStaged: 0,
  duplicatesDropped: 0,
  lessonsStaged: 0,
  lessonsDropped: 0,
  report: "Night shift: refreshed 1 weekly summary.",
};

function lockHandle() {
  return { release: vi.fn(async () => {}) };
}

describe("runConsolidationIfDue (CD-1/CD-2)", () => {
  it("exports the research tick's lock key as its own (727002, not 727001)", () => {
    expect(CONSOLIDATION_LOCK_KEY).toBe(727002);
  });

  it("not due yet (ran an hour ago): no lock attempt, no pass", async () => {
    const acquireLock = vi.fn(async () => lockHandle());
    const runPass = vi.fn(async () => RAN);
    await runConsolidationIfDue({
      store: fakeStore(new Date(Date.now() - HOUR).toISOString()),
      acquireLock,
      runPass,
    });
    expect(acquireLock).not.toHaveBeenCalled();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("never ran = due: the pass runs under the lock and the report is sent", async () => {
    const handle = lockHandle();
    const notify = vi.fn(async () => {});
    const runPass = vi.fn(async () => RAN);
    await runConsolidationIfDue({
      store: fakeStore(null),
      acquireLock: async () => handle,
      runPass,
      notify,
    });
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(RAN.report);
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("CD-2: another machine holds the lock -> the pass is skipped cleanly", async () => {
    const runPass = vi.fn(async () => RAN);
    const notify = vi.fn(async () => {});
    await runConsolidationIfDue({
      store: fakeStore(new Date(Date.now() - 48 * HOUR).toISOString()),
      acquireLock: async () => null,
      runPass,
      notify,
    });
    expect(runPass).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a silent pass (nothing to report) sends no morning line but still releases the lock", async () => {
    const handle = lockHandle();
    const notify = vi.fn(async () => {});
    await runConsolidationIfDue({
      store: fakeStore(null),
      acquireLock: async () => handle,
      runPass: async () => ({ ...RAN, report: null }),
      notify,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("a failing pass still releases the lock and never throws (its own error logging)", async () => {
    const handle = lockHandle();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runConsolidationIfDue({
          store: fakeStore(null),
          acquireLock: async () => handle,
          runPass: async () => {
            throw new Error("provider down");
          },
        }),
      ).resolves.toBeUndefined();
      expect(handle.release).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("scheduler tick failed")),
      );
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("no store configured (Telegram env absent): a quiet no-op", async () => {
    const runPass = vi.fn(async () => RAN);
    await runConsolidationIfDue({ store: null, runPass });
    expect(runPass).not.toHaveBeenCalled();
  });
});
