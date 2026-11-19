// Location voice notes — the owner's rules (2026-11-19).
import { describe, expect, it } from "vitest";
import {
  clearThreshold,
  expiresAtFor,
  freshnessLabel,
  hasPassed,
  isDoneForViewer,
  isLive,
  notesForViewer,
  PASS_FALLBACK_MS,
  stackVoiceNotes,
  type VoiceNoteRecord,
} from "@/lib/voice-notes";

const T = 1_800_000_000_000;
const note = (over: Partial<VoiceNoteRecord> = {}): VoiceNoteRecord => ({
  id: "n1",
  authorId: "author",
  kind: "hazard",
  point: { lat: 30, lng: -82 },
  headingDeg: 0,
  roadRef: "I-75",
  durationS: 8,
  createdAtMs: T,
  expiresAtMs: null,
  removedAtMs: null,
  goneReports: 0,
  badReports: 0,
  listenedAtMs: null,
  passedAtMs: null,
  reportedByMe: false,
  ...over,
});

describe("lifetime by type", () => {
  it("traffic 2 h, road work 7 days, tip 30 days, bridge / hazard until cleared", () => {
    expect(expiresAtFor("traffic", T)).toBe(T + 2 * 3_600_000);
    expect(expiresAtFor("roadwork", T)).toBe(T + 7 * 86_400_000);
    expect(expiresAtFor("tip", T)).toBe(T + 30 * 86_400_000);
    expect(expiresAtFor("bridge", T)).toBeNull();
    expect(expiresAtFor("hazard", T)).toBeNull();
  });
  it("an expired note is gone for everyone", () => {
    expect(isLive(note({ kind: "traffic", expiresAtMs: T + 1 }), 1, T + 2)).toBe(false);
  });
});

describe("clearing a hazard that's gone — gated by fleet size", () => {
  it("1 report while the company is 1–3, 2 at 4–20, 3 after that", () => {
    expect(clearThreshold(1)).toBe(1);
    expect(clearThreshold(3)).toBe(1);
    expect(clearThreshold(4)).toBe(2);
    expect(clearThreshold(20)).toBe(2);
    expect(clearThreshold(21)).toBe(3);
  });
  it("one report does not wipe a warning once the fleet has grown", () => {
    expect(isLive(note({ goneReports: 1 }), 10, T)).toBe(true);
    expect(isLive(note({ goneReports: 2 }), 10, T)).toBe(false);
    expect(isLive(note({ badReports: 1 }), 2, T)).toBe(false);
  });
});

describe("done for this driver", () => {
  it("listened AND passed", () => {
    expect(isDoneForViewer(note({ listenedAtMs: T }), T + 1)).toBe(false);
    expect(isDoneForViewer(note({ listenedAtMs: T, passedAtMs: T + 5 }), T + 6)).toBe(true);
    expect(isDoneForViewer(note({ passedAtMs: T }), T + 6)).toBe(false); // passed but never listened: still shakes
  });
  it("listened, pass never detected: clears 30 min after listening", () => {
    expect(isDoneForViewer(note({ listenedAtMs: T }), T + PASS_FALLBACK_MS - 1)).toBe(false);
    expect(isDoneForViewer(note({ listenedAtMs: T }), T + PASS_FALLBACK_MS)).toBe(true);
  });
  it("never pesters its own author; stays for the next driver", () => {
    const n = note({ listenedAtMs: T, passedAtMs: T });
    expect(notesForViewer([note()], "author", 1, T)).toEqual([]);
    expect(notesForViewer([note()], "driver2", 1, T)).toHaveLength(1);
    // done for driver2 (his own state) — the record for driver3 has no state, so it shows
    expect(notesForViewer([n], "driver2", 1, T + 1)).toEqual([]);
    expect(notesForViewer([note()], "driver3", 1, T + 1)).toHaveLength(1);
  });
});

describe("passed the spot", () => {
  const n = { point: { lat: 30, lng: -82 }, headingDeg: 0 }; // northbound
  it("near earlier, now 0.1+ mi beyond it going the same way", () => {
    expect(hasPassed(n, { point: { lat: 30 + 0.12 / 69.09, lng: -82 }, headingDeg: 2 }, true)).toBe(true);
    expect(hasPassed(n, { point: { lat: 30 + 0.05 / 69.09, lng: -82 }, headingDeg: 2 }, true)).toBe(false);
  });
  it("going the other way, or never near it, is not a pass", () => {
    expect(hasPassed(n, { point: { lat: 30 + 0.12 / 69.09, lng: -82 }, headingDeg: 180 }, true)).toBe(false);
    expect(hasPassed(n, { point: { lat: 30 + 0.12 / 69.09, lng: -82 }, headingDeg: 0 }, false)).toBe(false);
  });
});

describe("duplicates stack", () => {
  it("same kind, same way, within 0.2 mi → one bubble, newest first", () => {
    const stacks = stackVoiceNotes([
      note({ id: "old", createdAtMs: T }),
      note({ id: "new", createdAtMs: T + 60_000, point: { lat: 30.001, lng: -82 } }),
      note({ id: "tip", kind: "tip" }),
      note({ id: "south", headingDeg: 180 }),
    ]);
    expect(stacks).toHaveLength(3);
    expect(stacks.find((s) => s.lead.id === "new")!.notes.map((x) => x.id)).toEqual(["new", "old"]);
  });
  it("shows freshness", () => {
    expect(freshnessLabel(T, T + 30_000)).toBe("just now");
    expect(freshnessLabel(T, T + 12 * 60_000)).toBe("12 min ago");
    expect(freshnessLabel(T, T + 3 * 3_600_000)).toBe("3 h ago");
    expect(freshnessLabel(T, T + 3 * 86_400_000)).toBe("3 days ago");
  });
});
