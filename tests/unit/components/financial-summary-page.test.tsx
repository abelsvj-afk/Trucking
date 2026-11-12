// @vitest-environment jsdom
// Reliability Unit C (C.7.8 + C4): label truth on the Money summary.
// The revenue label renders from the API's revenueConvention field;
// the pipeline and the completed-missing-delivery-date exception are
// visible, named, and never merged into revenue; the one-time
// restatement notice carries the design's exact C.2 wording; totals
// link to their rows (F-010).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

const SUMMARY = {
  range: { from: "2026-11-01", to: "2026-11-30" },
  timeZone: "America/New_York",
  revenueConvention: "recognized_on_delivery",
  revenue_cents: 200000,
  expenses_cents: 15000,
  fuel_cents: 40000,
  maintenance_cents: 20000,
  net_cents: 125000,
  components: {
    revenue: { total_cents: 200000, row_count: 1, record_ids: ["L1"] },
    expenses: { total_cents: 15000, row_count: 2, record_ids: ["X1", "X2"] },
    fuel: { total_cents: 40000, row_count: 1, record_ids: ["F1"] },
    maintenance: { total_cents: 20000, row_count: 1, record_ids: ["M1"] },
  },
  pipeline: { total_cents: 99900, row_count: 2, record_ids: ["L2", "L5"], loadsWithoutRateCount: 1 },
  exceptions: { completedMissingDeliveryDate: { count: 2, record_ids: ["L3", "L6"] } },
  measures: {
    recognizedRevenue: 200000,
    periodOperatingResult: 125000,
    aggregateContributionMargin: 166000,
  },
};

vi.mock("@/lib/use-financial-summary", () => ({
  useFinancialSummary: () => ({
    state: { status: "loaded", summary: SUMMARY },
    retry: vi.fn(),
  }),
}));

import FinancialSummaryPage, {
  RESTATEMENT_NOTICE_TEXT,
} from "@/app/(app)/money/summary/page";

describe("Financial summary page (Unit C labels)", () => {
  it("renders the revenue label from the convention field - operational revenue, not payments received", () => {
    render(<FinancialSummaryPage />);
    expect(
      screen.getByText("Operational revenue — loads delivered; not payments received"),
    ).toBeTruthy();
    // The old bare labels are gone.
    expect(screen.queryByText("Revenue")).toBeNull();
    expect(screen.queryByText("Net")).toBeNull();
    expect(screen.getByText("Operating result")).toBeTruthy();
  });

  it("shows the restatement notice with the design's exact wording", () => {
    render(<FinancialSummaryPage />);
    expect(RESTATEMENT_NOTICE_TEXT).toBe(
      "Past months' operational revenue was restated to count loads when delivered. This changes how this app reports its own figures; it does not change any cash you received or any tax record.",
    );
    expect(screen.getByText(RESTATEMENT_NOTICE_TEXT)).toBeTruthy();
  });

  it("surfaces the exception with its count and a link, and the pipeline separately with its no-rate note", () => {
    render(<FinancialSummaryPage />);
    expect(
      screen.getByText(/Completed loads missing a delivery date: 2 — excluded from revenue/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Review those loads/ }).getAttribute("href")).toBe(
      "/loads",
    );
    expect(screen.getByText("Pipeline — booked, not yet delivered")).toBeTruthy();
    expect(screen.getByText(/\$999\.00 \(2 loads\)/)).toBeTruthy();
    expect(screen.getByText(/1 load without a rate — counted as \$0 in the pipeline/)).toBeTruthy();
  });

  it("makes each total a link to its rows (F-010)", () => {
    render(<FinancialSummaryPage />);
    const revenueLink = screen.getByRole("link", { name: /\$2,000\.00/ });
    expect(revenueLink.getAttribute("href")).toContain("component=revenue");
    expect(revenueLink.getAttribute("href")).toContain("from=2026-11-01");
    expect(screen.getByRole("link", { name: /\$400\.00/ }).getAttribute("href")).toContain(
      "component=fuel",
    );
  });

  it("names the third measure distinctly rather than reusing the operating result", () => {
    render(<FinancialSummaryPage />);
    expect(
      screen.getByText("Contribution margin — loads delivered in this period"),
    ).toBeTruthy();
    expect(screen.getByText("$1,660.00")).toBeTruthy();
    expect(screen.getByText("$1,250.00")).toBeTruthy();
  });
});
