// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScreenWakeLock } from "@/lib/use-screen-wake-lock";

afterEach(() => {
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

describe("useScreenWakeLock (2026-11-19: the map keeps the screen awake)", () => {
  it("asks for the screen lock while the drive map is open, and lets go when it closes", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ released: false, release, addEventListener: vi.fn() });
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    const { result, rerender } = renderHook(({ on }) => useScreenWakeLock(on), { initialProps: { on: true } });
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("screen");
    expect(result.current).toBe("on");
    rerender({ on: false });
    expect(release).toHaveBeenCalled();
  });

  it("says unsupported when the browser can't (the Tracker's map screen covers it)", async () => {
    const { result } = renderHook(() => useScreenWakeLock(true));
    await act(async () => {});
    expect(result.current).toBe("unsupported");
  });
});
