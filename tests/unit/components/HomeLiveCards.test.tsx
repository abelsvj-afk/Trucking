// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const handlers: { table: string; cb: () => void }[] = [];
let statusCb: ((s: string) => void) | null = null;
vi.mock("@/services/db/client", () => ({
  createClient: () => {
    const channel = {
      on: (_k: string, f: { table: string }, cb: () => void) => (handlers.push({ table: f.table, cb }), channel),
      subscribe: (cb: (s: string) => void) => ((statusCb = cb), channel),
    };
    return {
      auth: { getSession: () => Promise.resolve({ data: { session: { access_token: "t" } } }) },
      realtime: { setAuth: vi.fn() },
      channel: () => channel,
      removeChannel: vi.fn(),
    };
  },
}));

const listBriefings = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiClient: { listResearchBriefings: (...a: unknown[]) => listBriefings(...a), checkWires: vi.fn() } };
});

import LiveDataProvider, { LIVE_THROTTLE_MS } from "@/components/live/LiveDataProvider";
import DayWrapCard from "@/components/DayWrapCard";
import NewsBanner from "@/components/NewsBanner";

const fire = (table: string) => handlers.filter((h) => h.table === table).forEach((h) => h.cb());

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  handlers.length = 0;
  statusCb = null;
  window.matchMedia = window.matchMedia ?? ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never);
});

describe("Home cards follow the live layer (no stale numbers)", () => {
  it("Day Wrap re-derives when a proposal arrives, and clears when there is nothing left", async () => {
    const answers = [
      { data: { items: [{ kind: "proposals", severity: "gap", text: "18 proposed records are waiting for your yes in the Assistant." }] } },
      { data: { items: [{ kind: "proposals", severity: "gap", text: "19 proposed records are waiting for your yes in the Assistant." }] } },
      { data: { items: [] } },
    ];
    let i = 0;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => answers[Math.min(i++, 2)] })) as never;
    await act(async () => {
      render(
        <LiveDataProvider>
          <DayWrapCard />
        </LiveDataProvider>,
      );
    });
    await act(async () => {});
    expect(screen.getByText(/18 proposed records/)).toBeTruthy();
    expect(handlers.some((h) => h.table === "bot_pending_actions")).toBe(true);

    act(() => fire("bot_pending_actions"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    expect(screen.getByText(/19 proposed records/)).toBeTruthy();

    act(() => fire("bot_pending_actions"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    expect(screen.queryByText(/proposed records/)).toBeNull();
  });

  it("the news banner swaps in a new briefing without a tap, and re-reads on its safety interval", async () => {
    const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
    const page = (headline: string) => ({
      data: [
        {
          id: "b", company_id: "c1", run_id: null, topic: "fuel", title: "t", headline, findings: [], what_changed: "",
          counter_move: "", takeaway: "", unverified: [], sources: [], confidence: "high", telegram_notified_at: null,
          read_at: null, dismissed_at: null, created_at: iso(3_600_000), delivery_class: "routine", delivery_held_until: null,
        },
      ],
      unread_count: 1,
      runs: [],
      watchers: [],
      usage: { runs_today: 0, runs_this_month: 0, max_runs_per_day: 2, max_runs_per_month: 10 },
      runner: { last_tick_at: iso(3_600_000), last_source: "endpoint", stale: false },
      signals: [],
      engine_enabled: true,
    });
    listBriefings.mockResolvedValueOnce(page("Diesel up 4 cents")).mockResolvedValue(page("Diesel up 9 cents"));
    await act(async () => {
      render(
        <LiveDataProvider>
          <NewsBanner />
        </LiveDataProvider>,
      );
    });
    await act(async () => {});
    expect(screen.getByText("Diesel up 4 cents")).toBeTruthy();
    expect(handlers.some((h) => h.table === "research_briefings")).toBe(true);

    act(() => fire("research_briefings"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    expect(screen.getByText("Diesel up 9 cents")).toBeTruthy();

    const calls = listBriefings.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(listBriefings.mock.calls.length).toBeGreaterThan(calls);
    void statusCb;
  });
});

describe("banner first-load failure after live events already happened (pitfall hunt)", () => {
  it("shows 'News unavailable' with retry - never sits on 'Checking the wires…' forever", async () => {
    listBriefings.mockRejectedValue(new Error("down"));
    await act(async () => {
      render(
        <LiveDataProvider>
          <NewsBanner />
        </LiveDataProvider>,
      );
    });
    // live events already bumped the version before the first load settled
    act(() => fire("research_briefings"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    await act(async () => {});
    expect(screen.getByText(/News unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Checking the wires/)).toBeNull();
  });
});

describe("Day Wrap failure is visible (audit 2026-11-04)", () => {
  it("a failed check says so with a retry instead of vanishing; a later failure keeps the last good wrap", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, json: async () => null };
      if (n === 2) return { ok: true, json: async () => ({ data: { items: [{ kind: "x", severity: "gap", text: "A POD is missing." }] } }) };
      return { ok: false, json: async () => null };
    }) as never;
    await act(async () => {
      render(
        <LiveDataProvider>
          <DayWrapCard />
        </LiveDataProvider>,
      );
    });
    await act(async () => {});
    expect(screen.getByText(/Day wrap couldn't be checked/)).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });
    expect(screen.getByText("A POD is missing.")).toBeTruthy();
    act(() => fire("loads"));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_THROTTLE_MS);
    });
    // the third answer failed, but the earlier good wrap stays on screen
    expect(screen.getByText("A POD is missing.")).toBeTruthy();
    expect(screen.queryByText(/couldn't be checked/)).toBeNull();
  });
});
