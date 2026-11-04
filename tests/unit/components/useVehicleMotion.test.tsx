// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useVehicleMotion, useVehicleMotionDetail } from "@/lib/use-vehicle-motion";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // @ts-expect-error test cleanup
  delete navigator.geolocation;
});

function Probe() {
  return <p>{useVehicleMotion()}</p>;
}

type Cb = (p: { coords: { speed: number | null; latitude?: number; longitude?: number; accuracy?: number } }) => void;
let onFix: Cb | null = null;
let onError: (() => void) | null = null;
const clearWatch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
  onFix = null;
  onError = null;
  clearWatch.mockReset();
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: (ok: Cb, err: () => void) => {
        onFix = ok;
        onError = err;
        return 7;
      },
      clearWatch,
    },
  });
});

const mph = (m: number) => m / 2.23694;

describe("useVehicleMotion", () => {
  it("is 'unknown' until the first reading - never assumed stopped", async () => {
    await act(async () => void render(<Probe />));
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("reads moving, then stopped, from GPS speed", async () => {
    await act(async () => void render(<Probe />));
    act(() => onFix!({ coords: { speed: mph(40) } }));
    expect(screen.getByText("moving")).toBeTruthy();
    act(() => onFix!({ coords: { speed: 0 } }));
    // a stop must HOLD before anything unlocks: not "stopped" yet
    expect(screen.getByText("moving")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("a lull in traffic doesn't unlock: speed back above the threshold restarts the stop clock", async () => {
    await act(async () => void render(<Probe />));
    act(() => onFix!({ coords: { speed: 0 } }));
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText("moving")).toBeTruthy();
    act(() => onFix!({ coords: { speed: mph(12) } }));
    act(() => onFix!({ coords: { speed: 0 } }));
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    // 16 s since the first lull, but only 8 s since the last movement
    expect(screen.getByText("moving")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(6_000); // the 5 s re-check lands inside this
    });
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("a reading with no speed value is unknown, not stopped", async () => {
    await act(async () => void render(<Probe />));
    act(() => onFix!({ coords: { speed: null } }));
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("'stopped' expires: with no fresh fix for 15 s it goes back to unknown", async () => {
    await act(async () => void render(<Probe />));
    act(() => onFix!({ coords: { speed: 0 } }));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("stopped")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("permission denied or GPS error is unknown", async () => {
    await act(async () => void render(<Probe />));
    act(() => onFix!({ coords: { speed: 0 } }));
    act(() => onError!());
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("no geolocation at all is unknown, and the watch is released on unmount", async () => {
    await act(async () => void render(<Probe />));
    cleanup();
    expect(clearWatch).toHaveBeenCalledWith(7);
    // @ts-expect-error simulate a browser without geolocation
    delete navigator.geolocation;
    await act(async () => void render(<Probe />));
    expect(screen.getByText("unknown")).toBeTruthy();
  });
});

function DetailProbe() {
  const { state, position } = useVehicleMotionDetail();
  return <p>{state}|{position ? `${position.lat},${position.lng},${position.accuracyM}` : "none"}</p>;
}

describe("useVehicleMotionDetail (position for the Home map and the GPS location button)", () => {
  it("exposes the latest fix, and drops it (not a stale guess) on a GPS error", async () => {
    await act(async () => void render(<DetailProbe />));
    expect(screen.getByText("unknown|none")).toBeTruthy();
    act(() => onFix!({ coords: { speed: 0, latitude: 28.5, longitude: -81.4, accuracy: 9 } }));
    expect(screen.getByText("moving|28.5,-81.4,9")).toBeTruthy(); // position is immediate; the stop is not settled yet
    act(() => onError!());
    expect(screen.getByText("unknown|none")).toBeTruthy();
  });
});
