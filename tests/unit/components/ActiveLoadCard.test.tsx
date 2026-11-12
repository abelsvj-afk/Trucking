// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { pickActiveLoad, dateOnlyToNoon } from "@/lib/active-load";
import type { Load } from "@/types/entities";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const listHolder: { loads: Partial<Load>[]; status: "loaded" | "loading" } = { loads: [], status: "loaded" };
vi.mock("@/lib/use-api-list", () => ({
  useApiList: () =>
    listHolder.status === "loaded"
      ? { state: { status: "loaded", result: { data: listHolder.loads, page: { limit: 50, offset: 0, total: 0 } } }, retry: vi.fn() }
      : { state: { status: "loading" }, retry: vi.fn() },
}));

import ActiveLoadCard from "@/components/ActiveLoadCard";

const load = (id: string, o: Partial<Load> = {}): Load =>
  ({
    id,
    origin: "Melbourne, FL",
    destination: "Atlanta, GA",
    status: "confirmed",
    pickup_date: "2026-11-05",
    delivery_date: "2026-11-06",
    rate_cents: 250000,
    miles: 480,
    deleted_at: null,
    delivery_window_start: null,
    ...o,
  }) as Load;

describe("pickActiveLoad", () => {
  const today = "2026-11-04";
  it("only confirmed loads count - not draft, completed or cancelled", () => {
    expect(pickActiveLoad([load("a", { status: "draft" }), load("b", { status: "completed" }), load("c", { status: "cancelled" })], today)).toBeNull();
  });
  it("picks the soonest pickup among loads not yet past delivery", () => {
    const r = pickActiveLoad([load("late", { pickup_date: "2026-11-09", delivery_date: "2026-11-10" }), load("soon"), load("old", { pickup_date: "2026-10-01", delivery_date: "2026-10-03" })], today);
    expect(r).toMatchObject({ load: { id: "soon" }, overdue: false });
  });
  it("a load with no delivery date still counts as ahead", () => {
    expect(pickActiveLoad([load("x", { delivery_date: null })], today)?.overdue).toBe(false);
  });
  it("if every confirmed load is past delivery, shows the most recent and flags it overdue - never assumes it delivered", () => {
    const r = pickActiveLoad([load("a", { delivery_date: "2026-10-01" }), load("b", { delivery_date: "2026-10-20" })], today);
    expect(r).toMatchObject({ load: { id: "b" }, overdue: true });
  });
  it("ignores soft-deleted loads", () => {
    expect(pickActiveLoad([load("a", { deleted_at: "2026-11-01T00:00:00Z" })], today)).toBeNull();
  });
});

describe("dateOnlyToNoon", () => {
  it("keeps a date-only value on its own calendar day in any time zone", () => {
    const d = dateOnlyToNoon("2026-11-05");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(5);
  });
});

describe("ActiveLoadCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
    listHolder.status = "loaded";
  });

  it("shows route, dates, miles - and words the rate as operational revenue, never cash received", () => {
    listHolder.loads = [load("a")];
    render(<ActiveLoadCard />);
    expect(screen.getByText("Melbourne, FL")).toBeTruthy();
    expect(screen.getByText("Atlanta, GA")).toBeTruthy();
    expect(document.body.textContent).toContain("Pickup Nov 5, 2026");
    expect(document.body.textContent).toContain("Delivery Nov 6, 2026");
    expect(document.body.textContent).toContain("480 mi");
    expect(document.body.textContent).toContain("Rate $2,500.00 — operational revenue, counted when delivered (not cash received)");
    expect(document.body.textContent).not.toMatch(/profit/i);
    expect(screen.getByRole("link", { name: "Open load" }).getAttribute("href")).toBe("/loads/a");
  });

  it("names the load Trip-first when it has a trip number (owner format 2026-11-10)", () => {
    listHolder.loads = [load("a", { trip_number: "1874", origin: "Panama City", destination: "Seminole" })];
    render(<ActiveLoadCard />);
    expect(document.body.textContent).toContain("Trip 1874 · Panama City → Seminole");
  });

  it("is absent with no confirmed load, and while loading", () => {
    listHolder.loads = [];
    const { container } = render(<ActiveLoadCard />);
    expect(container.firstChild).toBeNull();
    cleanup();
    listHolder.status = "loading";
    expect(render(<ActiveLoadCard />).container.firstChild).toBeNull();
  });

  it("an overdue load says so and asks - it doesn't claim delivery", () => {
    listHolder.loads = [load("a", { delivery_date: "2026-10-30" })];
    render(<ActiveLoadCard />);
    expect(screen.getByRole("status").textContent).toContain("delivery date has passed");
  });
});
