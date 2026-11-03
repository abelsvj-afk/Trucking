// Paper-log reading (Image Intelligence §7.2/§7.4): the contract
// gate, and the code cross-checks that keep the model's word
// from being the last word - E1 (clean sheet reproduces the grid
// to the 15-minute step, totals matching), E2 (a blurred span
// stages the readable part only and stays partial), E3 (a segment
// under the 0.80 bar is absent from the staged set).

import { describe, expect, it } from "vitest";
import {
  analyzePaperLogDay,
  parsePaperLogExtraction,
  type PaperLogExtraction,
} from "@/services/ai/paper-log-extraction";

const CLEAN_DAY: PaperLogExtraction = {
  log_date: "2026-10-27",
  driver_name: "S. Smith",
  carrier_name: null,
  truck_number: "214",
  trailer_number: "T-118",
  segments: [
    { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
    { status: "on_duty", start: "06:00", end: "06:15", confidence: 0.98 },
    { status: "driving", start: "06:15", end: "12:00", confidence: 0.99 },
    { status: "on_duty", start: "12:00", end: "12:30", confidence: 0.97 },
    { status: "driving", start: "12:30", end: "17:30", confidence: 0.98 },
    { status: "off_duty", start: "17:30", end: "24:00", confidence: 0.99 },
  ],
  totals: { off_duty: 12.5, sleeper: null, driving: 10.75, on_duty: 0.75 },
  remarks: null,
  shipping_info: null,
  odometer_start: null,
  odometer_end: null,
  total_miles: null,
  unreadable: [],
};

describe("parsePaperLogExtraction", () => {
  it("accepts a contract-shaped read and rejects a malformed one", () => {
    expect(parsePaperLogExtraction(JSON.stringify(CLEAN_DAY)).segments).toHaveLength(6);
    expect(() => parsePaperLogExtraction(JSON.stringify({ ...CLEAN_DAY, segments: [{ status: "flying", start: "00:00", end: "01:00", confidence: 0.9 }] }))).toThrow();
    expect(() => parsePaperLogExtraction("not json")).toThrow();
  });
});

describe("analyzePaperLogDay", () => {
  it("E1: a clean sheet stages every segment unflagged, totals consistent, day complete", () => {
    const analysis = analyzePaperLogDay(CLEAN_DAY);
    expect(analysis.complete).toBe(true);
    expect(analysis.downgraded).toBe(false);
    expect(analysis.problems).toEqual([]);
    expect(analysis.dropped).toEqual([]);
    expect(analysis.missingSpans).toEqual([]);
    expect(analysis.staged).toHaveLength(6);
    expect(analysis.staged.every((s) => !s.flagged)).toBe(true);
    // The grid reproduces to the 15-minute step.
    expect(analysis.staged.map((s) => [s.startMin, s.endMin])).toEqual([
      [0, 360],
      [360, 375],
      [375, 720],
      [720, 750],
      [750, 1050],
      [1050, 1440],
    ]);
  });

  it("E2: a blurred span stages the readable part only - the span is missing, the day partial, no arithmetic blame", () => {
    const blurred: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "on_duty", start: "06:00", end: "06:15", confidence: 0.98 },
        { status: "driving", start: "06:15", end: "12:00", confidence: 0.99 },
        { status: "on_duty", start: "12:00", end: "12:30", confidence: 0.97 },
        { status: "driving", start: "12:30", end: "15:00", confidence: 0.98 },
        { status: "off_duty", start: "18:30", end: "24:00", confidence: 0.99 },
      ],
      unreadable: [{ description: "grid between 3 PM and 6:30 PM is washed out", start: "15:00", end: "18:30" }],
    };
    const analysis = analyzePaperLogDay(blurred);
    expect(analysis.complete).toBe(false);
    expect(analysis.problems).toEqual([]);
    expect(analysis.staged).toHaveLength(6);
    expect(analysis.staged.some((s) => s.startMin >= 900 && s.startMin < 1110)).toBe(false);
    expect(analysis.missingSpans).toEqual([{ startMin: 900, endMin: 1110, describedByReader: true }]);
  });

  it("E3: a segment under the 0.80 bar is dropped, never staged - and a 0.80-0.95 segment stages flagged", () => {
    const faint: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: CLEAN_DAY.segments.map((segment) =>
        segment.start === "12:30"
          ? { ...segment, confidence: 0.72 }
          : segment.start === "06:15"
            ? { ...segment, confidence: 0.88 }
            : segment,
      ),
    };
    const analysis = analyzePaperLogDay(faint);
    expect(analysis.dropped).toHaveLength(1);
    expect(analysis.dropped[0]).toMatchObject({ status: "driving", startMin: 750, endMin: 1050 });
    expect(analysis.staged.some((s) => s.startMin === 750)).toBe(false);
    const flagged = analysis.staged.find((s) => s.startMin === 375);
    expect(flagged?.flagged).toBe(true);
    expect(analysis.complete).toBe(false);
  });

  it("a totals mismatch downgrades the whole day to the flag tier (§7.4 day-level rule)", () => {
    const mismatch: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: { off_duty: 12.5, sleeper: null, driving: 5.0, on_duty: 0.75 },
    };
    const analysis = analyzePaperLogDay(mismatch);
    expect(analysis.downgraded).toBe(true);
    expect(analysis.problems.some((p) => p.includes("written driving total"))).toBe(true);
    expect(analysis.staged).toHaveLength(6);
    expect(analysis.staged.every((s) => s.flagged)).toBe(true);
    expect(analysis.complete).toBe(false);
  });

  it("an overlap is an arithmetic failure, not a partial day", () => {
    const overlap: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "05:30", end: "12:00", confidence: 0.99 },
        { status: "off_duty", start: "12:00", end: "24:00", confidence: 0.99 },
      ],
    };
    const analysis = analyzePaperLogDay(overlap);
    expect(analysis.downgraded).toBe(true);
    expect(analysis.problems.some((p) => p.includes("overlap"))).toBe(true);
  });

  it("an unexplained hole over an hour downgrades; the same hole named unreadable does not", () => {
    const hole: PaperLogExtraction = {
      ...CLEAN_DAY,
      totals: null,
      segments: [
        { status: "off_duty", start: "00:00", end: "06:00", confidence: 0.99 },
        { status: "driving", start: "09:00", end: "12:00", confidence: 0.99 },
        { status: "off_duty", start: "12:00", end: "24:00", confidence: 0.99 },
      ],
    };
    const unexplained = analyzePaperLogDay(hole);
    expect(unexplained.downgraded).toBe(true);
    expect(unexplained.missingSpans).toEqual([{ startMin: 360, endMin: 540, describedByReader: false }]);

    const explained = analyzePaperLogDay({
      ...hole,
      unreadable: [{ description: "morning grid smudged", start: "06:00", end: "09:00" }],
    });
    expect(explained.downgraded).toBe(false);
    expect(explained.complete).toBe(false);
    expect(explained.missingSpans).toEqual([{ startMin: 360, endMin: 540, describedByReader: true }]);
  });
});
