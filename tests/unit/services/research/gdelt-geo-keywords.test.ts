import { describe, expect, it } from "vitest";
import { matchGeoTopics, buildGdeltSignals } from "@/services/research/watchers/gdelt-geo";
import { matchTrackedTopics } from "@/services/research/watchers/types";

describe("gdelt-geo shipping/energy keywords", () => {
  it("real shipping headlines now land on a topic", () => {
    expect(matchGeoTopics("Tanker seized near Hormuz")).toContain("fuel");
    expect(matchGeoTopics("Red Sea attacks reroute container ship traffic")).toContain("market");
  });
  it("the shared matcher (industry news, Federal Register) is unchanged", () => {
    expect(matchTrackedTopics("Tanker seized near Hormuz")).toEqual([]);
  });
  it("four such headlines make a burst signal", () => {
    const articles = ["Tanker hit", "Tanker seized", "Hormuz tanker delays", "Refinery outage"].map((title, i) => ({ title, url: `https://x.example/${i}`, domain: "x.example", seenDate: null }));
    const out = buildGdeltSignals(articles, { newsBurstMinItems: 4 }, "2026-11-06T12:00:00Z");
    expect(out.map((s) => s.topic)).toEqual(["fuel"]);
  });
});
