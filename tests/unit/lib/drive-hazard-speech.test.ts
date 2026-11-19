import { describe, expect, it } from "vitest";
import { roadWorkCallout } from "@/lib/drive-hazard-speech";
import { buildRouteMeasure, stretchAlong } from "@/lib/route-measure";

describe("road work spoken ahead of time (2026-11-19)", () => {
  it("says the live distance with one decimal", () => {
    expect(roadWorkCallout(1.84, "Road work: lane closure")).toBe("Road work ahead in 1.8 miles.");
    expect(roadWorkCallout(0.2, "Road work: lane closure")).toBe("Road work just ahead.");
  });
  it("warns when a posted restriction is over his truck", () => {
    expect(roadWorkCallout(1.5, "Road work — restriction over your truck: 13 ft 0 in")).toContain("posted restriction your truck is over");
  });
});

describe("hazard stretches cut in road miles", () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));
  it("cuts exactly the stretch asked for, on the road-miles scale", () => {
    // line is 10 line-miles; the road is 20 — mile 10-12 of road is line mile 5-6
    const m = buildRouteMeasure([{ geometry: line, roadMiles: 20 }]);
    const s = stretchAlong(m, 10, 12);
    expect(s[0]!.lat).toBeCloseTo(30 + 5 * 0.01449, 4);
    expect(s[s.length - 1]!.lat).toBeCloseTo(30 + 6 * 0.01449, 4);
    expect(stretchAlong(m, 12, 12)).toEqual([]);
  });
});
