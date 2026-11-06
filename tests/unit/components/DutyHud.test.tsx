// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const enqueue = vi.fn();
vi.mock("@/lib/offline-outbox", () => ({ offlineOutbox: { enqueue: (...a: unknown[]) => enqueue(...a) } }));

class MockApiClientError extends Error {}
vi.mock("@/lib/api-client", () => ({
  apiClient: { dutyLogWindow: vi.fn(), create: vi.fn() },
  ApiClientError: class extends Error {},
}));

const motionHolder: { state: "moving" | "stopped" | "unknown" } = { state: "stopped" };
vi.mock("@/lib/use-vehicle-motion", () => ({
  useVehicleMotion: () => motionHolder.state,
  useVehicleMotionDetail: () => ({ state: motionHolder.state, position: null }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { apiClient } from "@/lib/api-client";
import DutyHud from "@/components/hud/DutyHud";

const H = 3_600_000;

function windowResult(rows: { duty_status: string; started_at: string }[], overrides = {}) {
  const now = Date.now();
  return {
    data: rows.map((r, i) => ({ id: `r${i}`, ...r })),
    hos: {
      cycle: "70/8",
      cycleLimitMinutes: 4200,
      periodAnchor: "00:00",
      restartEnabled: true,
      carrierTimeZone: "America/New_York",
      windowStart: new Date(now - 8 * 24 * H).toISOString(),
      windowEnd: new Date(now).toISOString(),
      currentPeriodStart: new Date(now - 6 * H).toISOString(),
      onDutyMinutesInCycle: 600,
      restartApplied: null,
      restartUnverified: false,
      warnings: [],
      ...overrides,
    },
  };
}

async function renderHud(result: unknown) {
  vi.mocked(apiClient.dutyLogWindow).mockResolvedValue(result as never);
  render(<DutyHud />);
  await act(async () => {});
}

beforeEach(() => {
  motionHolder.state = "stopped";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
  vi.clearAllMocks();
});

describe("DutyHud", () => {
  it("with no logs says clocks start when he goes on duty - no running clock", async () => {
    await renderHud(windowResult([]));
    expect(screen.getByText(/Clocks start when you go on duty/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Drive:/ })).toBeNull();
  });

  it("shows the four rings and the not-an-ELD disclaimer verbatim", async () => {
    const now = Date.now();
    await renderHud(
      windowResult([
        { duty_status: "off_duty", started_at: new Date(now - 20 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(now - 2 * H).toISOString() },
      ]),
    );
    expect(screen.getByRole("button", { name: /^Drive:/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^14-hour window:/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Break due in:/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^70\/8 cycle:/ })).toBeTruthy();
    expect(screen.getByText(/Paper-log helper, not an ELD\./)).toBeTruthy();
  });

  it("ticks every second without any further network call", async () => {
    const now = Date.now();
    await renderHud(
      windowResult([
        { duty_status: "off_duty", started_at: new Date(now - 20 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(now - 2 * H).toISOString() },
      ]),
    );
    const before = screen.getAllByText(/^\d+:\d\d:\d\d$/).map((n) => n.textContent);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    const after = screen.getAllByText(/^\d+:\d\d:\d\d$/).map((n) => n.textContent);
    expect(after).not.toEqual(before);
    expect(vi.mocked(apiClient.dutyLogWindow)).toHaveBeenCalledTimes(1);
  });

  it("labels the carrier settings as provisional when they are the defaults", async () => {
    const now = Date.now();
    await renderHud(windowResult([{ duty_status: "driving", started_at: new Date(now - H).toISOString() }]));
    expect(screen.getByText(/provisional carrier settings/)).toBeTruthy();
  });

  it("does not claim provisional once the carrier's own rules are set", async () => {
    const now = Date.now();
    await renderHud(
      windowResult([{ duty_status: "driving", started_at: new Date(now - H).toISOString() }], {
        cycle: "60/7",
        cycleLimitMinutes: 3600,
        periodAnchor: "06:00",
      }),
    );
    expect(screen.queryByText(/provisional carrier settings/)).toBeNull();
  });

  it("on a failed load shows no clocks and says so, with retry", async () => {
    vi.mocked(apiClient.dutyLogWindow).mockRejectedValue(new MockApiClientError("down"));
    render(<DutyHud />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("none are shown");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Drive:/ })).toBeNull();
  });

  it("opens the status sheet on a tap, saves with a submission id, and refreshes", async () => {
    await renderHud(windowResult([]));
    vi.mocked(apiClient.create).mockResolvedValue({} as never);
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    expect(screen.getByRole("form", { name: /Driving/ })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    });
    const [resource, body] = vi.mocked(apiClient.create).mock.calls[0]!;
    expect(resource).toBe("duty-logs");
    expect(body).toMatchObject({ duty_status: "driving", driver_id: null });
    expect(typeof (body as { submission_id: string }).submission_id).toBe("string");
    expect(screen.getByText("Status saved.")).toBeTruthy();
    expect(vi.mocked(apiClient.dutyLogWindow)).toHaveBeenCalledTimes(2);
  });

  it("the status change opens as a popup over Home (no page switch) and closes on Escape", async () => {
    await renderHud(windowResult([]));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    const dialog = screen.getByRole("dialog", { name: "Change status" });
    expect(dialog.querySelector("form")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a live time-in-status counter that ticks", async () => {
    const now = Date.now();
    await renderHud(
      windowResult([
        { duty_status: "off_duty", started_at: new Date(now - 20 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(now - 2 * H).toISOString() },
      ]),
    );
    const timer = screen.getByLabelText("Time in this status");
    expect(timer.textContent).toBe("2:00:00");
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(timer.textContent).toBe("2:00:05");
  });

  it("Day log opens the editable day in a popup, right on Home; it is off with nothing logged", async () => {
    await renderHud(windowResult([]));
    expect((screen.getByRole("button", { name: "Day log" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const now = Date.now();
    await renderHud(
      windowResult([
        { duty_status: "off_duty", started_at: new Date(now - 20 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(now - 2 * H).toISOString() },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Day log" }));
    const dialog = screen.getByRole("dialog", { name: "Your day" });
    expect(dialog.querySelector(".day-graph")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Paper log" }).getAttribute("href")).toBe("/fleet/hos/paper");
  });

  it("flags an earlier time as entered after the fact, and refuses the future", async () => {
    await renderHud(windowResult([]));
    fireEvent.click(screen.getByRole("button", { name: "Off duty" }));
    const input = screen.getByLabelText(/Starts at/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-11-04T08:00" } });
    expect(screen.getByText(/entered after the fact/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "2026-11-05T08:00" } });
    expect(screen.getByRole("alert").textContent).toContain("can't start in the future");
    expect((screen.getByRole("button", { name: "Save status" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with no signal queues the change on the device and says so", async () => {
    await renderHud(windowResult([]));
    vi.mocked(apiClient.create).mockRejectedValue(new TypeError("network"));
    fireEvent.click(screen.getByRole("button", { name: "Sleeper berth" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    });
    expect(enqueue).toHaveBeenCalledWith("duty-logs", expect.objectContaining({ duty_status: "sleeper" }));
    expect(screen.getByText(/saved on this device/)).toBeTruthy();
  });
});


describe("DutyHud driving safety (audit 2026-11-04): unknown speed fails closed", () => {
  const rolling = () => {
    const now = Date.now();
    return windowResult([
      { duty_status: "off_duty", started_at: new Date(now - 20 * H).toISOString() },
      { duty_status: "driving", started_at: new Date(now - 2 * H).toISOString() },
    ]);
  };

  it("tapping a clock opens its plain-language explainer (what it is, at zero, what resets it) - also while moving", async () => {
    motionHolder.state = "moving";
    await renderHud(rolling());
    fireEvent.click(screen.getByRole("button", { name: /^14-hour window:/ }));
    const dialog = screen.getByRole("dialog", { name: "14-hour window" });
    expect(dialog.textContent).toContain("runs on ANY duty time");
    expect(dialog.textContent).toContain("10 straight hours off");
  });

  it("moving: EDITING is off (Day log, Paper log) but the status switcher is never gated - and the clocks keep running", async () => {
    motionHolder.state = "moving";
    await renderHud(rolling());
    // Block A: changing duty status must always be reachable.
    for (const name of ["Driving", "On duty (not driving)", "Off duty", "Sleeper berth"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect((screen.getByRole("button", { name: "Day log" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Paper log" })).toBeNull();
    expect(screen.getByText(/Changing your duty status is always available/)).toBeTruthy();
    expect(screen.getByLabelText("Time in this status")).toBeTruthy();
  });

  it("moving: the status sheet is the no-typing quick variant, exempt from the lock, and saves 'now'", async () => {
    motionHolder.state = "moving";
    vi.mocked(apiClient.create).mockResolvedValue({} as never);
    await renderHud(rolling());
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    const dialog = screen.getByRole("dialog", { name: "Change status" });
    const form = dialog.querySelector("form")!;
    expect(form.hasAttribute("data-motion-exempt")).toBe(true);
    expect(form.querySelector("input")).toBeNull(); // nothing to type while rolling
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Switch to Driving now/ }));
    });
    const [resource, body] = vi.mocked(apiClient.create).mock.calls.at(-1)!;
    expect(resource).toBe("duty-logs");
    expect((body as { duty_status: string; location: unknown; notes: unknown }).duty_status).toBe("driving");
    expect((body as { location: unknown }).location).toBeNull();
    expect(Math.abs(Date.parse((body as { started_at: string }).started_at) - Date.now())).toBeLessThan(5_000);
  });

  it("unknown speed: the status sheet is the quick variant too (no 'I'm parked' wall, no typing)", async () => {
    motionHolder.state = "unknown";
    await renderHud(rolling());
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    const form = screen.getByRole("dialog", { name: "Change status" }).querySelector("form")!;
    expect(form.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch to Driving now/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I'm parked" })).toBeNull();
  });

  it("stopped: the full form (time, where, note) is offered as before", async () => {
    motionHolder.state = "stopped";
    await renderHud(rolling());
    fireEvent.click(screen.getByRole("button", { name: "Driving" }));
    const form = screen.getByRole("dialog", { name: "Change status" }).querySelector("form")!;
    expect(form.querySelector("input")).not.toBeNull();
  });

  it("unknown speed: the Day log popup is gated the same way", async () => {
    motionHolder.state = "unknown";
    await renderHud(rolling());
    fireEvent.click(screen.getByRole("button", { name: "Day log" }));
    expect(screen.getByRole("dialog", { name: "Your day" }).querySelector(".day-graph")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I'm parked" }));
    expect(screen.getByRole("dialog", { name: "Your day" }).querySelector(".day-graph")).not.toBeNull();
  });
});
