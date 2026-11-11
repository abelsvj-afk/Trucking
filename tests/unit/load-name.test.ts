// Trip numbers in load names (owner-confirmed format, 2026-11-10):
// "Trip 1874 · Panama City → Seminole" — trip number first, then the
// route — everywhere a load is named. A load without a trip number is
// named by its route alone: no placeholder, no stray separator.

import { describe, expect, it } from "vitest";
import { loadDisplayName, loadRoute } from "@/lib/load-name";

describe("loadDisplayName (owner format 2026-11-10)", () => {
  it("trip number first, then the route", () => {
    expect(
      loadDisplayName({ trip_number: "1874", origin: "Panama City", destination: "Seminole" }),
    ).toBe("Trip 1874 · Panama City → Seminole");
  });

  it("no trip number: the route alone, no placeholder", () => {
    expect(loadDisplayName({ trip_number: null, origin: "Panama City", destination: "Seminole" })).toBe(
      "Panama City → Seminole",
    );
    expect(loadDisplayName({ origin: "Panama City", destination: "Seminole" })).toBe("Panama City → Seminole");
    expect(loadDisplayName({ trip_number: "  ", origin: "Panama City", destination: "Seminole" })).toBe(
      "Panama City → Seminole",
    );
  });

  it("the route itself is origin → destination, exactly as stored", () => {
    expect(loadRoute({ origin: "Van Buren, AR", destination: "Fort Pierce, FL" })).toBe(
      "Van Buren, AR → Fort Pierce, FL",
    );
  });
});
