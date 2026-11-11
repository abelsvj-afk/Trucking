// @vitest-environment jsdom
// The everyday map card with active-load navigation: the route reaches the map through the existing route-line mechanism, the next turn
// and the ETA-vs-clock line show, a car-only route is stamped NOT TRUCK-LEGAL with no turns, and a U-turn with a trailer is refused.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/dynamic", () => ({
  default: () => (props: { geometry?: unknown[]; traveledGeometry?: unknown[] }) => <div data-testid="map" data-route-points={props.geometry?.length ?? 0} />,
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/use-live", () => ({ useLiveVersion: () => 0, useLiveConnected: () => false }));
const activeLoad = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiClient: { activeLoad: (...a: unknown[]) => activeLoad(...a), telegramPosition: vi.fn(async () => ({ position: null })), speedLimit: vi.fn(async () => ({ data: { limitMph: null, roadName: null, unavailable: true } })), list: vi.fn(async () => ({ data: [] })) },
  ApiClientError: class extends Error {},
}));

import HomePositionCard from "@/components/hud/HomePositionCard";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const east = [{ lat: 37, lng: -94 }, { lat: 37, lng: -93.9 }, { lat: 37, lng: -93.5 }, { lat: 37, lng: -93 }];
const state = (routeOver: Record<string, unknown> = {}, loadOver: Record<string, unknown> = {}) => ({
  data: {
    load: { id: "L1", origin: "A", destination: "B", tripNumber: null, pickupDate: null, deliveryDate: null, overdue: false, trailering: true, ...loadOver },
    nextStop: { source: "stop", stopId: "S1", seq: 1, kind: "pickup", name: "Acme DC", address: "1 Dock Rd", appointmentAt: null, appointmentTz: null, arrived: false, basis: null, point: { lat: 37, lng: -93 } },
    position: null,
    route: {
      distanceMiles: 55, durationMinutes: 300, etaAt: "x", providerName: "OpenRouteService (driving-hgv)", truckLegal: true, guidanceAllowed: true, notTruckLegalNotice: null, providerNotes: [],
      geometry: east, maneuvers: [{ instruction: "Head east on I-44", distanceMiles: 27, atFraction: 0 }, { instruction: "Take exit 80 on the right", distanceMiles: 20, atFraction: 0.5 }],
      needsUTurn: false, uTurnBlocked: false, ...routeOver,
    },
    routeUnavailableReason: null, asOf: "x",
  },
});
const here = () => ({ lat: 37, lng: -94, accuracyM: 8, atMs: Date.now() });

describe("Home map card: active-load navigation", () => {
  it("draws the automatic route with no Smart Path run, shows the next turn, and compares the ETA with his real drive clock", async () => {
    activeLoad.mockResolvedValue(state());
    render(<HomePositionCard position={here()} headingDeg={90} speedMph={55} motion="moving" hero driveLeftMs={260 * 60_000} windowLeftMs={600 * 60_000} />);
    await waitFor(() => expect(screen.getByTestId("map").getAttribute("data-route-points")).toBe("4"));
    expect(activeLoad).toHaveBeenCalledWith(expect.objectContaining({ lat: 37, lng: -94, headingDeg: 90, speedMph: 55 }));
    expect(screen.getByTestId("nav-next").textContent).toMatch(/Head east on I-44/);
    const eta = screen.getByTestId("nav-eta");
    expect(eta.textContent).toMatch(/55 mi to Acme DC · ETA .* ET — past your drive clock by ~40 min/);
    expect(eta.getAttribute("role")).toBe("alert");
    expect(screen.getByText(/Trailer on this load — no U-turns/)).toBeTruthy();
    expect(screen.getByText(/Turns ahead \(2\)/)).toBeTruthy();
    expect(screen.queryByTestId("not-truck-legal")).toBeNull();
  });

  it("a car-only route is drawn but stamped NOT TRUCK-LEGAL, with no turn and no turn list", async () => {
    activeLoad.mockResolvedValue(state({ truckLegal: false, guidanceAllowed: false, notTruckLegalNotice: "NOT truck-legal: ...", providerName: "OSRM (car profile)", maneuvers: [] }));
    render(<HomePositionCard position={here()} headingDeg={90} speedMph={55} motion="moving" hero />);
    expect(await screen.findByTestId("not-truck-legal")).toBeTruthy();
    expect(screen.getByTestId("map").getAttribute("data-route-points")).toBe("4");
    expect(screen.queryByTestId("nav-next")).toBeNull();
    expect(screen.queryByText(/Turns ahead/)).toBeNull();
  });

  it("with a trailer, a route that needs a U-turn is not put on the map and he is told to keep going", async () => {
    activeLoad.mockResolvedValue(state({ maneuvers: [{ instruction: "Make a U-turn", distanceMiles: 0, atFraction: 0 }] }));
    render(<HomePositionCard position={here()} headingDeg={90} speedMph={55} motion="moving" hero />);
    expect((await screen.findByTestId("nav-notice")).textContent).toMatch(/starts with a U-turn - not with a trailer on/);
    expect(screen.getByTestId("map").getAttribute("data-route-points")).toBe("0");
    expect(screen.queryByTestId("nav-next")).toBeNull();
  });

  it("no route from the server = no line, and the plain reason is shown (nothing invented)", async () => {
    activeLoad.mockResolvedValue({ data: { ...state().data, route: null, routeUnavailableReason: "No routing service could be reached right now, so there is no route. Nothing was guessed." } });
    render(<HomePositionCard position={here()} hero />);
    expect(await screen.findByText(/Nothing was guessed/)).toBeTruthy();
    expect(screen.getByTestId("map").getAttribute("data-route-points")).toBe("0");
  });
});
