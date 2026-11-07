// @vitest-environment jsdom
// Home shows driver pay ONCE (owner order 2026-11-07): one "Driver
// pay" section carrying the active load, this pay week (advances
// netted, payday named), and the finished-but-unpaid total - not the
// old pair of "Projected pay" + "Pay and hours" cards explaining the
// same money twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const summary = {
  hasTerms: true,
  active: {
    loadId: "L9",
    origin: "A, MO",
    destination: "B, FL",
    tripNumber: null,
    status: "in_transit",
    deliveryDate: null,
    overdue: false,
    hosCost: null,
    line: {
      loadId: "L9",
      expected: { lowCents: 55000, highCents: 55000 },
      termsUsed: { employer_name: "Acme", rate_cents_per_mile: 55, mile_basis: "all", inForce: true },
      receivedCents: null,
      status: "unpaid",
      shortfallCents: 0,
    },
  },
  completed: [],
  weeks: [],
  totals: {
    unpaidCount: 2,
    unpaidLowCents: 100000,
    unpaidHighCents: 100000,
    shortCount: 0,
    shortfallCents: 0,
    advancesCents: 0,
    unpaidNetLowCents: 100000,
    unpaidNetHighCents: 100000,
  },
  hos: null,
  asOf: "",
};

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn(async (r: string) => ({
      data:
        r === "pay-profiles"
          ? [
              {
                id: "p",
                employer_name: "Acme",
                rate_cents_per_mile: 55,
                mile_basis: "all",
                worker_type: null,
                fuel_paid_by: null,
                effective_from: "2026-10-01",
                effective_to: null,
              },
            ]
          : r === "loads"
            ? [
                {
                  id: "L1",
                  origin: "A, MO",
                  destination: "B, FL",
                  status: "confirmed",
                  miles: 1000,
                  loaded_miles: 900,
                  deadhead_miles: 100,
                  pickup_date: null,
                  delivery_date: "2026-11-06",
                },
              ]
            : [],
    })),
    paySummary: vi.fn(async () => ({ data: summary })),
  },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/use-live", () => ({ useLiveVersion: () => 0, useLiveConnected: () => false }));
vi.mock("@/lib/time", async (orig) => ({
  ...(await orig<typeof import("@/lib/time")>()),
  viewerTimeZone: () => "America/New_York",
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import DriverPayHomeCard from "@/components/DriverPayHomeCard";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T15:00:00Z")); // Thursday, Nov 5 (week 2026-11-02..08)
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Home driver pay: one section, one story", () => {
  it("renders exactly one pay section carrying all three figures", async () => {
    render(<DriverPayHomeCard />);

    // The section and its single heading.
    expect(await screen.findByLabelText("Driver pay")).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Driver pay" })).toHaveLength(1);
    // The old duplicate sections are gone.
    expect(screen.queryByLabelText("Projected pay")).toBeNull();
    expect(screen.queryByLabelText("Pay and hours")).toBeNull();

    // Active load, this pay week, finished-but-unpaid - each once.
    expect(screen.getByText("Active load")).toBeTruthy();
    expect(screen.getByText(/This pay week:/)).toBeTruthy();
    expect(screen.getByText(/2 finished, unpaid/)).toBeTruthy();
    expect(screen.getAllByText("$550.00").length).toBeGreaterThanOrEqual(1);
  });
});
