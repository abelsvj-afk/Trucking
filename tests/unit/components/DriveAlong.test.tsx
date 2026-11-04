// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const create = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: { dutyLogWindow: vi.fn(), create: (...a: unknown[]) => create(...a) },
  ApiClientError: class extends Error {},
}));
vi.mock("@/lib/offline-outbox", () => ({ offlineOutbox: { enqueue: vi.fn() } }));
const motionHolder: { state: "moving" | "stopped" | "unknown" } = { state: "stopped" };
vi.mock("@/lib/use-vehicle-motion", () => ({
  useVehicleMotion: () => motionHolder.state,
  useVehicleMotionDetail: () => ({ state: motionHolder.state, position: null }),
}));

import { apiClient } from "@/lib/api-client";
import DriveClocks from "@/components/drive/DriveClocks";
import DriveStatusPrompt from "@/components/drive/DriveStatusPrompt";

const H = 3_600_000;
const NOW = Date.parse("2026-11-04T15:00:00Z");

function windowOf(rows: { duty_status: string; at: number }[]) {
  return {
    data: rows.map((r, i) => ({ id: `r${i}`, duty_status: r.duty_status, started_at: new Date(r.at).toISOString() })),
    hos: {
      cycle: "70/8", cycleLimitMinutes: 4200, periodAnchor: "00:00", restartEnabled: true, carrierTimeZone: "America/New_York",
      windowStart: new Date(NOW - 8 * 24 * H).toISOString(), windowEnd: new Date(NOW).toISOString(),
      currentPeriodStart: new Date(NOW - 6 * H).toISOString(), onDutyMinutesInCycle: 600, restartApplied: null,
      restartUnverified: false, warnings: [],
    },
  };
}

async function mount(ui: React.ReactElement, result: unknown) {
  vi.mocked(apiClient.dutyLogWindow).mockResolvedValue(result as never);
  await act(async () => void render(ui));
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  motionHolder.state = "stopped";
});

describe("DriveClocks (clocks riding with the route)", () => {
  it("shows the four clocks ticking each second, read-only, with the not-an-ELD line", async () => {
    await mount(<DriveClocks />, windowOf([{ duty_status: "off_duty", at: NOW - 20 * H }, { duty_status: "driving", at: NOW - 2 * H }]));
    const group = screen.getByLabelText("Hours clocks");
    expect(group.querySelectorAll("button, a, input")).toHaveLength(0);
    expect(screen.getByLabelText(/^Drive: 9:00:00 remaining/)).toBeTruthy();
    expect(screen.getByLabelText(/^70\/8 cycle:/)).toBeTruthy();
    expect(group.textContent).toContain("Paper-log helper, not an ELD.");
    const before = group.textContent;
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(group.textContent).not.toBe(before);
    expect(vi.mocked(apiClient.dutyLogWindow)).toHaveBeenCalledTimes(1);
  });

  it("says so - never a made-up number - when the clocks can't be loaded or nothing is logged", async () => {
    vi.mocked(apiClient.dutyLogWindow).mockRejectedValue(new Error("down"));
    await act(async () => void render(<DriveClocks />));
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toContain("unavailable");
    cleanup();
    await mount(<DriveClocks />, windowOf([]));
    expect(screen.getByRole("status").textContent).toContain("Clocks start when you go on duty");
  });

  it("flags a clock at its limit in words, not only colour", async () => {
    await mount(<DriveClocks />, windowOf([{ duty_status: "off_duty", at: NOW - 40 * H }, { duty_status: "driving", at: NOW - 15 * H }]));
    expect(screen.getByLabelText(/^Drive: 0:00:00 remaining · limit reached/)).toBeTruthy();
  });
});

describe("DriveStatusPrompt (offers, never books)", () => {
  const parked = () => windowOf([{ duty_status: "off_duty", at: NOW - 12 * H }]);

  it("before GO it offers 'Log Driving' - and books nothing by itself", async () => {
    await mount(<DriveStatusPrompt offer={["driving"]} />, parked());
    expect(screen.getByText(/Logged as/).textContent).toContain("Off duty");
    expect(screen.getByRole("button", { name: "Log Driving" })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("no offer for the status he is already in", async () => {
    await mount(<DriveStatusPrompt offer={["driving"]} />, windowOf([{ duty_status: "driving", at: NOW - H }]));
    expect(screen.queryByRole("button", { name: "Log Driving" })).toBeNull();
  });

  it("a tap opens the confirm sheet (time now, editable) and only the sheet's Save books it", async () => {
    await mount(<DriveStatusPrompt offer={["driving"]} />, parked());
    fireEvent.click(screen.getByRole("button", { name: "Log Driving" }));
    expect(screen.getByRole("dialog", { name: "Change status" }).querySelector("form")).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
    vi.mocked(create).mockResolvedValue({});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save status" })));
    expect(create).toHaveBeenCalledWith("duty-logs", expect.objectContaining({ duty_status: "driving" }));
  });

  it("after the run it offers Off duty and On duty", async () => {
    await mount(<DriveStatusPrompt offer={["off_duty", "on_duty"]} />, windowOf([{ duty_status: "driving", at: NOW - H }]));
    expect(screen.getByRole("button", { name: "Log Off duty" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log On duty (not driving)" })).toBeTruthy();
  });

  it("the motion gate still applies: while moving the sheet refuses to open a form", async () => {
    motionHolder.state = "moving";
    await mount(<DriveStatusPrompt offer={["driving"]} />, parked());
    fireEvent.click(screen.getByRole("button", { name: "Log Driving" }));
    expect(screen.getByRole("dialog").querySelector("form")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("You're moving");
  });
});
