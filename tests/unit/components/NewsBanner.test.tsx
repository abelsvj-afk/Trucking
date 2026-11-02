// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// vitest globals are off in this repo, so RTL's auto-cleanup never
// registers - clean up by hand or renders leak across tests.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listResearchBriefings: vi.fn(),
    checkWires: vi.fn(),
  },
  ApiClientError: class MockApiClientError extends Error {
    code = "TEST";
    status = 500;
  },
}));

import { apiClient } from "@/lib/api-client";
import NewsBanner from "@/components/NewsBanner";
import type { ResearchBriefing, ResearchPageData, ResearchSignal } from "@/types/entities";

const HOUR = 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function briefing(partial: Partial<ResearchBriefing> & { id: string }): ResearchBriefing {
  return {
    company_id: "c1",
    run_id: null,
    topic: "fuel",
    title: `Briefing ${partial.id}`,
    headline: "one line",
    findings: [],
    what_changed: "",
    counter_move: "",
    takeaway: "",
    unverified: [],
    sources: [],
    confidence: "high",
    telegram_notified_at: null,
    read_at: "2026-11-01T00:00:00Z",
    dismissed_at: null,
    created_at: iso(1 * HOUR),
    delivery_class: "routine",
    delivery_held_until: null,
    ...partial,
  };
}

function signal(partial: Partial<ResearchSignal> & { id: string }): ResearchSignal {
  return {
    watcher_key: "eia_diesel",
    kind: "fuel_price_observation",
    topic: "fuel",
    magnitude: 0.9,
    summary: `Signal ${partial.id}`,
    items: [],
    observed_at: iso(1 * HOUR),
    dedupe_key: `k-${partial.id}`,
    ...partial,
  };
}

function page(partial: Partial<ResearchPageData>): ResearchPageData {
  return {
    data: [],
    unread_count: 0,
    runs: [],
    watchers: [],
    usage: { runs_today: 0, runs_this_month: 0, max_runs_per_day: 2, max_runs_per_month: 10 },
    runner: { last_tick_at: iso(1 * HOUR), last_source: "endpoint", stale: false },
    signals: [],
    engine_enabled: true,
    ...partial,
  };
}

function stubMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  vi.mocked(apiClient.listResearchBriefings).mockReset();
  vi.mocked(apiClient.checkWires).mockReset();
  stubMatchMedia(false);
});

async function renderBanner() {
  render(<NewsBanner />);
  // Flush the mount fetch (microtasks only - fake timers don't gate them).
  await act(async () => {});
}

describe("NewsBanner", () => {
  it("renders nothing when deep research is off", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(page({ engine_enabled: false }));
    const { container } = render(<NewsBanner />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
    void container;
  });

  it("renders nothing when the fetch fails (fail closed)", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockRejectedValue(new Error("down"));
    const { container } = render(<NewsBanner />);
    await act(async () => {});
    expect(container.querySelector(".news-banner")).toBeNull();
  });

  it("shows the setup state - and no pull button - when the runner has never ticked", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(page({ runner: null }));
    await renderBanner();
    expect(screen.getByText(/hasn't run yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Check the wires now/ })).toBeNull();
  });

  it("shows the stale warning above the rotation when the runner is stale", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(
      page({
        runner: { last_tick_at: iso(30 * HOUR), last_source: "endpoint", stale: true },
        data: [briefing({ id: "b1", title: "Old but eligible" })],
      }),
    );
    await renderBanner();
    expect(screen.getByText(/hasn't checked in since/)).toBeTruthy();
    expect(screen.getByText("Old but eligible")).toBeTruthy();
  });

  it("shows the quiet state with the last-checked age when nothing qualifies", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(page({}));
    await renderBanner();
    expect(screen.getByText(/The wires are quiet/)).toBeTruthy();
    expect(screen.getByText(/Last checked 1h ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check the wires now/ })).toBeTruthy();
  });

  it("rotates items every 6 seconds and links each into the in-app tab", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(
      page({
        data: [
          briefing({ id: "b1", title: "First story", created_at: iso(2 * HOUR) }),
          briefing({ id: "b2", title: "Second story", created_at: iso(3 * HOUR) }),
        ],
      }),
    );
    await renderBanner();
    expect(screen.getByText("First story")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/more/research?briefing=b1");

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("Second story")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/more/research?briefing=b2");
  });

  it("does not rotate while the tab is hidden", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(
      page({
        data: [
          briefing({ id: "b1", title: "First story", created_at: iso(2 * HOUR) }),
          briefing({ id: "b2", title: "Second story", created_at: iso(3 * HOUR) }),
        ],
      }),
    );
    await renderBanner();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(12000);
    });
    expect(screen.getByText("First story")).toBeTruthy();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("does not auto-rotate under prefers-reduced-motion, but the dots still step", async () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(
      page({
        data: [
          briefing({ id: "b1", title: "First story", created_at: iso(2 * HOUR) }),
          briefing({ id: "b2", title: "Second story", created_at: iso(3 * HOUR) }),
        ],
      }),
    );
    await renderBanner();
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByText("First story")).toBeTruthy();

    act(() => {
      screen.getByRole("button", { name: "Show item 2 of 2" }).click();
    });
    expect(screen.getByText("Second story")).toBeTruthy();
  });

  it("badges signal items as WATCHING and links them by signal id", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(
      page({ signals: [signal({ id: "s1", summary: "Raw pressure rising" })] }),
    );
    await renderBanner();
    expect(screen.getByText("Raw pressure rising")).toBeTruthy();
    expect(screen.getByText("WATCHING")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/more/research?signal=s1");
  });

  it("the pull button reports fresh wires honestly and refetches", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.listResearchBriefings).mockResolvedValue(page({}));
    vi.mocked(apiClient.checkWires).mockResolvedValue({
      state: "fresh",
      available: true,
      new_signals: 3,
      checked_at: new Date().toISOString(),
      next_check_in_minutes: null,
      reason: null,
    });
    await renderBanner();
    await act(async () => {
      screen.getByRole("button", { name: /Check the wires now/ }).click();
    });
    expect(screen.getByText(/3 new items on the wires/)).toBeTruthy();
    expect(apiClient.listResearchBriefings).toHaveBeenCalledTimes(2);
  });
});
