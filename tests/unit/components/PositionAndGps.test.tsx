// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});
// The voice-notes poll (Home's map, 2026-11-19): no notes in these tests.
globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { notes: [], memberCount: 1 } }), { status: 200 })) as unknown as typeof fetch;

vi.mock("next/dynamic", () => ({
  default: () => (props: { position: { lat: number; lng: number } | null; headingUp?: boolean; headingDeg?: number | null; interactive?: boolean; geometry?: unknown[] }) => (
    <div
      data-testid="map"
      data-lat={props.position?.lat}
      data-lng={props.position?.lng}
      data-heading-up={String(!!props.headingUp)}
      data-heading={String(props.headingDeg)}
      data-interactive={String(props.interactive)}
      data-route-points={props.geometry?.length ?? 0}
    />
  ),
}));
const speedLimit = vi.fn(async (): Promise<{ data: { limitMph: number | null; roadName: string | null; unavailable: boolean } }> => ({ data: { limitMph: null, roadName: null, unavailable: false } }));
const telegramPosition = vi.fn(async (): Promise<{ position: null | { lat: number; lng: number; accuracyM: number | null; headingDeg: number | null; speedMph: number | null; recordedAt: string; ageSeconds: number } }> => ({ position: null }));
vi.mock("@/lib/api-client", () => ({
  apiClient: { create: vi.fn(), telegramPosition: () => telegramPosition(), speedLimit: (...a: unknown[]) => (speedLimit as (...x: unknown[]) => unknown)(...a), whereAmI: async () => ({ data: { roadRef: null, roadName: null, mileMarker: null, town: null, state: null } }), list: vi.fn(async () => ({ data: [] })) },
  ApiClientError: class extends Error {},
}));
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

  it("when the fix goes stale the truck STAYS at its last known spot, clearly marked not live (owner 2026-11-19)", async () => {
    render(<HomePositionCard position={fix(30_000)} />);
    expect(screen.getByTestId("map")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(POSITION_FRESH_MS);
    });
    expect(screen.getByTestId("map").getAttribute("data-lat")).toBe("28.5383");
    expect(document.body.textContent).toContain("not live");
    expect(document.body.textContent).toContain("Last known position");
  });

  it("Block C: follow mode - heading-up, no touch pan (it must not trap page scroll), truck heading passed through", () => {
    render(<HomePositionCard position={fix(3_000)} headingDeg={270} speedMph={52} motion="moving" />);
    const map = screen.getByTestId("map");
    expect(map.getAttribute("data-heading-up")).toBe("true");
    expect(map.getAttribute("data-heading")).toBe("270");
    expect(map.getAttribute("data-interactive")).toBe("false");
  });

  it("Block C: no planned route -> position only, says so, and draws no route line", () => {
    render(<HomePositionCard position={fix(3_000)} />);
    expect(screen.getByTestId("map").getAttribute("data-route-points")).toBe("0");
    expect(document.body.textContent).toContain("No route set — showing your position only");
  });

  it("Block C: current speed always shown; unknown speed reads a dash, not a number", () => {
    const { rerender } = render(<HomePositionCard position={fix(3_000)} speedMph={51.6} motion="moving" />);
    expect(screen.getByLabelText("Your speed 52 miles per hour")).toBeTruthy();
    rerender(<HomePositionCard position={fix(3_000)} speedMph={null} motion="unknown" />);
    expect(screen.getByLabelText("Speed not available")).toBeTruthy();
  });

  it("Block C: NO speed-limit badge when the map data has no limit", async () => {
    speedLimit.mockResolvedValue({ data: { limitMph: null, roadName: null, unavailable: false } });
    render(<HomePositionCard position={fix(3_000)} motion="moving" />);
    await act(async () => {});
    expect(screen.queryByRole("img", { name: /Posted speed limit/ })).toBeNull();
  });

  it("Block C: NO badge when the limit service is unavailable (never a guess)", async () => {
    speedLimit.mockResolvedValue({ data: { limitMph: 55, roadName: null, unavailable: true } });
    render(<HomePositionCard position={fix(3_000)} motion="moving" />);
    await act(async () => {});
    expect(screen.queryByRole("img", { name: /Posted speed limit/ })).toBeNull();
  });

  it("Block C: a real posted limit shows as a road-sign badge", async () => {
    speedLimit.mockResolvedValue({ data: { limitMph: 55, roadName: "I-75", unavailable: false } });
    render(<HomePositionCard position={fix(3_000)} motion="moving" />);
    await act(async () => {});
    expect(screen.getByRole("img", { name: "Posted speed limit 55 miles per hour" })).toBeTruthy();
  });

  it("the app just reopened with no GPS fix of its own: falls back to Telegram's last position, labelled as such, with its age", async () => {
    telegramPosition.mockResolvedValueOnce({ position: { lat: 30.1, lng: -81.2, accuracyM: 20, headingDeg: 180, speedMph: 48, recordedAt: "x", ageSeconds: 40 } });
    render(<HomePositionCard position={null} />);
    await act(async () => {});
    const map = screen.getByTestId("map");
    expect(map.getAttribute("data-lat")).toBe("30.1");
    expect(map.getAttribute("data-heading")).toBe("180");
    expect(document.body.textContent).toContain("Position from the Tracker / Telegram");
    expect(document.body.textContent).not.toContain("Phone GPS");
  });

  it("an old server position (older than 3 min) still shows the truck there — as LAST KNOWN, never as live", async () => {
    telegramPosition.mockResolvedValueOnce({ position: { lat: 30.1, lng: -81.2, accuracyM: 20, headingDeg: null, speedMph: null, recordedAt: "x", ageSeconds: 7200 } });
    render(<HomePositionCard position={null} />);
    await act(async () => {});
    expect(screen.getByTestId("map").getAttribute("data-lat")).toBe("30.1");
    expect(document.body.textContent).toContain("Last known position · 2 h ago — not live");
    expect(document.body.textContent).not.toContain("Phone GPS");
  });

  it("the device's own fresh fix wins over Telegram's", async () => {
    telegramPosition.mockResolvedValue({ position: { lat: 1, lng: 1, accuracyM: 20, headingDeg: null, speedMph: null, recordedAt: "x", ageSeconds: 5 } });
    render(<HomePositionCard position={fix(3_000)} />);
    await act(async () => {});
    expect(screen.getByTestId("map").getAttribute("data-lat")).toBe("28.5383");
    expect(document.body.textContent).toContain("Phone GPS");
    telegramPosition.mockResolvedValue({ position: null });
  });

  it("ages read in plain words", () => {
    expect(positionAgeText(1000)).toBe("just now");
    expect(positionAgeText(42_000)).toBe("42 s ago");
    expect(positionAgeText(130_000)).toBe("2 min ago");
    expect(positionAgeText(3 * 3_600_000)).toBe("3 h ago");
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

describe("map-first Home: the hero map never silently vanishes", () => {
  it("with no fix the hero says why and how to fix it; the plain card still renders nothing", () => {
    const hero = render(<HomePositionCard position={null} hero />);
    expect(screen.getByText(/No position yet/)).toBeTruthy();
    expect(screen.getByText(/hours and pay below are not affected/)).toBeTruthy();
    hero.unmount();
    const { container } = render(<HomePositionCard position={null} />);
    expect(container.textContent).toBe("");
  });
  it("with a fresh fix the hero map is the taller edge-to-edge variant", () => {
    const { container } = render(<HomePositionCard position={fix(3_000)} hero />);
    expect(container.querySelector(".home-position-hero")).toBeTruthy();
    expect(screen.getByTestId("map")).toBeTruthy();
  });
});
