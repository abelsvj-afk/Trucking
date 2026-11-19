import { describe, expect, it } from "vitest";
import {
  isTurnManeuver,
  maneuverZoomTarget,
  MANEUVER_ZOOM_BOOST_CLOSE,
  MANEUVER_ZOOM_BOOST_FAR,
  MANEUVER_ZOOM_START_MILES,
} from "@/lib/drive-maneuver-zoom";

describe("maneuverZoomTarget (the map zooms in on turns)", () => {
  const base = 15;

  it("stays at follow zoom for straight-ahead and arrival", () => {
    expect(maneuverZoomTarget({ milesAway: 1, direction: "straight", baseZoom: base })).toBe(base);
    expect(maneuverZoomTarget({ milesAway: 1, direction: "arrive", baseZoom: base })).toBe(base);
  });

  it("stays at follow zoom farther out than the approach", () => {
    expect(
      maneuverZoomTarget({ milesAway: MANEUVER_ZOOM_START_MILES + 0.5, direction: "right", baseZoom: base }),
    ).toBe(base);
  });

  it("starts zooming in at the approach and zooms more close in", () => {
    const atStart = maneuverZoomTarget({ milesAway: MANEUVER_ZOOM_START_MILES, direction: "right", baseZoom: base });
    const mid = maneuverZoomTarget({ milesAway: 2.5, direction: "right", baseZoom: base });
    const close = maneuverZoomTarget({ milesAway: 0.5, direction: "right", baseZoom: base });
    expect(atStart).toBeCloseTo(base + MANEUVER_ZOOM_BOOST_FAR, 6);
    expect(mid).toBeGreaterThan(atStart);
    expect(close).toBeCloseTo(base + MANEUVER_ZOOM_BOOST_CLOSE, 6);
    expect(close).toBeGreaterThan(mid);
  });

  it("holds the closest zoom inside the close band, and eases back out once passed", () => {
    expect(maneuverZoomTarget({ milesAway: 0.1, direction: "left", baseZoom: base })).toBeCloseTo(
      base + MANEUVER_ZOOM_BOOST_CLOSE,
      6,
    );
    // A turn already behind him is the next maneuver's problem: this
    // one reports follow zoom, so the camera glides back out.
    expect(maneuverZoomTarget({ milesAway: -1, direction: "left", baseZoom: base })).toBe(base);
  });

  it("covers left, right, and U-turns", () => {
    expect(isTurnManeuver("left")).toBe(true);
    expect(isTurnManeuver("right")).toBe(true);
    expect(isTurnManeuver("uturn")).toBe(true);
    expect(isTurnManeuver("straight")).toBe(false);
    expect(isTurnManeuver("arrive")).toBe(false);
  });
});
