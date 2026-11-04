// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => cleanup());

vi.mock("@/lib/use-api-list", () => ({
  useApiList: () => ({ state: { status: "loaded", result: { data: [], page: { limit: 50, offset: 0, total: 0 } } }, retry: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({ apiClient: {}, ApiClientError: class extends Error {} }));

const windowHolder: { hos: Record<string, unknown> } = { hos: {} };
vi.mock("@/lib/use-hos-window", () => ({
  useHosWindow: () => ({
    state: { status: "loaded", data: [{ id: "1", duty_status: "sleeper", started_at: "2026-11-03T17:34:00Z" }], hos: windowHolder.hos },
    retry: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import HoursPage from "@/app/(app)/fleet/hos/page";

function hos(overrides: Record<string, unknown> = {}) {
  return {
    cycle: "70/8",
    cycleLimitMinutes: 4200,
    periodAnchor: "00:00",
    restartEnabled: true,
    carrierTimeZone: "America/New_York",
    windowStart: "2026-10-27T04:00:00Z",
    windowEnd: "2026-11-04T15:00:00Z",
    currentPeriodStart: "2026-11-04T05:00:00Z",
    onDutyMinutesInCycle: 0,
    restartApplied: null,
    restartUnverified: false,
    warnings: [],
    ...overrides,
  };
}

describe("Hours page (visual audit F2, F3)", () => {
  it("F2: with the provisional defaults it does NOT call the settings the carrier's specified rules", () => {
    windowHolder.hos = hos();
    render(<HoursPage />);
    expect(screen.getByText(/provisional default settings/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("your carrier's specified period start");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/more/settings");
  });

  it("F2: once the carrier's own rules are set it states them as the carrier's", () => {
    windowHolder.hos = hos({ periodAnchor: "06:00" });
    render(<HoursPage />);
    expect(screen.queryByText(/provisional default settings/)).toBeNull();
    expect(document.body.textContent).toContain("your carrier's specified period start");
  });

  it("F3: Log duty status is the page's primary action button, and Deleted is the quiet toggle", () => {
    windowHolder.hos = hos();
    render(<HoursPage />);
    const primary = screen.getByRole("link", { name: "Log duty status" });
    expect(primary.className).toContain("page-action");
    expect(primary.getAttribute("href")).toBe("/fleet/hos/new");
    expect(screen.getByRole("button", { name: "Deleted" }).closest("p")!.className).toContain("deleted-toggle");
  });
});
