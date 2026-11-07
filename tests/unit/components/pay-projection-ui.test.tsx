// @vitest-environment jsdom
// The projection is shown honestly: a range with its reason while the miles
// basis is unset, one number once pinned, nothing quietly guessed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const data: { profiles: unknown[]; loads: unknown[] } = { profiles: [], loads: [] };
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    list: vi.fn(async (r: string) => ({ data: r === "pay-profiles" ? data.profiles : data.loads })),
    // The merged Driver Pay card also reads the server pay summary;
    // an empty one keeps these tests about the projection half.
    paySummary: vi.fn(async () => ({
      data: {
        hasTerms: false,
        active: null,
        completed: [],
        weeks: [],
        totals: {
          unpaidCount: 0,
          unpaidLowCents: 0,
          unpaidHighCents: 0,
          shortCount: 0,
          shortfallCents: 0,
          advancesCents: 0,
          unpaidNetLowCents: 0,
          unpaidNetHighCents: 0,
        },
        hos: null,
        asOf: "",
      },
    })),
  },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/use-live", () => ({ useLiveVersion: () => 0, useLiveConnected: () => false }));
vi.mock("@/lib/time", async (orig) => ({ ...(await orig<typeof import("@/lib/time")>()), viewerTimeZone: () => "America/New_York" }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import DriverPayHomeCard from "@/components/DriverPayHomeCard";
import ProjectedPayPage from "@/app/(app)/money/pay/page";

const profile = (mile_basis: string | null) => ({ id: "p", employer_name: "Acme", rate_cents_per_mile: 55, mile_basis, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01", effective_to: null });
const L = (over: Record<string, unknown> = {}) => ({ id: "L1", origin: "A, MO", destination: "B, FL", status: "confirmed", miles: 1000, loaded_miles: 900, deadhead_miles: 100, pickup_date: null, delivery_date: null, ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T15:00:00Z")); // Thursday, Nov 5 (week 2026-11-02..08)
  data.profiles = [];
  data.loads = [];
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe("Home driver pay (merged section)", () => {
  it("unset basis: a labeled range, and it says so", async () => {
    data.profiles = [profile(null)];
    data.loads = [L({ delivery_date: "2026-11-06" })];
    render(<DriverPayHomeCard />);
    expect(await screen.findByText("$495.00 – $550.00")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/miles basis isn.t set, so this is a range/);
  });

  it("pinned basis: one number, no assumption note", async () => {
    data.profiles = [profile("loaded")];
    data.loads = [L({ delivery_date: "2026-11-06" })];
    render(<DriverPayHomeCard />);
    expect(await screen.findByText("$495.00")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("no pay terms: asks for them instead of showing a number", async () => {
    render(<DriverPayHomeCard />);
    expect(await screen.findByText(/Add pay terms/)).toBeTruthy();
  });

  it("no booked loads this week: says so", async () => {
    data.profiles = [profile("all")];
    data.loads = [L({ delivery_date: "2026-10-01" })];
    render(<DriverPayHomeCard />);
    expect(await screen.findByText("No booked loads this pay week yet.")).toBeTruthy();
  });
});

describe("Money → Projected pay", () => {
  it("breaks down per load, says which miles were counted, and totals the week", async () => {
    data.profiles = [profile(null)];
    data.loads = [L({ delivery_date: "2026-11-06" }), L({ id: "L2", origin: "C, TX", destination: "D, GA", miles: null, loaded_miles: null, deadhead_miles: null, delivery_date: "2026-11-07" })];
    render(<ProjectedPayPage />);
    await screen.findByText(/Counted: 900 loaded to 1,000 total miles/);
    const status = screen.getAllByRole("status").find((n) => /Nov 2 to/.test(n.textContent ?? ""))!;
    expect(status.textContent).toMatch(/\$495.00 – \$550.00 · Mon, Nov 2 to Sun, Nov 8/);
    expect(screen.getByText(/Counted: 900 loaded to 1,000 total miles/)).toBeTruthy();
    expect(screen.getByText(/can.t project yet/)).toBeTruthy();
    expect(screen.getByText(/your settlement is the final number/)).toBeTruthy();
  });
});
