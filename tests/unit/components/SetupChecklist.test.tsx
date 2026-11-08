// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildSetupChecklist, essentialRemaining } from "@/lib/setup-checklist";

const list = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiClient: { list: (...a: unknown[]) => list(...a) } }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
import SetupChecklist from "@/components/SetupChecklist";

const answer = (map: Record<string, unknown[]>) => list.mockImplementation(async (r: string) => ({ data: map[r] ?? [] }));
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("buildSetupChecklist detects from real records", () => {
  it("an empty account has every essential step open", () => {
    const items = buildSetupChecklist({ payProfiles: [], truckCount: 0, truckWithProfileCount: 0, loadCount: 0, driverCount: 0 });
    expect(essentialRemaining(items)).toBe(5);
  });
  it("complete pay terms + truck + load close the essentials; optional ones stay open", () => {
    const items = buildSetupChecklist({ payProfiles: [{ rate_cents_per_mile: 55, mile_basis: "all", pay_week_ends_on: 6, payday_weekday: 5, effective_to: null }], truckCount: 1, truckWithProfileCount: 0, loadCount: 1, driverCount: 0 });
    expect(essentialRemaining(items)).toBe(0);
    expect(items.filter((i) => !i.done).map((i) => i.key)).toEqual(["truck-profile", "driver"]);
  });
  it("closed (old) pay terms do not count as current terms", () => {
    const items = buildSetupChecklist({ payProfiles: [{ rate_cents_per_mile: 55, mile_basis: "all", pay_week_ends_on: 6, payday_weekday: 5, effective_to: "2026-01-01" }], truckCount: 0, truckWithProfileCount: 0, loadCount: 0, driverCount: 0 });
    expect(items.find((i) => i.key === "pay-terms")!.done).toBe(false);
  });
});

describe("SetupChecklist", () => {
  it("links to each unfinished task, says essential vs optional, and can be dismissed", async () => {
    answer({});
    render(<SetupChecklist />);
    expect(await screen.findByText("Enter your pay terms")).toBeTruthy();
    expect(screen.getByText(/5 essential steps left/)).toBeTruthy();
    expect(screen.getByText("Add your truck").closest("a")!.getAttribute("href")).toBe("/fleet/trucks/new");
    fireEvent.click(screen.getByText("Hide this for now"));
    expect(screen.queryByText("Finish setting up")).toBeNull();
    expect(window.localStorage.getItem("setup-checklist-dismissed")).toBe("1");
  });
  it("shows nothing when a load fails (never a wrong 'all done')", async () => {
    list.mockRejectedValue(new Error("x"));
    const { container } = render(<SetupChecklist />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
  it("shows nothing once every item is done", async () => {
    answer({ "pay-profiles": [{ rate_cents_per_mile: 55, mile_basis: "all", pay_week_ends_on: 6, payday_weekday: 5, effective_to: null }], trucks: [{ height_in: 150 }], loads: [{ id: "l" }], drivers: [{ id: "d" }] });
    const { container } = render(<SetupChecklist />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
