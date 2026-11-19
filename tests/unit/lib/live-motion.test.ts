import { describe, expect, it } from "vitest";
import {
  MOVING_PROPOSAL_AFTER_MS,
  NO_EPISODE,
  PROPOSAL_COOLDOWN_MS,
  STOPPED_PROPOSAL_AFTER_MS,
  decideStatusProposal,
  deriveSpeedMph,
  haversineMiles,
  stepEpisode,
  type MotionEpisode,
  type PositionFix,
} from "@/lib/live-motion";

const fix = (lat: number, lng: number, atMs: number, accuracyM: number | null = 10): PositionFix => ({ lat, lng, atMs, accuracyM });
// 1 degree of latitude ~ 69.05 miles.
const northMiles = (miles: number) => miles / 69.05;

describe("haversineMiles", () => {
  it("measures real distances", () => {
    expect(haversineMiles({ lat: 28, lng: -81.7 }, { lat: 29, lng: -81.7 })).toBeGreaterThan(68.9);
    expect(haversineMiles({ lat: 28, lng: -81.7 }, { lat: 29, lng: -81.7 })).toBeLessThan(69.3);
    expect(haversineMiles({ lat: 28, lng: -81.7 }, { lat: 28, lng: -81.7 })).toBe(0);
  });
});

describe("deriveSpeedMph - only a speed it can stand behind", () => {
  it("60 mph over 60 s is one mile", () => {
    const a = fix(28, -81.7, 0);
    const b = fix(28 + northMiles(1), -81.7, 60_000);
    expect(deriveSpeedMph(a, b)!).toBeGreaterThan(59);
    expect(deriveSpeedMph(a, b)!).toBeLessThan(61);
  });

  it("no previous fix, too-close fixes, and long gaps give no speed (never a guess)", () => {
    expect(deriveSpeedMph(null, fix(28, -81.7, 0))).toBeNull();
    expect(deriveSpeedMph(fix(28, -81.7, 0), fix(28.001, -81.7, 1_000))).toBeNull();
    expect(deriveSpeedMph(fix(28, -81.7, 0), fix(28.5, -81.7, 10 * 60_000))).toBeNull();
  });

  it("an inaccurate fix on either end gives no speed", () => {
    expect(deriveSpeedMph(fix(28, -81.7, 0, 500), fix(28.01, -81.7, 30_000))).toBeNull();
    expect(deriveSpeedMph(fix(28, -81.7, 0), fix(28.01, -81.7, 30_000, 250))).toBeNull();
  });

  it("a phone wandering a few metres while parked is zero, not 'moving'", () => {
    const a = fix(28, -81.7, 0);
    const wander = fix(28 + northMiles(0.003), -81.7, 20_000); // ~5 m in 20 s would read ~0.5 mph
    expect(deriveSpeedMph(a, wander)).toBe(0);
  });

  it("a missing accuracy is treated as fine (Telegram omits it on some updates)", () => {
    expect(deriveSpeedMph(fix(28, -81.7, 0, null), fix(28 + northMiles(0.5), -81.7, 60_000, null))!).toBeGreaterThan(29);
  });
});

describe("stepEpisode", () => {
  it("moving starts an episode at the first moving fix and keeps its start while it continues", () => {
    let e = stepEpisode(NO_EPISODE, 45, 1000);
    expect(e).toEqual({ movingSinceMs: 1000, stoppedSinceMs: null });
    e = stepEpisode(e, 52, 9000);
    expect(e.movingSinceMs).toBe(1000);
  });

  it("a stop longer than the dip tolerance ends the drive; the stop keeps its first-fix start", () => {
    let e = stepEpisode({ movingSinceMs: 1000, stoppedSinceMs: null }, 0, 5000);
    expect(e).toEqual({ movingSinceMs: 1000, stoppedSinceMs: 5000 }); // a red light so far
    e = stepEpisode(e, 1, 21_000); // 16 s stopped
    expect(e).toEqual({ movingSinceMs: null, stoppedSinceMs: 5000 });
  });

  it("a red light (stop under 15 s) does not reset the motion run — stop-and-go still reaches the switch (2026-11-19)", () => {
    let e = stepEpisode(NO_EPISODE, 20, 0);
    e = stepEpisode(e, 0, 30_000);
    e = stepEpisode(e, 0, 40_000);
    e = stepEpisode(e, 18, 45_000);
    expect(e).toEqual({ movingSinceMs: 0, stoppedSinceMs: null });
  });

  it("creeping between the thresholds changes nothing: a slow stretch neither ends a drive nor starts one", () => {
    const driving: MotionEpisode = { movingSinceMs: 100, stoppedSinceMs: null };
    expect(stepEpisode(driving, 4, 500)).toEqual(driving); // between 3 and 5 mph
    expect(stepEpisode(NO_EPISODE, 4, 500)).toEqual(NO_EPISODE);
  });

  it("an unknown speed changes nothing", () => {
    const driving: MotionEpisode = { movingSinceMs: 100, stoppedSinceMs: null };
    expect(stepEpisode(driving, null, 500)).toBe(driving);
    expect(stepEpisode(driving, Number.NaN, 500)).toBe(driving);
  });
});

describe("decideStatusProposal - proposes, with the time the movement really began", () => {
  const base = { lastPromptAtMs: null, lastPromptKind: null } as const;
  const NOW = 10_000_000;

  it("moving for 2+ minutes while logged off duty -> propose Driving since the movement began", () => {
    const p = decideStatusProposal({ ...base, episode: { movingSinceMs: NOW - MOVING_PROPOSAL_AFTER_MS, stoppedSinceMs: null }, nowMs: NOW, currentStatus: "off_duty" });
    expect(p).toEqual({ kind: "start_driving", status: "driving", sinceMs: NOW - MOVING_PROPOSAL_AFTER_MS, episodeKey: `move:${NOW - MOVING_PROPOSAL_AFTER_MS}` });
  });

  it("not before 2 minutes (a quick move across a lot isn't a drive)", () => {
    expect(decideStatusProposal({ ...base, episode: { movingSinceMs: NOW - MOVING_PROPOSAL_AFTER_MS + 1, stoppedSinceMs: null }, nowMs: NOW, currentStatus: "off_duty" })).toBeNull();
  });

  it("already logged as driving: nothing to say", () => {
    expect(decideStatusProposal({ ...base, episode: { movingSinceMs: NOW - 600_000, stoppedSinceMs: null }, nowMs: NOW, currentStatus: "driving" })).toBeNull();
  });

  it("works for sleeper / on duty / never-logged too", () => {
    for (const currentStatus of ["sleeper", "on_duty", null] as const) {
      expect(decideStatusProposal({ ...base, episode: { movingSinceMs: NOW - 300_000, stoppedSinceMs: null }, nowMs: NOW, currentStatus })).toMatchObject({ kind: "start_driving" });
    }
  });

  it("stopped 20+ minutes while logged driving -> propose On duty since the stop began", () => {
    const p = decideStatusProposal({ ...base, episode: { movingSinceMs: null, stoppedSinceMs: NOW - STOPPED_PROPOSAL_AFTER_MS }, nowMs: NOW, currentStatus: "driving" });
    expect(p).toEqual({ kind: "stop_driving", status: "on_duty", sinceMs: NOW - STOPPED_PROPOSAL_AFTER_MS, episodeKey: `stop:${NOW - STOPPED_PROPOSAL_AFTER_MS}` });
  });

  it("a short stop (fuel, a light) is not a change of status; and a stop while NOT logged driving is not proposed", () => {
    expect(decideStatusProposal({ ...base, episode: { movingSinceMs: null, stoppedSinceMs: NOW - 4 * 60_000 }, nowMs: NOW, currentStatus: "driving" })).toBeNull(); // 5 min is the line now
    expect(decideStatusProposal({ ...base, episode: { movingSinceMs: null, stoppedSinceMs: NOW - 2 * 3_600_000 }, nowMs: NOW, currentStatus: "off_duty" })).toBeNull();
  });

  it("never prompts twice inside the cooldown, then can again", () => {
    const episode = { movingSinceMs: NOW - 600_000, stoppedSinceMs: null };
    expect(decideStatusProposal({ episode, nowMs: NOW, currentStatus: "off_duty", lastPromptAtMs: NOW - PROPOSAL_COOLDOWN_MS + 1, lastPromptKind: "start_driving" })).toBeNull();
    expect(decideStatusProposal({ episode, nowMs: NOW, currentStatus: "off_duty", lastPromptAtMs: NOW - PROPOSAL_COOLDOWN_MS, lastPromptKind: "start_driving" })).not.toBeNull();
  });

  it("no episode, no proposal", () => {
    expect(decideStatusProposal({ ...base, episode: NO_EPISODE, nowMs: NOW, currentStatus: "off_duty" })).toBeNull();
  });
});

describe("5-second Tracker fixes (2026-11-19)", () => {
  it("a good-accuracy pair at ~6 mph reads as moving, not as jitter", async () => {
    const { deriveSpeedMph, MOVING_MPH } = await import("@/lib/live-motion");
    // 6 mph for 5 s = 0.00833 mi, under the old 0.01 mi jitter floor
    const a = { lat: 30, lng: -82, atMs: 0, accuracyM: 5 };
    const b = { lat: 30 + 0.00833 / 69.09, lng: -82, atMs: 5_000, accuracyM: 5 };
    expect(deriveSpeedMph(a, b)!).toBeGreaterThanOrEqual(MOVING_MPH);
    // a poor fix still gets the wide jitter floor
    expect(deriveSpeedMph({ ...a, accuracyM: 60 }, { ...b, accuracyM: 60 })).toBe(0);
  });
});
