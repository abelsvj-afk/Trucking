// ELD stopped vehicle — the Telegram/device feed path (brief §3):
// prompt at 5 min, auto On Duty at minute 6 on silence, never auto
// Off Duty/Sleeper, episode-identity dedupe (replace, not clone),
// hourly re-prompt after expiry carrying the original stop start,
// feed-health tell, and the moved-during-correction flag.

import { describe, expect, it, vi } from "vitest";
import { handleLiveLocation, type LiveLocationStore, type StopProposalRow, type StoredPosition } from "@/services/telegram/live-location";
import type { DutyStatus } from "@/types/entities";

const miles = (m: number) => m / 69.05;
const T0 = 1_800_000_000_000;
/** The stop episode starts at the second fix: the first fix has no speed to judge. */
const STOP_START = T0 + 30_000;
const still = (atMs: number) => ({ latitude: 28, longitude: -81.7, horizontal_accuracy: 8 });
const stopIso = (ms: number) => new Date(ms).toISOString();

interface FakePending {
  id: string;
  status: string;
  sinceIso: string;
  episodeKey: string;
  createdAtMs: number;
  deletedAtMs: number | null;
}

function feedStore(status: DutyStatus | null) {
  let pos: StoredPosition | null = null;
  let latestDutyRow: { duty_status: DutyStatus; started_at: string; source: string | null; notes: string | null } | null = null;
  const pending: FakePending[] = [];
  let idSeq = 0;
  const fake = {
    nowMs: T0,
    stageCalls: 0,
    replaceCalls: 0,
    clearCalls: 0,
    setLatestDutyRow(row: typeof latestDutyRow) {
      latestDutyRow = row;
    },
    openPending: () => pending.filter((p) => p.deletedAtMs === null && fake.nowMs - p.createdAtMs < 2 * 60 * 60_000),
    store: {
      loadPosition: async () => pos,
      savePosition: async (p) => void (pos = p),
      loadCurrentStatus: async () => status,
      loadLatestDutyRow: async () => latestDutyRow,
      stageProposal: async (proposal, sinceIso) => {
        fake.stageCalls += 1;
        const id = `pending-${++idSeq}`;
        pending.push({ id, status: proposal.status, sinceIso, episodeKey: proposal.episodeKey, createdAtMs: fake.nowMs, deletedAtMs: null });
        return id;
      },
      hasWaitingDutyProposal: async (_s: string, sinceIso: string, key?: string) =>
        pending.some(
          (p) =>
            p.deletedAtMs === null &&
            fake.nowMs - p.createdAtMs < 2 * 60 * 60_000 &&
            (key ? p.episodeKey === key : p.sinceIso === sinceIso),
        ),
      findWaitingStopProposal: async (): Promise<StopProposalRow | null> => {
        const open = pending
          .filter((p) => p.deletedAtMs === null && fake.nowMs - p.createdAtMs < 2 * 60 * 60_000)
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        const row = open[0];
        return row ? { id: row.id, status: row.status as DutyStatus, startedAtIso: row.sinceIso, episodeKey: row.episodeKey, createdAtMs: row.createdAtMs, expired: false } : null;
      },
      findLatestStopProposal: async (key: string): Promise<StopProposalRow | null> => {
        const rows = pending.filter((p) => p.episodeKey === key).sort((a, b) => b.createdAtMs - a.createdAtMs);
        const row = rows[0];
        return row
          ? { id: row.id, status: row.status as DutyStatus, startedAtIso: row.sinceIso, episodeKey: row.episodeKey, createdAtMs: row.createdAtMs, expired: fake.nowMs - row.createdAtMs > 2 * 60 * 60_000 }
          : null;
      },
      replaceStopProposal: async (oldId: string, proposal, sinceIso: string) => {
        fake.replaceCalls += 1;
        const old = pending.find((p) => p.id === oldId);
        if (old) old.deletedAtMs = fake.nowMs;
        const id = `pending-${++idSeq}`;
        pending.push({ id, status: proposal.status, sinceIso, episodeKey: proposal.episodeKey, createdAtMs: fake.nowMs, deletedAtMs: null });
        return id;
      },
      clearStopProposal: async (key: string) => {
        fake.clearCalls += 1;
        for (const p of pending) if (p.episodeKey === key && p.deletedAtMs === null) p.deletedAtMs = fake.nowMs;
      },
    } as LiveLocationStore,
    get pos() {
      return pos;
    },
  };
  return fake;
}

const deps = () => ({ sendMessage: vi.fn().mockResolvedValue(undefined), formatTime: (ms: number) => `t${ms}` });

async function stoppedFixes(fake: ReturnType<typeof feedStore>, d: ReturnType<typeof deps>, count: number, startMs = T0, stepMs = 30_000) {
  for (let i = 0; i < count; i++) {
    fake.nowMs = startMs + i * stepMs;
    await handleLiveLocation(fake.store, still(startMs + i * stepMs), startMs + i * stepMs, d, { nowMs: startMs + i * stepMs });
  }
}

describe("handleLiveLocation — ELD stopped vehicle (feed path)", () => {
  it("prompts at 5 min stopped while the log says Driving — On Duty, backdated to the stop start", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12); // 0..5:30 — the 5-minute line is crossed at fix 11
    expect(m.openPending()).toHaveLength(1);
    expect(m.openPending()[0]).toMatchObject({ status: "on_duty", sinceIso: stopIso(STOP_START), episodeKey: `stop:${STOP_START}` });
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage.mock.calls[0]![0]).toContain("Stopped since");
    expect(d.sendMessage.mock.calls[0]![0]).toContain("Reply YES to apply");
  });

  it("auto-switches to On Duty at minute 6 on silence, clears the waiting proposal, and says the 14-hour window is not rewound", async () => {
    const m = feedStore("driving");
    const autoStop = vi.fn(async (stoppedSinceIso: string, _id: string, _promptedAtMs: number | null) => ({
      switched: true,
      startedAt: stoppedSinceIso,
      message: "Switched to On duty (not driving) from t — truck stopped. Driving time fixed. Your 14-hour window still ends at 9:00 PM ET — only rest moves that. (Mirror — not the legal ELD.)",
    }));
    const d = { ...deps(), autoStop };
    await stoppedFixes(m, d, 12); // through 5:30 — the prompt stages at fix 11
    expect(m.openPending()).toHaveLength(1);
    expect(autoStop).not.toHaveBeenCalled();
    await stoppedFixes(m, d, 2, T0 + 12 * 30_000); // through 6:30 — silence elapses at the last fix
    expect(autoStop).toHaveBeenCalledTimes(1);
    expect(autoStop.mock.calls[0]![0]).toBe(stopIso(STOP_START));
    expect(autoStop.mock.calls[0]![1]).toMatch(/^00000000-0000-4001-8000-[0-9a-f]{12}$/);
    expect(autoStop.mock.calls[0]![2]).toBe(STOP_START + 5 * 60_000); // prompted at minute 5
    expect(m.openPending()).toHaveLength(0); // the moot proposal is cleared
    const texts = d.sendMessage.mock.calls.map((c) => c[0] as string);
    expect(texts.some((t) => t.includes("Driving time fixed") && t.includes("14-hour window still ends at"))).toBe(true);
    // Later fixes do not re-switch or re-stage.
    await stoppedFixes(m, d, 4, T0 + 14 * 30_000);
    expect(autoStop).toHaveBeenCalledTimes(1);
    expect(m.stageCalls).toBe(1);
  });

  it("never stages an Off Duty / Sleeper proposal from the feed, and never auto-applies one", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12);
    expect(m.openPending().every((p) => p.status === "on_duty")).toBe(true);
  });

  it("a re-staged proposal for the same stop REPLACES the waiting one, carrying the ORIGINAL stop start", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12); // stop 1 from STOP_START; proposal stages at 5 min
    expect(m.openPending()).toHaveLength(1);
    // Still stopped for a long while (the waiting proposal holds),
    // then a brief creep restarts the episode, then a gap, then a
    // fresh stop. The re-prompt must carry the ORIGINAL stop start.
    await stoppedFixes(m, d, 60, T0 + 12 * 30_000); // through ~35 min
    const creepAt = T0 + 72 * 30_000;
    fakeNow(m, creepAt);
    await handleLiveLocation(m.store, { latitude: 28 + miles(0.5), longitude: -81.7, horizontal_accuracy: 10 }, creepAt, d, { nowMs: creepAt });
    const restopAt = T0 + 134 * 30_000; // ~31 min after the creep
    await stoppedFixes(m, d, 12, restopAt); // fresh stop, proposal at +5 min
    expect(m.replaceCalls).toBe(1);
    expect(m.openPending()).toHaveLength(1);
    // The replacement carries the ORIGINAL stop start, not the re-stop's.
    expect(m.openPending()[0]!.sinceIso).toBe(stopIso(STOP_START));
    expect(m.openPending()[0]!.episodeKey).toBe(`stop:${restopAt + 30_000}`);
    expect(m.stageCalls).toBe(1); // the replacement is not a second stage
  });

  it("an expired proposal does not block a fresh one; the hourly re-prompt carries the original stop start", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12); // proposal stages at 5 min
    expect(m.openPending()).toHaveLength(1);
    // Fixes keep arriving every 30 s (the episode stays one stop)
    // for 2 h 5 min past the staging; the row expires at 2 h and
    // the next fix re-prompts with the ORIGINAL stop start.
    await stoppedFixes(m, d, 241, T0 + 12 * 30_000); // through 2 h 5:30
    expect(m.stageCalls).toBe(2);
    expect(m.openPending()).toHaveLength(1);
    expect(m.openPending()[0]!.sinceIso).toBe(stopIso(STOP_START));
    expect(m.openPending()[0]!.episodeKey).toBe(`stop:${STOP_START}`);
  });

  it("no re-prompt inside the hour after a cleared proposal for the same episode, then one after the hour", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12); // proposal stages at 5 min
    expect(m.openPending()).toHaveLength(1);
    // The feed stays alive (one continuous stop); the waiting row
    // is cleared mid-stream (answered NO in the conversation).
    await stoppedFixes(m, d, 57, T0 + 12 * 30_000); // through 34:00
    const cleared = m.openPending()[0]!;
    fakeNow(m, T0 + 35 * 60_000);
    m.store.clearStopProposal!(cleared.episodeKey);
    // 40–50 min in: the cooldown has passed but the hour has not.
    await stoppedFixes(m, d, 31, T0 + 35 * 60_000 + 30_000); // through 50:30
    expect(m.stageCalls).toBe(1); // blocked inside the hour
    // Past the hour (65.5 min after the prompt): re-prompt, same stop.
    await stoppedFixes(m, d, 40, T0 + 51 * 60_000); // through 70:30
    expect(m.stageCalls).toBe(2); // allowed after the hour
    expect(m.openPending()[0]!.sinceIso).toBe(stopIso(STOP_START));
  });

  it("feed-health tell: a stale fix while Driving tells once, zone-labelled, and invents no stop", async () => {
    const m = feedStore("driving");
    const d = deps();
    await stoppedFixes(m, d, 12); // through 5:30, prompt stages at fix 11
    expect(m.stageCalls).toBe(1);
    // The feed stays alive past the 30-minute cooldown, then the
    // next fix arrives 20 minutes late.
    await stoppedFixes(m, d, 59, T0 + 12 * 30_000); // through 35:00
    const lateAt = T0 + 71 * 30_000;
    fakeNow(m, lateAt + 20 * 60_000);
    await handleLiveLocation(m.store, still(lateAt), lateAt, d, { nowMs: lateAt + 20 * 60_000 });
    expect(m.stageCalls).toBe(1); // no proposal from a stale fix
    expect(d.sendMessage.mock.calls.map((c) => c[0] as string).some((t) => t.includes("I haven't had a location fix since"))).toBe(true);
    const tells = d.sendMessage.mock.calls.filter((c) => (c[0] as string).includes("I haven't had a location fix since"));
    expect(tells).toHaveLength(1);
    // A second stale fix does not repeat the tell.
    const laterAt = lateAt + 30_000;
    fakeNow(m, laterAt + 20 * 60_000);
    await handleLiveLocation(m.store, still(laterAt), laterAt, d, { nowMs: laterAt + 20 * 60_000 });
    expect(d.sendMessage.mock.calls.filter((c) => (c[0] as string).includes("I haven't had a location fix since"))).toHaveLength(1);
  });

  it("flags movement inside a corrected window instead of silently keeping the correction", async () => {
    const m = feedStore("driving");
    m.setLatestDutyRow({ duty_status: "on_duty", started_at: stopIso(T0), source: "auto_motion", notes: "Auto-stop correction: switched to On Duty (not driving) from t." });
    const d = deps();
    await stoppedFixes(m, d, 11); // stopped episode established (last fix inside the window)
    // The truck jumps half a mile in one minute — it moved inside the corrected window.
    const jumpAt = T0 + 11 * 30_000;
    fakeNow(m, jumpAt);
    await handleLiveLocation(m.store, { latitude: 28 + miles(0.5), longitude: -81.7, horizontal_accuracy: 10 }, jumpAt, d, { nowMs: jumpAt });
    const texts = d.sendMessage.mock.calls.map((c) => c[0] as string);
    expect(texts.some((t) => t.includes("seems to have moved") && t.includes("may be wrong"))).toBe(true);
  });
});

function fakeNow(m: ReturnType<typeof feedStore>, nowMs: number) {
  m.nowMs = nowMs;
}

// Owner 2026-11-17: "Auto Off Duty after 2h" - the rest he never answered about is logged as rest.
describe("handleLiveLocation - auto Off Duty after 2 hours parked", () => {
  it("asks the rest switch at the 2-hour mark (from the stop start), messages him once, and doesn't hammer it", async () => {
    const m = feedStore("on_duty");
    const autoRest = vi.fn(async (stoppedSinceIso: string, _submissionId: string, _timeZone?: string) => ({
      switched: false as const,
      reason: "manual_status",
      startedAt: stoppedSinceIso,
    }));
    const d = { ...deps(), autoRest };
    const step = 15_000;
    // 1 h 55 min parked: never asked
    await stoppedFixes(m, d, Math.floor((115 * 60_000) / step), T0, step);
    expect(autoRest).not.toHaveBeenCalled();
    // to 2 h 30 min: asked at the 2-hour mark, then at most every 10 minutes (an On Duty he chose stands)
    await stoppedFixes(m, d, Math.floor((35 * 60_000) / step), T0 + 115 * 60_000, step);
    expect(autoRest.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(autoRest.mock.calls.length).toBeLessThanOrEqual(4);
    expect(autoRest.mock.calls[0]![0]).toBe(stopIso(T0 + step)); // the stop starts at the second fix
    expect(autoRest.mock.calls[0]![1]).toMatch(/^00000000-0000-4002-8000-[0-9a-f]{12}$/);
  });

  it("when it switches, he's told once and later fixes don't ask again", async () => {
    const m = feedStore("on_duty");
    const autoRest = vi.fn(async (stoppedSinceIso: string) => ({ switched: true, startedAt: stoppedSinceIso, message: "Logged you Off Duty from t - parked over 2 hours" }));
    const d = { ...deps(), autoRest };
    const step = 15_000;
    await stoppedFixes(m, d, Math.floor((125 * 60_000) / step), T0 + 7, step);
    const told = d.sendMessage.mock.calls.filter((c) => String(c[0]).includes("Logged you Off Duty"));
    expect(told).toHaveLength(1);
  });
});
