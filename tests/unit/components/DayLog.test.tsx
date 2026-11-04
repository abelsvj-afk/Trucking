// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

vi.mock("@/lib/api-client", () => ({
  apiClient: { update: vi.fn(), remove: vi.fn(), create: vi.fn() },
  ApiClientError: class extends Error {},
}));

import { apiClient } from "@/lib/api-client";
import DayLog from "@/components/hud/DayLog";
import type { DayRow } from "@/lib/day-view";

const TZ = "America/New_York";
// "Now" = 2026-11-03 18:00 New York (23:00Z)
const NOW = Date.parse("2026-11-03T23:00:00Z");
const rows: DayRow[] = [
  { id: "a", duty_status: "sleeper", started_at: "2026-11-03T02:00:00Z", created_at: "2026-11-03T02:00:30Z" }, // 21:00 prev day
  { id: "b", duty_status: "driving", started_at: "2026-11-03T11:00:00Z", created_at: "2026-11-03T11:00:10Z" }, // 06:00
  { id: "c", duty_status: "on_duty", started_at: "2026-11-03T20:00:00Z", created_at: "2026-11-03T22:30:00Z", source: "paper_photo" }, // 15:00
];

function mount() {
  render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
}
const hit = (i: number) => fireEvent.click(document.querySelectorAll(".dg-hit")[i]!);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
});

describe("DayLog", () => {
  it("draws today on the carrier's clock with totals, up to now", () => {
    mount();
    expect(screen.getByText("Today · 2026-11-03")).toBeTruthy();
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(3);
    const totals = document.querySelector(".day-totals")!.textContent!;
    expect(totals).toContain("Sleeper berth 6h 00m");
    expect(totals).toContain("Driving 9h 00m");
    expect(totals).toContain("On duty (not driving) 3h 00m");
    expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("steps back a day and shows that day's stretches", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("2026-11-02")).toBeTruthy();
    expect(document.querySelectorAll(".dg-hit")).toHaveLength(1); // sleeper from 21:00
  });

  it("changes a stretch's status through the API", async () => {
    mount();
    hit(1);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "on_duty" } });
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save status" })));
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", { duty_status: "on_duty" });
    expect(screen.getByText(/Changed to On duty/)).toBeTruthy();
  });

  it("refuses to move a start past its neighbour - nothing is sent", () => {
    mount();
    hit(1);
    fireEvent.change(screen.getByLabelText(/Started at/), { target: { value: "16:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Move start" }));
    expect(screen.getByRole("alert").textContent).toContain("pass the next entry");
    expect(apiClient.update).not.toHaveBeenCalled();
  });

  it("moves a start within bounds, on the carrier's clock", async () => {
    mount();
    hit(1);
    fireEvent.change(screen.getByLabelText(/Started at/), { target: { value: "06:37" } });
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move start" })));
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", { started_at: "2026-11-03T11:37:00.000Z" });
  });

  it("adds a change inside a stretch, and refuses one outside it", async () => {
    mount();
    hit(1);
    const time = screen.getByLabelText("At");
    fireEvent.change(time, { target: { value: "05:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add change" }));
    expect(screen.getByRole("alert").textContent).toContain("inside this stretch");
    expect(apiClient.create).not.toHaveBeenCalled();

    fireEvent.change(time, { target: { value: "10:15" } });
    fireEvent.change(screen.getByLabelText("Changed to"), { target: { value: "off_duty" } });
    vi.mocked(apiClient.create).mockResolvedValue({} as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add change" })));
    expect(apiClient.create).toHaveBeenCalledWith(
      "duty-logs",
      expect.objectContaining({ duty_status: "off_duty", started_at: "2026-11-03T15:15:00.000Z" }),
    );
  });

  it("delete asks first and says which status runs on", async () => {
    mount();
    hit(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete this entry" }));
    expect(screen.getByRole("alert").textContent).toMatch(/sleeper berth run on until/i);
    expect(apiClient.remove).not.toHaveBeenCalled();
    vi.mocked(apiClient.remove).mockResolvedValue(undefined as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" })));
    expect(apiClient.remove).toHaveBeenCalledWith("duty-logs", "b");
  });

  it("a paper-sheet row carries the re-mark reminder and its after-the-fact entry", () => {
    mount();
    hit(2);
    expect(screen.getByText(/your paper sheet still says the old time/)).toBeTruthy();
    expect(screen.getByText(/Entered after the fact/)).toBeTruthy();
  });
});

describe("DayLog under live updates (pitfall hunt, 2026-11-04)", () => {
  const stretchCount = () => document.querySelectorAll(".dg-hit").length;

  it("an edit panel stays on the ENTRY the driver picked when a new row arrives above it", async () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(1); // the 06:00 driving entry, id "b"
    expect(screen.getByLabelText("Status")).toBeTruthy();
    // Abel logs a new on-duty entry at 02:00 ET - everything below shifts down one position.
    const withNew: DayRow[] = [
      rows[0]!,
      { id: "n", duty_status: "on_duty", started_at: "2026-11-03T07:00:00Z", created_at: "2026-11-03T07:00:05Z" },
      rows[1]!,
      rows[2]!,
    ];
    rerender(<DayLog rows={withNew} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect(stretchCount()).toBe(4);
    vi.mocked(apiClient.update).mockResolvedValue({} as never);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "off_duty" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save status" })));
    // Still the driving entry "b" - not whatever now sits at position 1.
    expect(apiClient.update).toHaveBeenCalledWith("duty-logs", "b", { duty_status: "off_duty" });
  });

  it("if the picked entry disappears elsewhere, its editor closes and says why - nothing else is editable by accident", () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(1);
    rerender(<DayLog rows={[rows[0]!, rows[2]!]} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.getByText(/changed or was removed somewhere else/)).toBeTruthy();
    expect(apiClient.update).not.toHaveBeenCalled();
  });

  it("a neighbour's change doesn't wipe what the driver is typing in this entry's panel", () => {
    const { rerender } = render(<DayLog rows={rows} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    hit(0);
    const input = screen.getByLabelText(/Started at/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "21:15" } });
    // A later entry's status changes elsewhere; this entry is untouched.
    rerender(<DayLog rows={[rows[0]!, rows[1]!, { ...rows[2]!, duty_status: "off_duty" }]} timeZone={TZ} oldestIso="2026-10-25T04:00:00Z" />);
    expect((screen.getByLabelText(/Started at/) as HTMLInputElement).value).toBe("21:15");
  });
});
