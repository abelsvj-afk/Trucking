import { describe, expect, it } from "vitest";
import { describeWarning, formatSequence, sequenceLoads, type SequenceLoad } from "@/lib/load-sequence";

const load = (id: string, origin: string, destination: string, pickup: string | null, delivery: string | null, status = "confirmed"): SequenceLoad => ({ id, origin, destination, status, pickup_date: pickup, delivery_date: delivery });

describe("sequenceLoads", () => {
  it("orders by pickup and finds nothing wrong with a clean run", () => {
    const s = sequenceLoads([
      load("b", "Tampa, FL", "Miami, FL", "2026-11-10", "2026-11-11"),
      load("a", "Macon, GA", "Tampa, FL", "2026-11-08", "2026-11-09"),
    ]);
    expect(s.rows.map((r) => r.load.id)).toEqual(["a", "b"]);
    expect(s.warnings).toEqual([]);
  });
  it("flags an overlap (the next pickup is before the last delivery)", () => {
    const s = sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-08", "2026-11-12"), load("b", "B, FL", "C, FL", "2026-11-10", "2026-11-13")]);
    expect(s.warnings).toEqual([{ kind: "overlap", before: "A, GA → B, FL", after: "B, FL → C, FL", days: 2 }]);
    expect(describeWarning(s.warnings[0]!)).toMatch(/Overlap: B, FL → C, FL starts 2 days BEFORE/);
  });
  it("flags a same-day turnaround and a long idle gap, but not a 1-2 day gap", () => {
    const same = sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-08", "2026-11-09"), load("b", "B, FL", "C, FL", "2026-11-09", "2026-11-10")]);
    expect(same.warnings.map((w) => w.kind)).toEqual(["same_day"]);
    const idle = sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-08", "2026-11-09"), load("b", "B, FL", "C, FL", "2026-11-13", "2026-11-14")]);
    expect(idle.warnings).toEqual([{ kind: "idle_gap", before: "A, GA → B, FL", after: "B, FL → C, FL", days: 4 }]);
    const ok = sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-08", "2026-11-09"), load("b", "B, FL", "C, FL", "2026-11-11", "2026-11-12")]);
    expect(ok.warnings).toEqual([]);
  });
  it("flags a deadhead when a load ends somewhere other than where the next one starts (city compared)", () => {
    const s = sequenceLoads([load("a", "A, GA", "Tampa, FL", "2026-11-08", "2026-11-09"), load("b", "Orlando, FL", "C, FL", "2026-11-10", "2026-11-11")]);
    expect(s.warnings).toEqual([{ kind: "deadhead", before: "A, GA → Tampa, FL", after: "Orlando, FL → C, FL", from: "Tampa, FL", to: "Orlando, FL" }]);
    const same = sequenceLoads([load("a", "A, GA", "TAMPA, fl", "2026-11-08", "2026-11-09"), load("b", "Tampa, FL", "C, FL", "2026-11-10", "2026-11-11")]);
    expect(same.warnings).toEqual([]);
  });
  it("a load with only one date is a one-day load; one with none is listed as undated", () => {
    const s = sequenceLoads([load("a", "A, GA", "B, FL", null, "2026-11-09"), load("n", "X, TX", "Y, TX", null, null)]);
    expect(s.rows[0]).toMatchObject({ start: "2026-11-09", end: "2026-11-09" });
    expect(s.undated.map((l) => l.id)).toEqual(["n"]);
  });
  it("a delivery dated before its pickup is treated as a one-day load, never a negative span", () => {
    expect(sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-09", "2026-11-05")]).rows[0]).toMatchObject({ start: "2026-11-09", end: "2026-11-09" });
  });
  it("formats the calendar in words, with the weekday, and says when all is well", () => {
    const text = formatSequence(sequenceLoads([load("a", "A, GA", "B, FL", "2026-11-08", "2026-11-09")]));
    expect(text).toContain("🚚 A, GA → B, FL (confirmed): Sunday, Nov 8, 2026 → Monday, Nov 9, 2026");
    expect(text).toContain("✅ No overlaps or problem gaps");
    expect(formatSequence({ rows: [], undated: [], warnings: [] })).toBe("No booked loads in that window.");
  });
});
