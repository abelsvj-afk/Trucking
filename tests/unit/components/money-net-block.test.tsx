// @vitest-environment jsdom
// Money opens on the net (docs/design/money-hub-net-first.md, owner-approved 2026-11-12).
// The owner's conditions are the tests: the net on top with its arithmetic and payday; a range stays a
// range; no net when an input failed to load; expected vs paid kept apart; and the SAME calculation as
// Home's pay card.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MoneyNetBlock from "@/components/MoneyNetBlock";
import { formatMoneyRange, payWeekNet, recentPayWeeks } from "@/lib/money-hub";
import type { PayProjectionState } from "@/lib/use-pay-projection";
import type { PaySummaryState } from "@/lib/use-pay-summary";
import type { PaySummary, PaydayGroup } from "@/services/api/pay-summary";

afterEach(cleanup);

type Ready = Extract<PayProjectionState, { status: "ready" }>;

const row = { load: { id: "L1" }, projection: {} } as unknown as Ready["period"]["rows"][number];

function projection(over: Partial<Ready> = {}, period: Partial<Ready["period"]> = {}): Ready {
  return {
    status: "ready",
    terms: { rate_cents_per_mile: 55, mile_basis: "all" } as Ready["terms"],
    period: {
      start: "2026-11-08",
      end: "2026-11-14",
      statement: "2026-11-19",
      payday: "2026-11-20",
      weekEndSet: true,
      rows: [row, row],
      lowCents: 103400,
      highCents: 103400,
      unavailableCount: 0,
      excludedCount: 0,
      basisAssumed: false,
      ...period,
    },
    previous: {} as Ready["previous"],
    advances: [{ amount_cents: 40000, advance_date: "2026-11-08" }] as unknown as Ready["advances"],
    advancesAvailable: true,
    deductions: [],
    deductionsAvailable: true,
    ...over,
  };
}

function payday(over: Partial<PaydayGroup>): PaydayGroup {
  return {
    payday: "2026-11-13",
    statement: "2026-11-12",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-07",
    weekStarts: ["2026-11-01"],
    loadCount: 2,
    unpricedCount: 0,
    expectedLowCents: 82500,
    expectedHighCents: 82500,
    advancesCents: 0,
    deductionsCents: 0,
    deductionLines: [],
    netLowCents: 82500,
    netHighCents: 82500,
    receivedCents: 82500,
    stillOwedLowCents: 0,
    stillOwedHighCents: 0,
    shortCount: 0,
    shortfallCents: 0,
    unpaidCount: 0,
    overdue: false,
    loads: [],
    ...over,
  };
}

const summaryOf = (paydays: PaydayGroup[], hasTerms = true): PaySummaryState => ({
  status: "ready",
  summary: { hasTerms, paydays } as unknown as PaySummary,
});
const NO_WEEKS = summaryOf([]);

describe("payWeekNet - the one calculation Home and Money both read", () => {
  it("expected minus the advances and deductions dated inside this pay week", () => {
    const week = payWeekNet(projection());
    expect(week.advancesCents).toBe(40000);
    expect(week.outCents).toBe(40000);
    expect(week.net).toEqual({ lowCents: 63400, highCents: 63400 });
    expect(week.hasWeek).toBe(true);
  });

  it("ignores an advance dated outside the week", () => {
    const week = payWeekNet(projection({ advances: [{ amount_cents: 40000, advance_date: "2026-11-01" }] as unknown as Ready["advances"] }));
    expect(week.outCents).toBe(0);
    expect(week.net).toEqual({ lowCents: 103400, highCents: 103400 });
  });

  it("gives NO net when advances or deductions failed to load - never a net with a missing input", () => {
    expect(payWeekNet(projection({ advancesAvailable: false })).net).toBeNull();
    expect(payWeekNet(projection({ deductionsAvailable: false })).net).toBeNull();
    expect(payWeekNet(projection({ advancesAvailable: false })).outUnavailable).toBe(true);
  });

  it("a net can be negative and is never clamped", () => {
    const week = payWeekNet(projection({}, { lowCents: 20000, highCents: 20000 }));
    expect(week.net).toEqual({ lowCents: -20000, highCents: -20000 });
  });

  it("Home's pay card uses this function and no longer does the arithmetic itself", () => {
    const home = readFileSync("src/components/DriverPayHomeCard.tsx", "utf8");
    expect(home).toContain("payWeekNet(projection)");
    expect(home).not.toMatch(/sumAdvances\(|sumDeductions\(|netRange\(/);
    const block = readFileSync("src/components/MoneyNetBlock.tsx", "utf8");
    expect(block).toContain("payWeekNet(projection)");
    expect(block).not.toMatch(/sumAdvances\(|sumDeductions\(|netRange\(|\/ 100/);
  });
});

describe("formatMoneyRange", () => {
  it("one figure only when the range has collapsed", () => {
    expect(formatMoneyRange(63400, 63400)).toBe("$634.00");
    expect(formatMoneyRange(58000, 63400)).toBe("about $580.00 to $634.00");
    expect(formatMoneyRange(-12000, -12000)).toBe("-$120.00");
  });
});

describe("This pay week block", () => {
  it("shows the net, its arithmetic and the payday", () => {
    render(<MoneyNetBlock projection={projection()} summary={NO_WEEKS} />);
    const block = screen.getByRole("region", { name: "This pay week" });
    expect(block.textContent).toContain("This pay week · Sun, Nov 8 to Sat, Nov 14");
    expect(screen.getByRole("link", { name: "$634.00" }).getAttribute("href")).toBe("/money/pay");
    expect(block.textContent).toContain("Expected net");
    expect(block.textContent).toContain("$1,034.00 expected − $400.00 cash advances");
    expect(block.textContent).toContain("payday Fri, Nov 20");
    expect(block.textContent).toContain("Your settlement is the final number.");
  });

  it("a range stays a range and says why", () => {
    render(<MoneyNetBlock projection={projection({ advances: [] }, { lowCents: 58000, highCents: 63400, basisAssumed: true })} summary={NO_WEEKS} />);
    expect(screen.getByRole("link", { name: "about $580.00 to $634.00" })).toBeTruthy();
    expect(screen.getByText(/This is a range because your miles basis isn't set/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "$580.00" })).toBeNull();
    expect(screen.queryByRole("link", { name: "$634.00" })).toBeNull();
  });

  it("shows NO net when advances could not load, and says so", () => {
    render(<MoneyNetBlock projection={projection({ advancesAvailable: false, advances: [] })} summary={NO_WEEKS} />);
    const block = screen.getByRole("region", { name: "This pay week" });
    expect(block.textContent).toContain("Cash advances couldn't load, so no net is shown.");
    expect(block.textContent).toContain("Expected before anything is taken out");
    expect(block.textContent).not.toContain("Expected net");
  });

  it("a negative net reads -$120.00 and is explained", () => {
    render(<MoneyNetBlock projection={projection({}, { lowCents: 28000, highCents: 28000 })} summary={NO_WEEKS} />);
    expect(screen.getByRole("link", { name: "-$120.00" })).toBeTruthy();
    expect(screen.getByText(/more has been taken out than this week is expected to pay so far/)).toBeTruthy();
  });

  it("no pay terms: the setup prompt, no figure", () => {
    render(<MoneyNetBlock projection={{ status: "no-terms" }} summary={NO_WEEKS} />);
    expect(screen.getByRole("link", { name: "Add pay terms" }).getAttribute("href")).toBe("/more/settings/pay");
    expect(screen.getByRole("region", { name: "This pay week" }).textContent).not.toContain("$");
  });

  it("a failed load shows no figure; an empty week says so", () => {
    render(<MoneyNetBlock projection={{ status: "error" }} summary={NO_WEEKS} />);
    expect(screen.getByRole("region", { name: "This pay week" }).textContent).toContain("couldn't load, so no figure is shown");
    cleanup();
    render(<MoneyNetBlock projection={projection({ advances: [] }, { rows: [], lowCents: 0, highCents: 0 })} summary={NO_WEEKS} />);
    expect(screen.getByText("No booked loads this pay week yet.")).toBeTruthy();
    expect(screen.queryByText(/Expected net/)).toBeNull();
  });
});

describe("recentPayWeeks", () => {
  const groups = [
    payday({ payday: "2026-11-13", periodStart: "2026-11-01", periodEnd: "2026-11-07" }),
    payday({ payday: "2026-11-06", periodStart: "2026-10-25", periodEnd: "2026-10-31", expectedLowCents: 165000, expectedHighCents: 165000, shortCount: 1, shortfallCents: 5000 }),
    payday({ payday: "2026-10-30", periodStart: "2026-10-18", periodEnd: "2026-10-24", receivedCents: 0, unpaidCount: 2, stillOwedHighCents: 82500 }),
    payday({ payday: "2026-10-23", periodStart: "2026-10-11", periodEnd: "2026-10-17", loadCount: 0, expectedLowCents: 0, expectedHighCents: 0 }),
    payday({ payday: "2026-11-20", periodStart: "2026-11-08", periodEnd: "2026-11-14" }),
  ];
  const summary = { hasTerms: true, paydays: groups } as unknown as PaySummary;

  it("newest first, leaves out the week in progress and any week with no finished load", () => {
    const weeks = recentPayWeeks(summary, "2026-11-08");
    expect(weeks.map((w) => w.payday)).toEqual(["2026-11-13", "2026-11-06", "2026-10-30"]);
  });

  it("says what happened to each week's pay - expected is not the same as paid", () => {
    const weeks = recentPayWeeks(summary, "2026-11-08");
    expect(weeks.map((w) => w.status)).toEqual(["paid", "short", "unpaid"]);
  });

  it("bars are scaled to the largest expected amount shown", () => {
    const weeks = recentPayWeeks(summary, "2026-11-08");
    expect(weeks[1]!.share).toBe(1);
    expect(weeks[0]!.share).toBe(0.5);
  });

  it("shows at most six", () => {
    const many = Array.from({ length: 9 }, (_, i) => payday({ payday: `2026-0${i + 1}-15`, periodStart: `2026-0${i + 1}-01`, periodEnd: `2026-0${i + 1}-07` }));
    expect(recentPayWeeks({ hasTerms: true, paydays: many } as unknown as PaySummary, null)).toHaveLength(6);
  });
});

describe("Recent pay weeks block", () => {
  it("lists each week with its expected amount and what happened to it", () => {
    render(
      <MoneyNetBlock
        projection={projection()}
        summary={summaryOf([payday({}), payday({ payday: "2026-11-06", periodStart: "2026-10-25", periodEnd: "2026-10-31", receivedCents: 0, unpaidCount: 2, stillOwedHighCents: 82500 })])}
      />,
    );
    const block = screen.getByRole("region", { name: "Recent pay weeks" });
    expect(block.textContent).toContain("Payday Fri, Nov 13");
    expect(block.textContent).toContain("expected · 2 loads · paid · $825.00 on statements so far");
    expect(block.textContent).toContain("expected · 2 loads · not paid yet");
  });

  it("a failed summary shows no weeks and says why; no terms shows nothing", () => {
    render(<MoneyNetBlock projection={projection()} summary={{ status: "error" }} />);
    expect(screen.getByText("Finished pay weeks couldn't load, so none are shown.")).toBeTruthy();
    cleanup();
    render(<MoneyNetBlock projection={projection()} summary={summaryOf([payday({})], false)} />);
    expect(screen.queryByRole("region", { name: "Recent pay weeks" })).toBeNull();
  });
});

describe("the Money page", () => {
  it("puts the block above the sections and keeps all eight sections", () => {
    const page = readFileSync("src/app/(app)/money/page.tsx", "utf8");
    expect(page.indexOf("<MoneyNetBlock")).toBeGreaterThan(0);
    expect(page.indexOf("<MoneyNetBlock")).toBeLessThan(page.indexOf("{SECTIONS.map("));
    expect(page.match(/\{ href: "\/money\//g)).toHaveLength(8);
  });
});
