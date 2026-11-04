// GAP-03: place matching — conservative, normalized name+city.

import { describe, expect, it } from "vitest";
import { facilityKey, matchFacility, normalizePlaceText, splitPlaceText } from "@/lib/facilities";

describe("normalizePlaceText / facilityKey", () => {
  it("ignores case, punctuation, and spacing", () => {
    expect(normalizePlaceText("  Tyson  Foods, Inc. ")).toBe("tyson foods inc");
    expect(facilityKey("Tyson Foods", "Wildwood")).toBe(facilityKey("tyson foods", "wildwood"));
  });
});

describe("matchFacility", () => {
  const facilities = [
    { id: "f1", name: "Tyson Foods", city: "Wildwood" },
    { id: "f2", name: "Tyson Foods", city: "Springdale" },
  ];
  it("matches on name + city", () => {
    expect(matchFacility(facilities, "tyson foods", "Wildwood")?.id).toBe("f1");
  });
  it("does not merge two yards that share a name", () => {
    expect(matchFacility(facilities, "Tyson Foods", "Ocala")).toBeNull();
  });
});

describe("splitPlaceText", () => {
  it("splits a 'Name, City ST' origin string", () => {
    expect(splitPlaceText("Tyson Foods, Wildwood FL")).toEqual({
      name: "Tyson Foods",
      city: "Wildwood",
      state: "FL",
    });
  });
  it("leaves a bare string as the name", () => {
    expect(splitPlaceText("Atlanta")).toEqual({ name: "Atlanta", city: null, state: null });
  });
});
