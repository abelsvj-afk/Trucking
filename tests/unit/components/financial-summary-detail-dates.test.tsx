// @vitest-environment jsdom
// Defect 2026-11-12: Financial summary detail showed delivery, expense
// and service dates ONE DAY EARLY. Those columns are calendar days
// ("2026-11-13"); formatDate() read them as UTC midnight and rendered
// the evening before in the viewer's zone. They are now rendered as
// written. Fuel's purchased_at is a real instant and keeps formatDate.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { formatCalendarDay, formatDate } from "@/lib/time";

afterEach(cleanup);

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));

const detailFor: Record<string, unknown> = {
  revenue: { component: "revenue", rows: [{ id: "L1", origin: "Dallas, TX", destination: "Atlanta, GA", delivery_date: "2026-11-13", rate_cents: 200000 }] },
  expenses: { component: "expenses", rows: [{ id: "X1", description: "Scale ticket", category: "other", expense_date: "2026-11-01", amount_cents: 2500 }] },
  maintenance: { component: "maintenance", rows: [{ id: "M1", description: "Oil change", service_date: "2026-12-31", cost_cents: 30000 }] },
};

vi.mock("@/lib/api-client", () => ({
  ApiClientError: class extends Error {},
  apiClient: {
    financialSummaryDetail: (component: string) =>
      Promise.resolve({
        range: { from: "2026-11-01", to: "2026-12-31" },
        timeZone: "America/New_York",
        total_cents: 0,
        row_count: 1,
        ...(detailFor[component] as object),
      }),
  },
}));

vi.mock("@/lib/time", async (original) => {
  const actual = await original<typeof import("@/lib/time")>();
  // The owner's zone, whatever zone the test machine runs in.
  return { ...actual, viewerTimeZone: () => "America/New_York", formatDate: (v: string | Date) => actual.formatDate(v, "America/New_York") };
});

import SummaryDetailPage from "@/app/(app)/money/summary/detail/page";

describe("the defect, reproduced", () => {
  it("formatDate on a date-only string is one day early in America/New_York (why it must not be used for calendar days)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/time")>("@/lib/time");
    expect(actual.formatDate("2026-11-13", "America/New_York")).toBe("Nov 12, 2026");
  });
});

describe("formatCalendarDay", () => {
  it("renders the day as written, with no zone shift", () => {
    expect(formatCalendarDay("2026-11-13")).toBe("Nov 13, 2026");
    expect(formatCalendarDay("2026-11-01")).toBe("Nov 1, 2026");
    expect(formatCalendarDay("2026-12-31")).toBe("Dec 31, 2026");
    expect(formatCalendarDay("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatCalendarDay("2024-02-29")).toBe("Feb 29, 2024");
  });

  it("returns anything that is not a real YYYY-MM-DD day unchanged, never a wrong date", () => {
    expect(formatCalendarDay("2026-02-30")).toBe("2026-02-30");
    expect(formatCalendarDay("2026-11-13T05:00:00Z")).toBe("2026-11-13T05:00:00Z");
    expect(formatCalendarDay("")).toBe("");
  });

  it("is still used only for days: an instant keeps formatDate", () => {
    expect(formatDate("2026-11-13T03:30:00Z")).toBe("Nov 12, 2026"); // 10:30 PM Eastern on the 12th - correct for an instant
  });
});

describe("Financial summary detail rows", () => {
  it("revenue: the delivery date is the day that was recorded", async () => {
    params = new URLSearchParams({ component: "revenue", from: "2026-11-01", to: "2026-11-30" });
    render(<SummaryDetailPage />);
    expect(await screen.findByText("Delivered Nov 13, 2026")).toBeTruthy();
    expect(screen.queryByText(/Nov 12, 2026/)).toBeNull();
  });

  it("expenses: the first of the month stays in its month", async () => {
    params = new URLSearchParams({ component: "expenses", from: "2026-11-01", to: "2026-11-30" });
    render(<SummaryDetailPage />);
    expect(await screen.findByText("other · Nov 1, 2026")).toBeTruthy();
    expect(screen.queryByText(/Oct 31/)).toBeNull();
  });

  it("maintenance: Dec 31 does not become Dec 30", async () => {
    params = new URLSearchParams({ component: "maintenance", from: "2026-12-01", to: "2026-12-31" });
    render(<SummaryDetailPage />);
    expect(await screen.findByText("Dec 31, 2026")).toBeTruthy();
  });
});
