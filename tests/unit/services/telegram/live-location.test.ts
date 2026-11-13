import { describe, expect, it, vi } from "vitest";
import { handleLiveLocation, proposalText, type LiveLocationStore, type StoredPosition } from "@/services/telegram/live-location";
import { describeFixAge, MOVING_PROPOSAL_AFTER_MS, PROPOSAL_COOLDOWN_MS } from "@/lib/live-motion";
import type { DutyStatus } from "@/types/entities";

const miles = (m: number) => m / 69.05;
function memStore(status: DutyStatus | null) {
  let pos: StoredPosition | null = null;
  const staged: { sinceIso: string; status: string }[] = [];
  const store: LiveLocationStore = {
    loadPosition: async () => pos,
    savePosition: async (p) => void (pos = p),
    loadCurrentStatus: async () => status,
    stageProposal: async (proposal, sinceIso) => {
      staged.push({ sinceIso, status: proposal.status });
      return null;
    },
    hasWaitingDutyProposal: async (s, sinceIso) => staged.some((p) => p.status === s && p.sinceIso === sinceIso),
  };
  return { store, staged, get pos() { return pos; } };
}
const deps = () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), formatTime: (ms: number) => `t${ms}` });
// 60 mph northbound, one fix every 30 s.
const at = (i: number) => ({ latitude: 28 + miles(0.5 * i), longitude: -81.7, horizontal_accuracy: 10 });
const T0 = 1_800_000_000_000;

describe("handleLiveLocation", () => {
  it("records the fix, derives speed from the previous one, and proposes Driving since the movement began", async () => {
    const m = memStore("off_duty");
    const d = deps();
    let last;
    for (let i = 0; i <= 6; i++) last = await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    // movement began at the second fix (first with a speed), not when the proposal fired
    expect(m.staged[0]).toEqual({ sinceIso: new Date(T0 + 30_000).toISOString(), status: "driving" });
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage.mock.calls[0]![0]).toContain(`t${T0 + 30_000}`);
    expect(last).toMatchObject({ kind: "recorded" });
    expect(m.pos!.speedMph!).toBeGreaterThan(50);
  });

  it("does not repeat inside the cooldown", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 12; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    expect(MOVING_PROPOSAL_AFTER_MS).toBeLessThan(PROPOSAL_COOLDOWN_MS);
  });

  it("proposes nothing when the log already says Driving", async () => {
    const m = memStore("driving");
    const d = deps();
    for (let i = 0; i <= 8; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(0);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores an out-of-order or duplicate fix and an invalid position", async () => {
    const m = memStore("off_duty");
    const d = deps();
    await handleLiveLocation(m.store, at(1), T0 + 30_000, d);
    expect(await handleLiveLocation(m.store, at(0), T0, d)).toEqual({ kind: "ignored" });
    expect(await handleLiveLocation(m.store, at(1), T0 + 30_000, d)).toEqual({ kind: "ignored" });
    expect(await handleLiveLocation(m.store, { latitude: 91, longitude: 0 }, T0 + 90_000, d)).toEqual({ kind: "ignored" });
  });

  it("stages BEFORE it tells him, and the cooldown is saved even if the send fails", async () => {
    const m = memStore("off_duty");
    const d = deps();
    d.sendMessage.mockRejectedValue(new Error("telegram down"));
    for (let i = 0; i <= 5; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d).catch(() => {});
    expect(m.staged).toHaveLength(1);
    expect(m.pos!.lastPromptAtMs).not.toBeNull();
  });

  it("a parked phone (jitter) never proposes", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 10; i++) await handleLiveLocation(m.store, { latitude: 28 + i * 1e-6, longitude: -81.7, horizontal_accuracy: 8 }, T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(0);
  });

  it("D6: a stale fix never drives a proposal - it says so with the fix age", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 5; i++) {
      // The last fix arrives 20 minutes late: the movement is real, the fix is not fresh.
      const opts = i === 5 ? { nowMs: T0 + 5 * 30_000 + 20 * 60_000 } : undefined;
      await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d, opts);
    }
    expect(m.staged).toHaveLength(0);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage.mock.calls[0]![0]).toContain("I don't have a fresh location — last fix 20 min ago");
    expect(d.sendMessage.mock.calls[0]![0]).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("D6: a feed gap restarts the episode - a stop from before the gap cannot propose on arrival", async () => {
    const m = memStore("driving");
    const d = deps();
    const still = { latitude: 28, longitude: -81.7, horizontal_accuracy: 8 };
    for (let i = 0; i <= 11; i++) await handleLiveLocation(m.store, still, T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1); // stopped 5+ min while logged driving
    // No fixes for an hour, then the same spot: the old stop is not continuous evidence.
    await handleLiveLocation(m.store, still, T0 + 60 * 60_000 + 11 * 30_000, d);
    expect(m.staged).toHaveLength(1);
    // A fresh 5-minute stop after the gap proposes again (cooldown long past).
    for (let i = 1; i <= 11; i++) await handleLiveLocation(m.store, still, T0 + 60 * 60_000 + 11 * 30_000 + i * 30_000, d);
    expect(m.staged).toHaveLength(2);
  });

  it("D2: an identical duty proposal already waiting is never staged again", async () => {
    const m = memStore("off_duty");
    const d = deps();
    for (let i = 0; i <= 6; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    // Past the 30-min cooldown, still moving, same movement start: the
    // same proposal would fire again - it must not stage a second row.
    for (let i = 7; i <= 70; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("describeFixAge", () => {
  it("words an age, never a timestamp", () => {
    expect(describeFixAge(30_000)).toBe("just now");
    expect(describeFixAge(5 * 60_000)).toBe("5 min ago");
    expect(describeFixAge(2 * 60 * 60_000)).toBe("2 hours ago");
    expect(describeFixAge(3 * 24 * 60 * 60_000)).toBe("3 days ago");
  });
});

describe("proposalText", () => {
  it("asks, never claims - and arrives as a labeled card, not prose", () => {
    const t = proposalText({ kind: "start_driving", status: "driving", sinceMs: 0 }, "9:14 AM");
    expect(t).toContain("Proposed: log Driving from 9:14 AM");
    // Card shape: 🕒 header + labeled Status / Since / Proposed lines.
    expect(t.startsWith("🕒 Duty check")).toBe(true);
    expect(t).toContain("Status: log doesn't say Driving");
    expect(t).toContain("Moving since: 9:14 AM");
    expect(t).toContain("Reply YES to confirm");
  });

  it("a stopped-truck proposal carries the same card shape", () => {
    const t = proposalText({ kind: "stop_driving", status: "off_duty", sinceMs: 0 }, "8:40 AM CT");
    expect(t.startsWith("🕒 Duty check")).toBe(true);
    expect(t).toContain("Status: log still says Driving");
    expect(t).toContain("Stopped since: 8:40 AM CT");
    expect(t).toContain("Proposed: log Off duty from 8:40 AM CT");
    expect(t).toContain("Reply YES to confirm");
  });
});

describe("handleLiveLocation - automatic switch to Driving (works with the app closed)", () => {
  const ok = (startedAt: string) => async () => ({ switched: true, startedAt });
  it("after the sustained-motion + grace time it switches, stamped at the DETECTION time, tells him, and stages no proposal", async () => {
    const m = memStore("off_duty");
    const d = { ...deps(), autoSwitch: vi.fn(async (detectedAtIso: string, _id: string) => ({ switched: true, startedAt: detectedAtIso })) };
    for (let i = 0; i <= 6; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    // (the stub never flips the log to Driving, so later fixes repeat the SAME idempotent request)
    expect(d.autoSwitch).toHaveBeenCalled();
    expect(new Set(d.autoSwitch.mock.calls.map((c) => `${c[0]}|${c[1]}`)).size).toBe(1);
    // movement began at the second fix (T0+30 s); detection = movement start + 60 s
    expect(d.autoSwitch.mock.calls[0]![0]).toBe(new Date(T0 + 30_000 + 60_000).toISOString());
    expect(d.autoSwitch.mock.calls[0]![1]).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    expect(d.sendMessage.mock.calls[0]![0]).toContain("Switched to Driving at");
    expect(m.staged).toHaveLength(0);
  });

  it("not before the grace has passed (60 s sustained + 30 s grace)", async () => {
    const m = memStore("off_duty");
    const d = { ...deps(), autoSwitch: vi.fn(ok("x")) };
    for (let i = 0; i <= 3; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d); // 60 s of movement
    expect(d.autoSwitch).not.toHaveBeenCalled();
  });

  it("never when the log already says Driving", async () => {
    const m = memStore("driving");
    const d = { ...deps(), autoSwitch: vi.fn(ok("x")) };
    for (let i = 0; i <= 10; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(d.autoSwitch).not.toHaveBeenCalled();
  });

  it("the kill switch off (auto_duty_switch): falls back to the old propose-and-wait behaviour", async () => {
    const m = memStore("off_duty");
    const d = { ...deps(), autoSwitch: vi.fn(async () => ({ switched: false, reason: "switched_off" })) };
    for (let i = 0; i <= 8; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(1);
    expect(d.sendMessage.mock.calls.some((c) => String(c[0]).includes("Proposed: log Driving from"))).toBe(true);
  });

  it("a manual choice wins: the shared rules stand down and he is NOT nagged with a proposal on top", async () => {
    const m = memStore("on_duty");
    const d = { ...deps(), autoSwitch: vi.fn(async () => ({ switched: false, reason: "manual_change_won" })) };
    for (let i = 0; i <= 8; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(m.staged).toHaveLength(0);
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("a replay (second source already switched) says nothing more", async () => {
    const m = memStore("off_duty");
    const d = { ...deps(), autoSwitch: vi.fn(async () => ({ switched: true, deduplicated: true, startedAt: "x" })) };
    for (let i = 0; i <= 8; i++) await handleLiveLocation(m.store, at(i), T0 + i * 30_000, d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(m.staged).toHaveLength(0);
  });
});
