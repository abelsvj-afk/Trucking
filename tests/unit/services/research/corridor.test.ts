import { describe, expect, it } from "vitest";
import { deriveCorridorStates, parseStateCode } from "@/services/research/corridor";

describe("parseStateCode", () => {
  it("reads the comma form, trailing code, and ZIP forms", () => {
    expect(parseStateCode("Melbourne, FL")).toBe("FL");
    expect(parseStateCode("Atlanta, GA 30303")).toBe("GA");
    expect(parseStateCode("Dallas TX 75201")).toBe("TX");
    expect(parseStateCode("Jacksonville FL")).toBe("FL");
  });

  it("reads full state names, longest match wins", () => {
    expect(parseStateCode("Savannah, Georgia")).toBe("GA");
    expect(parseStateCode("Charlotte, North Carolina")).toBe("NC");
    expect(parseStateCode("West Virginia")).toBe("WV");
  });

  it("returns null for unparseable places instead of guessing", () => {
    expect(parseStateCode("Somewhere")).toBeNull();
    expect(parseStateCode("")).toBeNull();
    expect(parseStateCode(null)).toBeNull();
    expect(parseStateCode(undefined)).toBeNull();
  });
});

describe("deriveCorridorStates", () => {
  it("unions origin and destination states, deduped", () => {
    expect(deriveCorridorStates("Melbourne, FL", "Atlanta, GA")).toEqual(["FL", "GA"]);
    expect(deriveCorridorStates("Orlando, FL", "Tampa, FL")).toEqual(["FL"]);
    expect(deriveCorridorStates("Unknown", "Atlanta, GA")).toEqual(["GA"]);
    expect(deriveCorridorStates("Unknown", "Nowhere")).toEqual([]);
  });
});
