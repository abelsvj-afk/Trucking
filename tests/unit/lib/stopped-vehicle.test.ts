// ELD stopped-vehicle guard tests (brief §3; owner call 2026-11-14):
// prompt at 5 min, auto On Duty at minute 6 on silence, never auto
// Off Duty/Sleeper, hourly re-prompt carrying the original stop start,
// feed-health tell once per stale period, and the 14-hour honesty line.

import { describe, expect, it } from "vitest";
import {
  FEED_STALE_MS,
  STOP_AUTO_SWITCH_MS,
  STOP_PROMPT_MS,
  STOP_REPROMPT_MS,
  decideFeedHealthTell,
  episodeKey,
  movedDuringCorrection,
  stopAutoSwitchDue,
  stopCorrectionConfirmation,
  stopPromptDue,
  stopRepromptAllowed,
} from "@/lib/stopped-vehicle";

const T0 = 1_800_000_000_000;

describe("stopPromptDue", () => {
  it("fires at 5 min stopped while the log says Driving", () => {
    expect(stopPromptDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_PROMPT_MS, currentStatus: "driving" })).toBe(true);
    expect(stopPromptDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_PROMPT_MS - 1, currentStatus: "driving" })).toBe(false);
  });

  it("never fires when not Driving, or with no stop episode", () => {
    expect(stopPromptDue({ stoppedSinceMs: T0, nowMs: T0 + 60 * 60_000, currentStatus: "on_duty" })).toBe(false);
    expect(stopPromptDue({ stoppedSinceMs: null, nowMs: T0 + 60 * 60_000, currentStatus: "driving" })).toBe(false);
  });
});

describe("stopAutoSwitchDue — minute 6, on silence, On Duty only", () => {
  it("fires at minute 6 when the prompt was shown at minute 5", () => {
    expect(
      stopAutoSwitchDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_AUTO_SWITCH_MS, currentStatus: "driving", promptedAtMs: T0 + STOP_PROMPT_MS }),
    ).toBe(true);
  });

  it("does not fire before minute 6, or less than a minute after the prompt", () => {
    expect(
      stopAutoSwitchDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_AUTO_SWITCH_MS - 1, currentStatus: "driving", promptedAtMs: T0 + STOP_PROMPT_MS }),
    ).toBe(false);
    expect(
      stopAutoSwitchDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_AUTO_SWITCH_MS, currentStatus: "driving", promptedAtMs: T0 + STOP_AUTO_SWITCH_MS - 30_000 }),
    ).toBe(false);
  });

  it("never fires without a prompt — no blind auto-switch", () => {
    expect(
      stopAutoSwitchDue({ stoppedSinceMs: T0, nowMs: T0 + 60 * 60_000, currentStatus: "driving", promptedAtMs: null }),
    ).toBe(false);
  });

  it("never fires when the log no longer says Driving", () => {
    expect(
      stopAutoSwitchDue({ stoppedSinceMs: T0, nowMs: T0 + STOP_AUTO_SWITCH_MS, currentStatus: "off_duty", promptedAtMs: T0 + STOP_PROMPT_MS }),
    ).toBe(false);
  });
});

describe("episodeKey", () => {
  it("is the stop start: same stop, same key; a restarted episode gets a new one", () => {
    expect(episodeKey(T0)).toBe(`stop:${T0}`);
    expect(episodeKey(T0)).toBe(episodeKey(T0));
    expect(episodeKey(T0 + 60_000)).not.toBe(episodeKey(T0));
  });
});

describe("stopRepromptAllowed — hourly, original stop start", () => {
  it("allows a re-prompt an hour after the last stop prompt for the same episode", () => {
    expect(
      stopRepromptAllowed({ nowMs: T0 + STOP_REPROMPT_MS, lastPromptAtMs: T0, lastPromptKind: "stop_driving", previousSinceMs: T0 - 300_000, currentSinceMs: T0 - 300_000 }),
    ).toBe(true);
  });

  it("blocks a re-prompt inside the hour for the same episode", () => {
    expect(
      stopRepromptAllowed({ nowMs: T0 + STOP_REPROMPT_MS - 1, lastPromptAtMs: T0, lastPromptKind: "stop_driving", previousSinceMs: T0 - 300_000, currentSinceMs: T0 - 300_000 }),
    ).toBe(false);
  });

  it("never gates a different episode, or a prompt that was not a stop prompt", () => {
    expect(
      stopRepromptAllowed({ nowMs: T0 + 1_000, lastPromptAtMs: T0, lastPromptKind: "stop_driving", previousSinceMs: T0 - 300_000, currentSinceMs: T0 - 100_000 }),
    ).toBe(true);
    expect(
      stopRepromptAllowed({ nowMs: T0 + 1_000, lastPromptAtMs: T0, lastPromptKind: "start_driving", previousSinceMs: T0 - 300_000, currentSinceMs: T0 - 300_000 }),
    ).toBe(true);
  });
});

describe("decideFeedHealthTell — one tell per stale period, never an invented stop", () => {
  it("fires at 15 min without a fix while the log says Driving", () => {
    expect(decideFeedHealthTell({ lastFixAtMs: T0, nowMs: T0 + FEED_STALE_MS, currentStatus: "driving", alreadyTold: false })).toBe(true);
    expect(decideFeedHealthTell({ lastFixAtMs: T0, nowMs: T0 + FEED_STALE_MS - 1, currentStatus: "driving", alreadyTold: false })).toBe(false);
  });

  it("does not fire twice for the same stale period, or when not Driving", () => {
    expect(decideFeedHealthTell({ lastFixAtMs: T0, nowMs: T0 + 60 * 60_000, currentStatus: "driving", alreadyTold: true })).toBe(false);
    expect(decideFeedHealthTell({ lastFixAtMs: T0, nowMs: T0 + 60 * 60_000, currentStatus: "on_duty", alreadyTold: false })).toBe(false);
    expect(decideFeedHealthTell({ lastFixAtMs: null, nowMs: T0 + 60 * 60_000, currentStatus: "driving", alreadyTold: false })).toBe(false);
  });
});

describe("movedDuringCorrection", () => {
  it("flags a jump inside the corrected window while the episode said stopped", () => {
    expect(movedDuringCorrection({ prevFixAtMs: T0 + 10 * 60_000, displacementMiles: 0.5, wasStopped: true, correctionStartMs: T0 })).toBe(true);
  });

  it("does not flag jitter, a fix from before the window, or an episode already moving", () => {
    expect(movedDuringCorrection({ prevFixAtMs: T0 + 10 * 60_000, displacementMiles: 0.01, wasStopped: true, correctionStartMs: T0 })).toBe(false);
    expect(movedDuringCorrection({ prevFixAtMs: T0 - 10 * 60_000, displacementMiles: 5, wasStopped: true, correctionStartMs: T0 })).toBe(false);
    expect(movedDuringCorrection({ prevFixAtMs: T0 + 10 * 60_000, displacementMiles: 5, wasStopped: false, correctionStartMs: T0 })).toBe(false);
  });
});

describe("stopCorrectionConfirmation — the 14-hour window is not rewound", () => {
  it("names the window end when known", () => {
    const line = stopCorrectionConfirmation({ windowEndLabel: "9:00 PM ET" });
    expect(line).toContain("Driving time fixed");
    expect(line).toContain("14-hour window still ends at 9:00 PM ET");
    expect(line).toContain("only rest moves that");
  });

  it("still says the window keeps running when the end is unknown", () => {
    const line = stopCorrectionConfirmation({ windowEndLabel: null });
    expect(line).toContain("Driving time fixed");
    expect(line).toContain("14-hour window keeps running");
  });
});
