// @vitest-environment jsdom

// Whole-Home smoke: every real Home component rendered together, only the
// network mocked. Catches the failures per-card tests can't - a crash or a
// conflict that only appears when the cards share a page (what the owner
// would see on his phone).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="map" /> }));
vi.mock("@/lib/offline-outbox", () => ({ offlineOutbox: { enqueue: vi.fn(), flush: vi.fn(), count: () => 0 } }));

const H = 3_600_000;
const NOW = Date.parse("2026-11-04T15:00:00Z");

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiClient: {
      telegramPosition: vi.fn(async () => ({ position: null })),
      paySummary: vi.fn(async () => ({
        data: { hasTerms: false, active: null, completed: [], totals: { unpaidCount: 0, unpaidLowCents: 0, unpaidHighCents: 0, shortCount: 0, shortfallCents: 0 }, hos: null, asOf: new Date(NOW).toISOString() },
      })),
      dutyLogWindow: vi.fn(async () => ({
        data: [
          { id: "a", duty_status: "off_duty", started_at: new Date(NOW - 20 * H).toISOString() },
          { id: "b", duty_status: "driving", started_at: new Date(NOW - 2 * H).toISOString() },
        ],
        hos: {
          cycle: "70/8", cycleLimitMinutes: 4200, periodAnchor: "00:00", restartEnabled: true,
          carrierTimeZone: "America/New_York", windowStart: new Date(NOW - 8 * 24 * H).toISOString(),
          windowEnd: new Date(NOW).toISOString(), currentPeriodStart: new Date(NOW - 6 * H).toISOString(),
          onDutyMinutesInCycle: 600, restartApplied: null, restartUnverified: false, warnings: [],
        },
      })),
      list: vi.fn(async (resource: string) => ({
        data:
          resource === "loads"
            ? [{ id: "L1", status: "confirmed", origin: "Melbourne, FL", destination: "Atlanta, GA", pickup_date: "2026-11-05", delivery_date: "2026-11-06", rate_cents: 250000, miles: 480, deleted_at: null, delivery_window_start: null }]
            : [],
        page: { limit: 50, offset: 0, total: 0 },
      })),
      financialSummary: vi.fn(async () => ({
        revenue_cents: 1_000_000, expenses_cents: 200_000, fuel_cents: 100_000, maintenance_cents: 50_000, net_cents: 650_000,
        revenueConvention: "delivery", range: { from: "2026-11-01", to: "2026-11-30" },
      })),
      listResearchBriefings: vi.fn(async () => ({
        data: [], unread_count: 0, runs: [], watchers: [], usage: {}, runner: { last_tick_at: new Date(NOW).toISOString(), stale: false },
        signals: [], engine_enabled: true,
      })),
      checkWires: vi.fn(),
    },
  };
});

import HomePage from "@/app/(app)/page";

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no IntersectionObserver (every real phone does); Reveal uses it.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as never;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { items: [] } }) })) as never;
  window.matchMedia =
    window.matchMedia ??
    ((() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never);
});

describe("Home, whole page", () => {
  it("renders every card together without crashing, in the order the design sets", async () => {
    await act(async () => void render(<HomePage />));
    await act(async () => {});
    await act(async () => {});

    // The HUD (status, rings, buttons) is there and ticking.
    expect(screen.getByLabelText("Duty status and clocks")).toBeTruthy();
    expect(screen.getByLabelText("Time in this status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Driving" })).toBeTruthy();
    // Active load, next step, quick actions.
    expect(screen.getByLabelText("Active load")).toBeTruthy();
    expect(screen.getByLabelText("Your next step")).toBeTruthy();
    // The "This month" business summary is hidden by default (owner
    // order 2026-11-07 - it is the future company view, and only
    // shows when switched on in Settings; see the toggle test below).
    expect(screen.queryByLabelText("This month's financial summary")).toBeNull();
    expect(document.body.textContent).not.toContain("Operating result");
    expect(document.body.textContent).not.toMatch(/profit/i);

    const order = ["Duty status and clocks", "News", "Your next step", "Active load"].map((label) => {
      const el = document.querySelector(`[aria-label="${label}"]`);
      return el ? Array.from(document.querySelectorAll("*")).indexOf(el) : -1;
    });
    expect(order.every((i) => i >= 0)).toBe(true);
    // HUD first, then banner, then next step, then active load.
    expect([...order]).toEqual([...order].sort((x, y) => x - y));
  });

  it("with the business summary switched on in Settings, This month renders as before", async () => {
    window.localStorage.setItem("trucking-home-business-summary", "on");
    await act(async () => void render(<HomePage />));
    await act(async () => {});
    await act(async () => {});

    const monthBlock = screen.getByLabelText("This month's financial summary");
    expect(monthBlock.textContent).toContain("This month");
    expect(monthBlock.textContent).toContain("Expenses");
    expect(monthBlock.textContent).toContain("Operating result");
    expect(document.body.textContent).not.toMatch(/profit/i);
  });

  it("with GPS unavailable (no geolocation in this environment) the status switch still works, in its no-typing quick form", async () => {
    await act(async () => void render(<HomePage />));
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Driving" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      screen.getByRole("button", { name: "Driving" }).click();
    });
    const form = screen.getByRole("dialog", { name: "Change status" }).querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch to Driving now/ })).toBeTruthy();
  });
});

describe("map-first Home order (owner ruling 2026-11-07)", () => {
  it("the map leads, the clocks follow, then the pay preview - all above the news strip", async () => {
    const { readFileSync } = await import("node:fs");
    const hud = readFileSync("src/components/hud/DutyHud.tsx", "utf8");
    expect(hud.indexOf("<HomePositionCard")).toBeGreaterThan(0);
    expect(hud.indexOf("<HomePositionCard")).toBeLessThan(hud.indexOf('aria-label="Duty status and clocks"'));
    const home = readFileSync("src/app/(app)/page.tsx", "utf8");
    expect(home.indexOf("<DutyHud />")).toBeLessThan(home.indexOf("<DriverPayHomeCard />"));
    expect(home.indexOf("<DriverPayHomeCard />")).toBeLessThan(home.indexOf("<NewsBanner />"));
  });
});
