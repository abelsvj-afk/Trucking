// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

vi.mock("next/dynamic", () => ({
  default: () => (props: { position: { lat: number; lng: number } | null }) => (
    <div data-testid="map" data-lat={props.position?.lat} data-lng={props.position?.lng} />
  ),
}));
vi.mock("@/lib/api-client", () => ({ apiClient: { create: vi.fn() }, ApiClientError: class extends Error {} }));
vi.mock("@/lib/offline-outbox", () => ({ offlineOutbox: { enqueue: vi.fn() } }));

import HomePositionCard, { positionAgeText, POSITION_FRESH_MS } from "@/components/hud/HomePositionCard";
import StatusSheet from "@/components/hud/StatusSheet";

const NOW = Date.parse("2026-11-04T15:00:00Z");
const fix = (ageMs: number) => ({ lat: 28.5383, lng: -81.3792, accuracyM: 12.4, atMs: NOW - ageMs });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

describe("HomePositionCard (live GPS position on Home)", () => {
  it("shows a map at the phone's position with accuracy and age - and says it's the phone, not an ELD", () => {
    render(<HomePositionCard position={fix(3_000)} />);
    expect(screen.getByTestId("map").getAttribute("data-lat")).toBe("28.5383");
    expect(document.body.textContent).toContain("Phone GPS · ±12 m · just now");
  });

  it("is absent with no fix - never a blank map or a guessed location", () => {
    const { container } = render(<HomePositionCard position={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("disappears when the fix goes stale instead of showing an old location as live", async () => {
    render(<HomePositionCard position={fix(30_000)} />);
    expect(screen.getByTestId("map")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(POSITION_FRESH_MS);
    });
    expect(screen.queryByTestId("map")).toBeNull();
  });

  it("ages read in plain words", () => {
    expect(positionAgeText(1000)).toBe("just now");
    expect(positionAgeText(42_000)).toBe("42 s ago");
    expect(positionAgeText(130_000)).toBe("2 min ago");
  });
});

describe("StatusSheet GPS location (audit B6)", () => {
  const mount = (gps: ReturnType<typeof fix> | null) =>
    render(<StatusSheet status="driving" gps={gps} onCancel={() => {}} onSaved={() => {}} />);

  it("offers 'Use my GPS position' with a fresh fix and fills the location in words with its accuracy", () => {
    mount(fix(2_000));
    fireEvent.click(screen.getByRole("button", { name: "Use my GPS position" }));
    expect((screen.getByLabelText(/Where/) as HTMLInputElement).value).toBe("GPS 28.5383, -81.3792 (±12 m)");
  });

  it("no button without a fix, or with a stale one; typed location is always the fallback", () => {
    mount(null);
    expect(screen.queryByRole("button", { name: "Use my GPS position" })).toBeNull();
    cleanup();
    mount(fix(90_000));
    expect(screen.queryByRole("button", { name: "Use my GPS position" })).toBeNull();
    expect(screen.getByLabelText(/Where/)).toBeTruthy();
  });
});
