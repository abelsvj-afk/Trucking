// @vitest-environment jsdom
// Money -> Paychecks organised by payday, and Abel's paychecks_by_payday answer: both read the SAME builder output.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { buildPaySummary } from "@/services/api/pay-summary";
import { formatPayday } from "@/lib/payday-text";
import type { Load } from "@/types/entities";

const terms = [{ employer_name: "Acme", rate_cents_per_mile: 60, mile_basis: "all" as const, effective_from: "2026-01-01", effective_to: null, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 }];
const load = (o: Partial<Load>): Load => ({ id: "l1", origin: "Joplin, MO", destination: "Tampa, FL", status: "completed", miles: 1000, loaded_miles: null, deadhead_miles: null, pickup_date: "2026-10-30", delivery_date: "2026-10-31", deleted_at: null, ...o }) as Load;
const summary = buildPaySummary({
  loads: [load({ id: "a" }), load({ id: "b", origin: "Dallas, TX", delivery_date: "2026-10-27", pickup_date: "2026-10-26" })],
  terms,
  receivedByLoad: new Map([["a", 60000]]),
  advances: [{ amount_cents: 25000, advance_date: "2026-10-28" }],
  hos: null,
  now: new Date("2026-11-07T15:00:00Z"),
});
const mockState = vi.hoisted(() => ({ summary: null as unknown }));
mockState.summary = summary;

vi.mock("@/lib/use-pay-summary", () => ({ usePaySummary: () => ({ status: "ready", summary: mockState.summary }) }));
vi.mock("@/lib/use-page-title", () => ({ usePageTitle: () => {} }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import PaychecksPage from "@/app/(app)/money/paychecks/page";

afterEach(cleanup);

describe("Paychecks page by payday", () => {
  it("shows the five labelled figures per payday, with the loads underneath", () => {
    render(<PaychecksPage />);
    const article = screen.getByRole("article", { name: /Payday Fri, Nov 6/ });
    for (const label of ["Expected total", "Advances taken", "Net expected", "Received so far", "Still owed"]) {
      expect(within(article).getByText(label)).toBeTruthy();
    }
    expect(within(article).getByText(/− \$250\.00/)).toBeTruthy(); // advances taken
    expect(within(article).getByText(/past due/i)).toBeTruthy(); // payday passed, money still owed
    const loads = within(article).getByRole("list", { name: /Loads in/ });
    expect(within(loads).getAllByRole("listitem")).toHaveLength(2);
    expect(within(loads).getByText(/Dallas, TX/)).toBeTruthy();
    // Worker type UNSET on these terms: no tax set-aside line.
    expect(within(article).queryByText("Set aside for taxes")).toBeNull();
  });

  it("for a 1099 contractor each paycheck shows the set-aside on its expected gross, labelled as the default", () => {
    mockState.summary = buildPaySummary({
      loads: [load({ id: "a" }), load({ id: "b", origin: "Dallas, TX", delivery_date: "2026-10-27", pickup_date: "2026-10-26" })],
      terms: [{ ...terms[0]!, worker_type: "1099" as const }],
      receivedByLoad: new Map([[ "a", 60000 ]]),
      advances: [{ amount_cents: 25000, advance_date: "2026-10-28" }],
      hos: null,
      now: new Date("2026-11-07T15:00:00Z"),
    });
    render(<PaychecksPage />);
    const article = screen.getByRole("article", { name: /Payday Fri, Nov 6/ });
    expect(within(article).getByText("Set aside for taxes")).toBeTruthy();
    // $1,200.00 expected gross at the default 25% is $300.00.
    expect(within(article).getByText(/Set aside for taxes: \$300\.00 \(25% of \$1,200\.00 gross\)/)).toBeTruthy();
    expect(within(article).getByText(/Default 25% — change it in Settings → Pay/)).toBeTruthy();
    mockState.summary = summary;
  });
});

describe("Abel and the page agree", () => {
  it("Abel's wording is generated from the same payday fields the page renders", () => {
    const g = summary.paydays[0]!;
    const text = formatPayday(g);
    expect(text).toContain("Expected total: $1,200.00");
    expect(text).toContain("Advances taken: -$250.00");
    expect(text).toContain("Net expected: $950.00");
    expect(text).toContain("Received so far (statements): $600.00");
    expect(text).toContain("Still owed: $350.00");
    expect(text).toContain("PAST DUE");
  });
});
