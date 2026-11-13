// Timezone transitions (owner order 2026-11-11): the live-location
// proposal, the auto-switch notice, and the staged summary all render
// in the zone of the FIX — the truck's zone — with a label. Tonight's
// incident was a Nov 8 duty proposal surfaced as if current, its time
// quoted as raw UTC; no touched path may do that again (TZ-D).
// A zone change mid-drive is announced plainly ONCE.

import { describe, expect, it, vi } from "vitest";
import { handleLiveLocation, proposalText, type LiveLocationStore, type StoredPosition } from "@/services/telegram/live-location";
import { formatClock, timeZoneForPosition } from "@/lib/display-zone";
import type { DutyStatus } from "@/types/entities";

const miles = (m: number) => m / 69.05;
// 60 mph northbound, one fix every 30 s, starting near Rayville, LA (CT).
const atCt = (i: number) => ({ latitude: 32.4648 + miles(0.5 * i), longitude: -91.795, horizontal_accuracy: 10 });
// Same drive near Atlanta, GA (ET).
const atEt = (i: number) => ({ latitude: 33.75 + miles(0.5 * i), longitude: -84.39, horizontal_accuracy: 10 });
const T0 = 1_800_000_000_000; // 2027-01-15T08:00:00Z — January, CST/EST

function memStore(status: DutyStatus | null) {
  let pos: StoredPosition | null = null;
  const staged: { sinceIso: string; status: string; summary: string }[] = [];
  const store: LiveLocationStore = {
    loadPosition: async () => pos,
    savePosition: async (p) => void (pos = p),
    loadCurrentStatus: async () => status,
    stageProposal: async (proposal, sinceIso, summary) => {
      staged.push({ sinceIso, status: proposal.status, summary });
      return null;
    },
  };
  return { store, staged, get pos() { return pos; } };
}

// The formatter the two routes now pass: the fix's own zone, labeled.
const zoneFormatTime = (ms: number, lat: number, lng: number) =>
  formatClock(ms, timeZoneForPosition(lat, lng));
const deps = () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), formatTime: zoneFormatTime });

describe("live-location proposal in the fix's zone", () => {
  it("a Central fix proposes with a CT label, never ET, never raw UTC", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 6; i++) await handleLiveLocation(m.store, atCt(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    const text = d.sendMessage.mock.calls[0]![0] as string;
    expect(text).toContain("2:00 AM CT"); // movement began T0+30s = 08:00:30Z = 2:00:30 AM CST
    expect(text).not.toContain("ET");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // The staged summary is what gets quoted back to him later — it
    // must carry the same labeled time, never the raw ISO.
    expect(m.staged[0]!.summary).toContain("2:00 AM CT");
    expect(m.staged[0]!.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("an Eastern fix proposes with an ET label", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 6; i++) await handleLiveLocation(m.store, atEt(i), T0 + i * 30_000, d);
    const text = d.sendMessage.mock.calls[0]![0] as string;
    expect(text).toContain("3:00 AM ET"); // 08:00:30Z = 3:00:30 AM EST
    expect(text).not.toContain("CT");
  });

  it("proposalText itself carries the label it is given", () => {
    const t = proposalText({ kind: "start_driving", status: "driving", sinceMs: 0 }, "7:40 AM CT");
    expect(t).toContain("Proposed: log Driving from 7:40 AM CT");
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("zone-change announcement — once per crossing", () => {
  it("announces the crossing once when fixes move Central -> Eastern, then stays quiet", async () => {
    const m = memStore("driving"); // already driving: no proposals, no auto-switch
    const d = deps();
    // Birmingham, AL (CT) -> Atlanta, GA (ET): one fix each side of the line.
    await handleLiveLocation(m.store, { latitude: 33.52, longitude: -86.8, horizontal_accuracy: 10 }, T0, d);
    await handleLiveLocation(m.store, { latitude: 33.75, longitude: -84.39, horizontal_accuracy: 10 }, T0 + 300_000, d);
    await handleLiveLocation(m.store, { latitude: 33.8, longitude: -84.3, horizontal_accuracy: 10 }, T0 + 600_000, d);
    const crossings = d.sendMessage.mock.calls.filter((c) => String(c[0]).includes("Crossed into Eastern"));
    expect(crossings).toHaveLength(1);
    expect(String(crossings[0]![0])).toBe("Crossed into Eastern — times below are ET.");
  });

  it("says nothing when the zone never changes", async () => {
    const m = memStore("driving");
    const d = deps();
    for (let i = 0; i <= 3; i++) await handleLiveLocation(m.store, atCt(i), T0 + i * 30_000, d);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });
});

describe("auto-switch notice in the fix's zone", () => {
  it("tells him in Central time when the truck is in Central", async () => {
    const m = memStore("off_duty");
    const startedAt = new Date(T0 + 30_000 + 60_000).toISOString(); // detection = move start + 60 s
    const d = {
      ...deps(),
      autoSwitch: vi.fn(async () => ({ switched: true, startedAt })),
    };
    for (let i = 0; i <= 6; i++) await handleLiveLocation(m.store, atCt(i), T0 + i * 30_000, d);
    const notice = d.sendMessage.mock.calls[0]![0] as string;
    expect(notice).toContain("Switched to Driving at 2:01 AM CT");
    expect(notice).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
