import { describe, expect, it } from "vitest";
import { maneuverAnnouncement, FAR_MILES, NEAR_MILES } from "@/lib/drive-maneuver-speech";

const m = (instruction: string, atFraction = 0.5) => ({ instruction, distanceMiles: 1, atFraction }) as never;

describe("maneuverAnnouncement (spoken turns)", () => {
  const turn = m("Turn right onto US-231.");

  it("says nothing while the turn is far away or when there is no maneuver", () => {
    expect(maneuverAnnouncement(null, new Set())).toBeNull();
    expect(maneuverAnnouncement({ maneuver: turn, milesAway: FAR_MILES + 0.1 }, new Set())).toBeNull();
  });

  it("announces about half a mile out, in words, once", () => {
    const spoken = new Set<string>();
    const a = maneuverAnnouncement({ maneuver: turn, milesAway: 0.5 }, spoken)!;
    expect(a.line).toBe("In half a mile, turn right onto US-231.");
    a.keys.forEach((k) => spoken.add(k));
    expect(maneuverAnnouncement({ maneuver: turn, milesAway: 0.45 }, spoken)).toBeNull();
  });

  it("announces again close in - plainly - and never repeats that either", () => {
    const spoken = new Set<string>();
    maneuverAnnouncement({ maneuver: turn, milesAway: 0.5 }, spoken)!.keys.forEach((k) => spoken.add(k));
    const near = maneuverAnnouncement({ maneuver: turn, milesAway: 0.1 }, spoken)!;
    expect(near.line).toBe("Turn right onto US-231.");
    near.keys.forEach((k) => spoken.add(k));
    expect(maneuverAnnouncement({ maneuver: turn, milesAway: 0.05 }, spoken)).toBeNull();
  });

  it("a turn first seen already close says only the close line - never a stale 'in half a mile'", () => {
    const spoken = new Set<string>();
    const a = maneuverAnnouncement({ maneuver: turn, milesAway: NEAR_MILES - 0.05 }, spoken)!;
    expect(a.line).toBe("Turn right onto US-231.");
    a.keys.forEach((k) => spoken.add(k));
    expect(maneuverAnnouncement({ maneuver: turn, milesAway: 0.4 }, spoken)).toBeNull();
  });

  it("uses distance words for longer leads, and treats each maneuver separately", () => {
    expect(maneuverAnnouncement({ maneuver: m("Merge onto I-75."), milesAway: 0.58 }, new Set())!.line).toContain("half a mile");
    expect(maneuverAnnouncement({ maneuver: m("Keep left."), milesAway: 0.3 }, new Set())!.line).toContain("a quarter mile");
    const spoken = new Set<string>();
    maneuverAnnouncement({ maneuver: turn, milesAway: 0.5 }, spoken)!.keys.forEach((k) => spoken.add(k));
    expect(maneuverAnnouncement({ maneuver: m("Turn left onto Main St.", 0.7), milesAway: 0.5 }, spoken)).not.toBeNull();
  });

  it("ignores an empty instruction rather than speaking nothing useful", () => {
    expect(maneuverAnnouncement({ maneuver: m("  "), milesAway: 0.3 }, new Set())).toBeNull();
  });
});
