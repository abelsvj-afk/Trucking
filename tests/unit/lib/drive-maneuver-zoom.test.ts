// Maneuver zoom (owner 2026-11-18): ease in from a few miles out for
// turns and exits only — farther out for highway exits, closer in for
// tight turns — and ease back out after.
import { describe, expect, it } from "vitest";
import { EXIT_ZOOM, TURN_ZOOM, isTurnManeuver, maneuverZoomProfile, maneuverZoomTarget } from "@/lib/drive-maneuver-zoom";

const BASE = 15;

describe("maneuver zoom", () => {
  it("never zooms for straight-ahead or arrival", () => {
    expect(maneuverZoomTarget({ milesAway: 1, direction: "straight", instruction: "Continue on I-10 W", baseZoom: BASE })).toBe(BASE);
    expect(maneuverZoomTarget({ milesAway: 0.2, direction: "arrive", instruction: "Arrive at destination", baseZoom: BASE })).toBe(BASE);
    expect(isTurnManeuver("straight", "Stay on I-10 W")).toBe(false);
  });

  it("a highway exit starts at ~4.5 mi (the owner's example) — even worded without left/right", () => {
    expect(maneuverZoomProfile("Take exit 174 toward Tallahassee", "straight")).toBe(EXIT_ZOOM);
    expect(maneuverZoomTarget({ milesAway: 4.6, direction: "straight", instruction: "Take exit 174", baseZoom: BASE })).toBe(BASE);
    const start = maneuverZoomTarget({ milesAway: 4.4, direction: "straight", instruction: "Take exit 174", baseZoom: BASE });
    const close = maneuverZoomTarget({ milesAway: 0.3, direction: "straight", instruction: "Take exit 174", baseZoom: BASE });
    expect(start).toBeGreaterThan(BASE);
    expect(close).toBeCloseTo(BASE + EXIT_ZOOM.boostClose);
  });

  it("a tight street turn starts later (~1.5 mi) and zooms closer than an exit", () => {
    const instruction = "Turn right onto Main St";
    expect(maneuverZoomProfile(instruction, "right")).toBe(TURN_ZOOM);
    expect(maneuverZoomTarget({ milesAway: 3, direction: "right", instruction, baseZoom: BASE })).toBe(BASE);
    const close = maneuverZoomTarget({ milesAway: 0.1, direction: "right", instruction, baseZoom: BASE });
    expect(close).toBeCloseTo(BASE + TURN_ZOOM.boostClose);
    expect(TURN_ZOOM.boostClose).toBeGreaterThan(EXIT_ZOOM.boostClose);
  });

  it("eases in continuously as he closes, and back to base once passed", () => {
    const at = (m: number) => maneuverZoomTarget({ milesAway: m, direction: "right", instruction: "Take the ramp on the right", baseZoom: BASE });
    expect(at(3)).toBeGreaterThan(at(4));
    expect(at(1)).toBeGreaterThan(at(3));
    expect(at(-0.1)).toBe(BASE);
  });
});

describe("turns onto highways", () => {
  it("a turn onto a US/I/state highway gets the far-out approach (the owner's 'In 4.4 miles, turn right…')", () => {
    expect(maneuverZoomProfile("Turn right onto US-231", "right")).toBe(EXIT_ZOOM);
    expect(maneuverZoomProfile("Turn left onto I-75 N", "left")).toBe(EXIT_ZOOM);
    expect(maneuverZoomProfile("Turn left onto Oak Ave", "left")).toBe(TURN_ZOOM);
  });
});
