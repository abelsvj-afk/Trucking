import { describe, expect, it } from "vitest";
import { buildWeatherSection, type WeatherFetchers } from "@/services/smart-path/route-weather";

const NOW = new Date("2026-11-06T12:00:00Z");
const point = (mile: number, etaAt: string | null = "2026-11-06T15:00:00Z") => ({ mile, lat: 30 + mile / 100, lng: -90, etaAt });
const windy = [{ startTime: "2026-11-06T14:00:00Z", endTime: "2026-11-06T16:00:00Z", windMph: 40, gustMph: null, shortForecast: "Windy", precipChancePct: 0, tempF: 60 }];

describe("buildWeatherSection", () => {
  it("is unavailable, not clear, when nothing can be timed", async () => {
    const s = await buildWeatherSection([point(0, null)], { hourly: async () => [], alerts: async () => [] }, NOW);
    expect(s.status).toBe("unavailable");
    expect(s.notes[0]).toContain("could not be timed");
  });
  it("reports warnings and how many spots were checked", async () => {
    const f: WeatherFetchers = { hourly: async () => windy, alerts: async () => [] };
    const s = await buildWeatherSection([point(0), point(10)], f, NOW);
    expect(s.status).toBe("ok");
    expect(s.items).toHaveLength(1); // merged into one stretch
    expect(s.items[0]!.endMile).toBe(10);
    expect(s.notes[0]).toContain("Checked 2 of 2");
  });
  it("says partial when some spots fail and names it", async () => {
    let n = 0;
    const f: WeatherFetchers = { hourly: async () => { if (n++ === 0) throw new Error("503"); return windy; }, alerts: async () => [] };
    const s = await buildWeatherSection([point(0), point(500)], f, NOW);
    expect(s.status).toBe("partial");
    expect(s.notes.join(" ")).toContain("could not be checked");
  });
  it("is unavailable when every spot fails", async () => {
    const s = await buildWeatherSection([point(0)], { hourly: async () => { throw new Error("x"); }, alerts: async () => [] }, NOW);
    expect(s.status).toBe("unavailable");
    expect(s.items).toEqual([]);
  });
  it("samples at most 12 spots", async () => {
    let calls = 0;
    const many = Array.from({ length: 50 }, (_, i) => point(i * 10));
    await buildWeatherSection(many, { hourly: async () => { calls++; return []; }, alerts: async () => [] }, NOW);
    expect(calls).toBe(12);
  });
});
