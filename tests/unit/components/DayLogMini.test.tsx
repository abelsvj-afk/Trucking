// @vitest-environment jsdom
//
// Home mini paper log (owner order 2026-11-17): today's duty grid in a
// small view under the hours, drawn by the SAME DayGraph renderer and
// the SAME buildDaySegments mapping as the full Day log page. Tapping
// it opens /fleet/hos. Empty, loading and error states say so honestly.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import DayLogMini from "@/components/hud/DayLogMini";
import type { HosWindowState } from "@/lib/use-hos-window";

const ROOT = join(__dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

afterEach(() => {
  cleanup();
});

const windowLoaded = (data: HosWindowState extends { data: infer D } ? D : never): HosWindowState => ({
  status: "loaded",
  data,
  hos: { carrierTimeZone: "America/New_York" } as HosWindowState extends { hos: infer H } ? H : never,
  stale: false,
  staleSinceMs: null,
});

// Noon ET, 2026-11-10. Off duty from midnight, driving from 8:05 AM.
const NOW = Date.parse("2026-11-10T17:00:00Z");
const rows = [
  {
    id: "e1",
    driver_id: null,
    load_id: null,
    duty_status: "off_duty" as const,
    started_at: "2026-11-10T05:00:00Z",
    location: null,
    odometer: null,
    notes: null,
    company_id: "c1",
    created_at: "2026-11-10T05:00:00Z",
    updated_at: "2026-11-10T05:00:00Z",
    deleted_at: null,
  },
  {
    id: "e2",
    driver_id: null,
    load_id: null,
    duty_status: "driving" as const,
    started_at: "2026-11-10T13:05:00Z",
    location: null,
    odometer: null,
    notes: null,
    company_id: "c1",
    created_at: "2026-11-10T13:05:00Z",
    updated_at: "2026-11-10T13:05:00Z",
    deleted_at: null,
  },
];

describe("DayLogMini", () => {
  it("draws today's lines on the compact grid and taps through to the full Day log", () => {
    const { container } = render(<DayLogMini window={windowLoaded(rows as never)} nowMs={NOW} />);
    const svg = container.querySelector("svg[role='img']")!;
    expect(svg).toBeTruthy();
    // Compact geometry: same 720 viewBox width, tighter rows (TOP 20 + 28*4 + 4 = 136 high).
    expect(svg.getAttribute("viewBox")).toBe("0 0 720 136");
    expect(svg.getAttribute("aria-label")).toContain("Duty graph:");
    expect(svg.getAttribute("aria-label")).toContain("08:05 to 12:00 D");
    // The driving line sits on the D row, from 8:05 (485 min) to now (720 min).
    // Compact x: 44 + (min / 1440) * 670.
    const lines = [...container.querySelectorAll(".dg-line line")];
    // Horizontal segment lines only (the verticals join one row to the next).
    const horizontals = lines.filter((l) => l.getAttribute("y1") === l.getAttribute("y2"));
    const driving = horizontals.find((l) => Math.abs(Number(l.getAttribute("x1")) - (44 + (485 / 1440) * 670)) < 0.01);
    expect(driving).toBeTruthy();
    expect(Number(driving!.getAttribute("x2"))).toBeCloseTo(44 + (720 / 1440) * 670, 5);
    // The whole widget is one tap to the full Day log.
    const link = screen.getByRole("link", { name: /open the full Day log/ });
    expect(link.getAttribute("href")).toBe("/fleet/hos");
    // One-line caption names the running status and when it started.
    expect(screen.getByText(/Driving since 08:05/)).toBeTruthy();
    expect(screen.getByText(/Times on your carrier's clock \(America\/New_York\)/)).toBeTruthy();
  });

  it("an empty day draws no lines and offers the Day log door", () => {
    const { container } = render(<DayLogMini window={windowLoaded([] as never)} nowMs={NOW} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/Nothing logged yet today/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open Day log to add your first entry/ });
    expect(link.getAttribute("href")).toBe("/fleet/hos");
  });

  it("loading says it is checking, never a guessed grid", () => {
    const { container } = render(<DayLogMini window={{ status: "loading" }} nowMs={NOW} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/Checking today's log/)).toBeTruthy();
  });

  it("an error says so and keeps the Day log door", () => {
    const { container } = render(
      <DayLogMini window={{ status: "error", message: "boom" }} nowMs={NOW} />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/Couldn't load today's log just now/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Day log/ }).getAttribute("href")).toBe("/fleet/hos");
  });
});

describe("Home placement pin", () => {
  it("the mini sits directly under the hours, before the pay card", () => {
    const home = src("src/app/(app)/page.tsx");
    const hud = home.indexOf("<DutyHud");
    const mini = home.indexOf("<DayLogMini");
    const pay = home.indexOf("<DriverPayHomeCard");
    expect(hud).toBeGreaterThan(-1);
    expect(mini).toBeGreaterThan(-1);
    expect(pay).toBeGreaterThan(-1);
    expect(mini).toBeGreaterThan(hud);
    expect(mini).toBeLessThan(pay);
    expect(home).toContain('window={hosWindow.state} nowMs={nowMs}');
  });
});
