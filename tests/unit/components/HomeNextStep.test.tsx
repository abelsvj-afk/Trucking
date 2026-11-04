// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => cleanup());

const listCalls: string[] = [];
vi.mock("@/lib/use-api-list", () => ({
  useApiList: (resource: string, params?: Record<string, string>) => {
    listCalls.push(`${resource}?${JSON.stringify(params ?? {})}`);
    return { state: { status: "loaded", result: { data: [], page: { limit: 200, offset: 0, total: 0 } } }, retry: vi.fn() };
  },
}));
vi.mock("@/lib/use-financial-summary", () => ({ useFinancialSummary: () => ({ state: { status: "loading" }, retry: vi.fn() }) }));

const windowHolder: { state: unknown } = { state: { status: "loading" } };
vi.mock("@/lib/use-hos-window", () => ({ useHosWindow: () => ({ state: windowHolder.state, retry: vi.fn(), refresh: vi.fn() }) }));

vi.mock("@/components/hud/DutyHud", () => ({ default: () => null }));
vi.mock("@/components/NewsBanner", () => ({ default: () => null }));
vi.mock("@/components/ActiveLoadCard", () => ({ default: () => null }));
vi.mock("@/components/ActivePlanCard", () => ({ default: () => null }));
vi.mock("@/components/DayWrapCard", () => ({ default: () => null }));
vi.mock("@/components/AskAssistant", () => ({ default: () => null }));
vi.mock("@/components/Reveal", () => ({
  default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    <section aria-label={rest["aria-label"] as string}>{children}</section>
  ),
}));
vi.mock("@/components/NumberTicker", () => ({ default: () => null }));

import HomePage from "@/app/(app)/page";

const hosBase = {
  cycle: "70/8", cycleLimitMinutes: 4200, periodAnchor: "00:00", restartEnabled: true, carrierTimeZone: "America/New_York",
  windowStart: "2026-10-27T04:00:00Z", windowEnd: "2026-11-04T15:00:00Z", currentPeriodStart: "2026-11-04T05:00:00Z",
  onDutyMinutesInCycle: 4300, restartApplied: null, restartUnverified: false, warnings: [] as string[],
};

describe("Home next step (audit UX-02)", () => {
  it("reads the full carrier window - no 200-row duty-logs request - and surfaces the carrier-cycle warning", () => {
    listCalls.length = 0;
    windowHolder.state = {
      status: "loaded",
      data: [{ id: "1", duty_status: "off_duty", started_at: "2026-11-04T09:00:00Z" }],
      hos: { ...hosBase, warnings: ["70/8 on-duty limit reached (71h 40m of 70h 00m). A 34-hour restart is required."] },
    };
    render(<HomePage />);
    expect(listCalls.some((c) => c.startsWith("duty-logs"))).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("70/8 on-duty limit reached");
  });

  it("never states the superseded rolling 8-day limit", () => {
    windowHolder.state = {
      status: "loaded",
      data: [{ id: "1", duty_status: "driving", started_at: "2026-11-04T09:00:00Z" }],
      hos: hosBase,
    };
    render(<HomePage />);
    expect(document.body.textContent).not.toContain("8-day");
  });

  it("a failed window load says so with a way to Hours - it does not guess", () => {
    windowHolder.state = { status: "error", message: "down" };
    render(<HomePage />);
    expect(screen.getByText(/Couldn't load your hours just now/)).toBeTruthy();
  });
});
