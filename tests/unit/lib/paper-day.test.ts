import { describe, expect, it } from "vitest";
import {
  dayTotals,
  draftFromRead,
  moveBoundary,
  parseClock,
  removeSegment,
  setStatus,
  splitSegment,
  toDutyRows,
  validateDraft,
  type DraftSegment,
} from "@/lib/paper-day";

const h = (n: number) => n * 60;

describe("draftFromRead - every hole becomes explicit, never a silent extension", () => {
  it("a clean full day reads straight through and validates", () => {
    const d = draftFromRead(
      [
        { status: "off_duty", startMin: 0, endMin: h(6), confidence: 0.99 },
        { status: "on_duty", startMin: h(6), endMin: h(7), confidence: 0.97 },
        { status: "driving", startMin: h(7), endMin: h(16), confidence: 0.96 },
        { status: "off_duty", startMin: h(16), endMin: h(24), confidence: 0.98 },
      ],
      [],
    );
    expect(validateDraft(d).ok).toBe(true);
    expect(d.every((s) => s.origin === "clean")).toBe(true);
  });

  it("a dropped (low-confidence) stretch appears as a low segment that blocks saving until confirmed", () => {
    const d = draftFromRead(
      [
        { status: "on_duty", startMin: 0, endMin: h(10), confidence: 0.97 },
        { status: "off_duty", startMin: h(12), endMin: h(24), confidence: 0.97 },
      ],
      [{ status: "driving", startMin: h(10), endMin: h(12), confidence: 0.6 }],
    );
    expect(d.map((s) => s.origin)).toEqual(["clean", "low", "clean"]);
    const v = validateDraft(d);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("10:00–12:00");
    expect(validateDraft(setStatus(d, 1, "driving")).ok).toBe(true);
  });

  it("an unreadable hole becomes a 'missing' segment with no status - not the previous status", () => {
    const d = draftFromRead(
      [
        { status: "driving", startMin: 0, endMin: h(8), confidence: 0.97 },
        { status: "off_duty", startMin: h(9), endMin: h(24), confidence: 0.97 },
      ],
      [],
    );
    expect(d[1]).toMatchObject({ status: null, startMin: h(8), endMin: h(9), origin: "missing" });
    expect(validateDraft(d).errors.join(" ")).toContain("choose what you were doing");
  });

  it("a sheet read with nothing at all is one whole missing day", () => {
    const d = draftFromRead([], []);
    expect(d).toEqual([{ status: null, startMin: 0, endMin: h(24), confidence: null, origin: "missing" }]);
  });

  it("flagged (faint) segments are kept and marked, not blocked", () => {
    const d = draftFromRead([{ status: "sleeper", startMin: 0, endMin: h(24), confidence: 0.85, flagged: true }], []);
    expect(d[0]!.origin).toBe("flagged");
    expect(validateDraft(d).ok).toBe(true);
  });

  it("overlapping reads are clipped so the day still tiles", () => {
    const d = draftFromRead(
      [
        { status: "off_duty", startMin: 0, endMin: h(10), confidence: 0.99 },
        { status: "driving", startMin: h(9), endMin: h(24), confidence: 0.99 },
      ],
      [],
    );
    expect(d.map((s) => [s.startMin, s.endMin])).toEqual([
      [0, h(10)],
      [h(10), h(24)],
    ]);
  });
});

describe("validateDraft", () => {
  const seg = (status: DraftSegment["status"], a: number, b: number): DraftSegment => ({
    status,
    startMin: a,
    endMin: b,
    confidence: null,
    origin: "edited",
  });
  it("rejects gaps, overlaps and days that don't span 00:00-24:00", () => {
    expect(validateDraft([seg("off_duty", 0, h(10)), seg("driving", h(11), h(24))]).errors.join(" ")).toContain("not covered");
    expect(validateDraft([seg("off_duty", 0, h(12)), seg("driving", h(11), h(24))]).errors.join(" ")).toContain("overlaps");
    expect(validateDraft([seg("off_duty", h(1), h(24))]).errors.join(" ")).toContain("00:00");
    expect(validateDraft([seg("off_duty", 0, h(23))]).errors.join(" ")).toContain("24:00");
  });
});

describe("editing keeps the day tiled", () => {
  const base = draftFromRead(
    [
      { status: "off_duty", startMin: 0, endMin: h(8), confidence: 0.99 },
      { status: "driving", startMin: h(8), endMin: h(24), confidence: 0.99 },
    ],
    [],
  );
  it("moving a boundary (a status change mid-hour)", () => {
    const d = moveBoundary(base, 0, h(8) + 37);
    expect(validateDraft(d).ok).toBe(true);
    expect(d[0]!.endMin).toBe(h(8) + 37);
  });
  it("splitting then setting a status adds a change", () => {
    const d = setStatus(splitSegment(base, 1, h(12)), 2, "on_duty");
    expect(validateDraft(d).ok).toBe(true);
    expect(d.map((s) => s.status)).toEqual(["off_duty", "driving", "on_duty"]);
  });
  it("removing a segment gives its time to the previous one", () => {
    const d = removeSegment(splitSegment(base, 1, h(12)), 2);
    expect(validateDraft(d).ok).toBe(true);
    expect(d[1]!.endMin).toBe(h(24));
  });
});

describe("toDutyRows / dayTotals", () => {
  it("collapses same-status neighbours into one row each (sleeper split stays two rows)", () => {
    const d = draftFromRead(
      [
        { status: "sleeper", startMin: 0, endMin: h(5), confidence: 0.99 },
        { status: "sleeper", startMin: h(5), endMin: h(7), confidence: 0.99 },
        { status: "driving", startMin: h(7), endMin: h(12), confidence: 0.99 },
        { status: "sleeper", startMin: h(12), endMin: h(15), confidence: 0.99 },
        { status: "driving", startMin: h(15), endMin: h(24), confidence: 0.99 },
      ],
      [],
    );
    expect(toDutyRows(d)).toEqual([
      { status: "sleeper", startMin: 0 },
      { status: "driving", startMin: h(7) },
      { status: "sleeper", startMin: h(12) },
      { status: "driving", startMin: h(15) },
    ]);
    expect(dayTotals(d)).toMatchObject({ sleeper: h(10), driving: h(14), unresolved: 0 });
  });
  it("counts unresolved time separately, never in a status", () => {
    const d = draftFromRead([{ status: "driving", startMin: 0, endMin: h(4), confidence: 0.99 }], []);
    expect(dayTotals(d)).toMatchObject({ driving: h(4), unresolved: h(20) });
  });
  it("refuses to build rows from an unresolved day", () => {
    expect(() => toDutyRows(draftFromRead([], []))).toThrow();
  });
});

describe("parseClock", () => {
  it("accepts 00:00-24:00 only", () => {
    expect(parseClock("08:45")).toBe(525);
    expect(parseClock("24:00")).toBe(1440);
    expect(parseClock("24:15")).toBeNull();
    expect(parseClock("7:60")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });
});
