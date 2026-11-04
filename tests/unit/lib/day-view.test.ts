import { describe, expect, it } from "vitest";
import { buildDayView, deleteConsequence, enteredAfterTheFact, startTimeBounds, type DayRow } from "@/lib/day-view";

const D0 = Date.parse("2026-11-03T05:00:00Z"); // 00:00 New York
const D1 = Date.parse("2026-11-04T05:00:00Z");
const H = 3_600_000;
const at = (ms: number) => new Date(ms).toISOString();
const row = (id: string, duty_status: DayRow["duty_status"], ms: number, extra: Partial<DayRow> = {}): DayRow => ({
  id,
  duty_status,
  started_at: at(ms),
  ...extra,
});

describe("buildDayView", () => {
  it("shows the status carried in from yesterday, then each change, to midnight", () => {
    const rows = [row("a", "sleeper", D0 - 4 * H), row("b", "driving", D0 + 6 * H), row("c", "off_duty", D0 + 16 * H)];
    const v = buildDayView(rows, D0, D1, D1 + 5 * H);
    expect(v.stretches.map((s) => [s.status, s.startMin, s.endMin, s.carriedIn])).toEqual([
      ["sleeper", 0, 360, true],
      ["driving", 360, 960, false],
      ["off_duty", 960, 1440, false],
    ]);
    expect(v.totals).toEqual({ off_duty: 480, sleeper: 360, driving: 600, on_duty: 0 });
  });

  it("today stops at now - the future is not drawn", () => {
    const rows = [row("a", "off_duty", D0 - H), row("b", "driving", D0 + 8 * H)];
    const v = buildDayView(rows, D0, D1, D0 + 10 * H);
    expect(v.stretches.at(-1)).toMatchObject({ status: "driving", endMin: 600, ongoing: true });
    expect(v.totals.driving).toBe(120);
  });

  it("before the first row ever logged, nothing is drawn (unknown stays blank)", () => {
    const v = buildDayView([row("a", "on_duty", D0 + 9 * H)], D0, D1, D1 + H);
    expect(v.stretches).toHaveLength(1);
    expect(v.stretches[0]!.startMin).toBe(540);
  });

  it("a row that runs past midnight is cut at the day boundary for display only", () => {
    const rows = [row("a", "driving", D0 + 22 * H), row("b", "off_duty", D1 + 2 * H)];
    const v = buildDayView(rows, D0, D1, D1 + 5 * H);
    expect(v.stretches).toEqual([
      { status: "driving", startMin: 1320, endMin: 1440, rowIndex: 0, carriedIn: false, ongoing: false },
    ]);
  });

  it("a day with no rows at all is empty", () => {
    expect(buildDayView([], D0, D1, D1).stretches).toEqual([]);
  });
});

describe("edit rules", () => {
  const rows = [row("a", "off_duty", D0), row("b", "driving", D0 + 6 * H), row("c", "on_duty", D0 + 9 * H)];
  it("a start time can move only between its neighbours, and never past now", () => {
    expect(startTimeBounds(rows, 1, D1)).toEqual({ minMs: D0 + 60_000, maxMs: D0 + 9 * H - 60_000 });
    expect(startTimeBounds(rows, 2, D0 + 10 * H).maxMs).toBe(D0 + 10 * H);
  });
  it("deleting a row says which status runs on, and until when", () => {
    expect(deleteConsequence(rows, 1)).toEqual({ previous: "off_duty", untilIso: rows[2]!.started_at });
    expect(deleteConsequence(rows, 0)).toEqual({ previous: null, untilIso: rows[1]!.started_at });
  });
  it("flags rows saved well after the time they claim", () => {
    expect(enteredAfterTheFact(row("x", "driving", D0, { created_at: at(D0 + 2 * H) }))).toBe(true);
    expect(enteredAfterTheFact(row("x", "driving", D0, { created_at: at(D0 + 60_000) }))).toBe(false);
  });
});
