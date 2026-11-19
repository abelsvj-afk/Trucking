import { describe, expect, it } from "vitest";
import { routeDirection, speedTone, wherePillLines } from "@/lib/drive-where";
import { formatRef, pickPlaceHere, pickRoadHere } from "@/services/integrations/osm-where";

describe("where-am-I pill (2026-11-19)", () => {
  it("names the direction the way drivers do: even routes E/W, odd N/S", () => {
    expect(routeDirection("I-10", 265)).toBe("W");
    expect(routeDirection("I-75", 10)).toBe("N");
    expect(routeDirection("US-231", 180)).toBe("S");
    expect(routeDirection(null, 90)).toBeNull();
  });
  it("shows only what is known — no mile marker is never guessed", () => {
    expect(wherePillLines({ roadRef: "I-10", roadName: null, mileMarker: "245", town: "Greenville", state: "FL" }, 270)).toEqual({ top: "I-10 W · MM245", bottom: "Greenville · FL" });
    expect(wherePillLines({ roadRef: "I-10", roadName: null, mileMarker: null, town: null, state: "FL" }, 270)).toEqual({ top: "I-10 W", bottom: "FL" });
  });
  it("speed is orange over the limit, red 10+ over", () => {
    expect(speedTone(70, 70)).toBe("normal");
    expect(speedTone(74, 70)).toBe("over");
    expect(speedTone(81, 70)).toBe("well_over");
  });
});

describe("osm-where pickers", () => {
  const here = { lat: 30.5, lng: -83.6 };
  const json = {
    elements: [
      { type: "way", id: 1, tags: { highway: "motorway", ref: "I 10", name: "Interstate 10" }, geometry: [{ lat: 30.5, lon: -83.61 }, { lat: 30.5, lon: -83.59 }] },
      { type: "node", id: 2, lat: 30.5, lon: -83.598, tags: { highway: "milestone", distance: "245", "highway:ref": "I 10" } },
      { type: "node", id: 3, lat: 30.5, lon: -83.6005, tags: { highway: "milestone", distance: "12", "highway:ref": "US 221" } },
    ],
  };
  it("reads the road ref and the nearest milestone ON THAT ROAD", () => {
    expect(formatRef("I 10;US 90")).toBe("I-10");
    expect(pickRoadHere(json, here, 270)).toEqual({ ref: "I-10", name: "Interstate 10", mileMarker: "245" });
  });
  it("a cross street (wrong heading) is not the road", () => {
    expect(pickRoadHere(json, here, 0)).toBeNull();
  });
  it("reads town and two-letter state; anything odd is null", () => {
    expect(pickPlaceHere({ address: { town: "Greenville", "ISO3166-2-lvl4": "US-FL" } })).toEqual({ town: "Greenville", state: "FL" });
    expect(pickPlaceHere({ nope: 1 })).toEqual({ town: null, state: null });
  });
});
