import { describe, expect, it, vi } from "vitest";
import { handleLiveLocation, proposalText, type LiveLocationStore, type StoredPosition } from "@/services/telegram/live-location";
import { MOVING_PROPOSAL_AFTER_MS, PROPOSAL_COOLDOWN_MS } from "@/lib/live-motion";
import type { DutyStatus } from "@/types/entities";

const miles = (m: number) => m / 69.05;
function memStore(status: DutyStatus | null) {
  let pos: StoredPosition | null = null;
  const staged: { sinceIso: string; status: string }[] = [];
  const store: LiveLocationStore = {
    loadPosition: async () => pos,
    savePosition: async (p) => void (pos = p),
    loadCurrentStatus: async () => status,
    stageProposal: async (proposal, sinceIso) => void staged.push({ sinceIso, status: proposal.status }),
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
});

describe("proposalText", () => {
  it("asks, never claims", () => {
    const t = proposalText({ kind: "start_driving", status: "driving", sinceMs: 0 }, "9:14 AM");
    expect(t).toContain("Want me to log Driving from 9:14 AM");
  });
});
