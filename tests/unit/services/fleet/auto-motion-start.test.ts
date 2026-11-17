// Owner 2026-11-17: the automatic Driving entry is backdated to when the truck STARTED moving (as an ELD
// does), never to before an entry already in the log.
import { describe, expect, it } from "vitest";
import { motionStartIso } from "@/services/fleet/auto-motion";
import { SUSTAIN_MS } from "@/lib/sustained-motion";

describe("the automatic Driving entry starts when the truck started moving", () => {
  it("detection (motion start + 60 s) minus the 60 s = motion start", () => {
    const start = Date.parse("2026-11-17T14:00:00Z");
    expect(motionStartIso(new Date(start + SUSTAIN_MS).toISOString(), "2026-11-17T12:00:00Z")).toBe("2026-11-17T14:00:00.000Z");
  });

  it("never before the latest entry already in the log", () => {
    expect(motionStartIso("2026-11-17T14:01:00Z", "2026-11-17T14:00:30Z")).toBe("2026-11-17T14:00:31.000Z");
  });
});
