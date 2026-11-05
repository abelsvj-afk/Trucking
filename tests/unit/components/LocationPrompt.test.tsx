// @vitest-environment jsdom
// D-7: ask once, in plain words, only when the browser would actually ask.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import LocationPrompt from "@/components/LocationPrompt";

const getCurrentPosition = vi.fn();
function setup(state: "prompt" | "granted" | "denied" | "unsupported") {
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: state === "unsupported" ? undefined : { query: vi.fn().mockResolvedValue({ state }) },
  });
}
beforeEach(() => { window.localStorage.clear(); getCurrentPosition.mockReset(); });
afterEach(cleanup);

describe("LocationPrompt", () => {
  it("shows once when the browser would ask, and 'Allow' triggers the real prompt", async () => {
    setup("prompt");
    await act(async () => void render(<LocationPrompt />));
    expect(screen.getByRole("dialog", { name: "Allow location" })).toBeTruthy();
    fireEvent.click(screen.getByText("Allow location"));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    await act(async () => void render(<LocationPrompt />));
    expect(screen.queryByRole("dialog")).toBeNull(); // never again
  });

  it("'Not now' is remembered and nothing is requested", async () => {
    setup("prompt");
    await act(async () => void render(<LocationPrompt />));
    fireEvent.click(screen.getByText("Not now"));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    cleanup();
    await act(async () => void render(<LocationPrompt />));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says nothing when permission is already granted/denied or the Permissions API is missing", async () => {
    for (const state of ["granted", "denied", "unsupported"] as const) {
      setup(state);
      await act(async () => void render(<LocationPrompt />));
      expect(screen.queryByRole("dialog")).toBeNull();
      cleanup();
    }
  });
});
