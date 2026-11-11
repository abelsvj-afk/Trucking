// Audit 2026-11-11: "today" must be the owner's Eastern day. `new Date().toISOString().slice(0, 10)` is the UTC date - after 7 PM
// (8 PM in summer) Eastern it is already TOMORROW, so an expense, a maintenance "done today", a fund entry or a pay pin logged in the
// evening was dated the next day. This scan keeps that pattern out of the source; use todayEastern() / startOfTodayEasternIso().
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startOfTodayEasternIso, todayEastern } from "@/lib/eastern-date";

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });

describe("today is the Eastern day, never the UTC day", () => {
  it("no source file takes today's date from a UTC ISO string", () => {
    const offenders = walk("src").filter((f) => /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("at 9 PM Eastern it is still today, though UTC says tomorrow", () => {
    const evening = new Date("2026-11-11T02:00:00Z"); // 9:00 PM Eastern on Nov 10
    expect(evening.toISOString().slice(0, 10)).toBe("2026-11-11");
    expect(todayEastern(evening)).toBe("2026-11-10");
  });
  it("the Eastern day starts at Eastern midnight, in winter and in summer", () => {
    expect(startOfTodayEasternIso(new Date("2026-11-11T02:00:00Z"))).toBe("2026-11-10T05:00:00.000Z"); // EST
    expect(startOfTodayEasternIso(new Date("2026-07-04T02:00:00Z"))).toBe("2026-07-03T04:00:00.000Z"); // EDT
    expect(startOfTodayEasternIso(new Date("2026-03-08T12:00:00Z"))).toBe("2026-03-08T05:00:00.000Z"); // spring-forward day starts in EST
    expect(startOfTodayEasternIso(new Date("2026-11-01T12:00:00Z"))).toBe("2026-11-01T04:00:00.000Z"); // fall-back day starts in EDT
  });
});
