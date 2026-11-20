// Bot-to-bot handoffs: the room-visible addressed line — format,
// parse, hop-count loop guard. Pure: no database, no network.
import { describe, expect, it } from "vitest";
import {
  formatHandoff,
  handoffAtHopLimit,
  handoffMachineLine,
  parseHandoff,
  relayHandoff,
  type BotHandoff,
} from "@/services/bots/handoff";

const RESOLVE = (username: string) => {
  if (username === "MaintenanceBot") return "maintenance" as const;
  if (username === "DispatchScoutBot") return "dispatch-scout" as const;
  if (username === "TrackerBot") return "tracker" as const;
  return null;
};

describe("bot-to-bot handoffs — format and parse", () => {
  it("round-trips a handoff through the command-mention line", () => {
    const handoff: BotHandoff = {
      to: "maintenance",
      from: "dispatch-scout",
      job: "runnable",
      state: { truck: "2" },
      hops: 0,
    };
    const text = formatHandoff(handoff, "MaintenanceBot");
    expect(text.split("\n")[0]).toBe("/handoff@MaintenanceBot job=runnable truck=2 hops=0");
    expect(text).toContain("Dispatch Scout → Maintenance: is truck 2 runnable?");
    const parsed = parseHandoff(text, "dispatch-scout", RESOLVE);
    expect(parsed).toEqual(handoff);
  });

  it("sanitizes state values to whitespace-free tokens", () => {
    const text = handoffMachineLine(
      {
        to: "dispatch-scout",
        from: "maintenance",
        job: "progress",
        state: { about: "truck-down", truck: "2", defect: "flat tire" },
        hops: 0,
      },
      "DispatchScoutBot",
    );
    expect(text).toBe("/handoff@DispatchScoutBot job=progress about=truck-down truck=2 defect=flat-tire hops=0");
  });

  it("falls back to a plain addressed line without a username — relay-only, never parsed as a command", () => {
    const text = formatHandoff(
      { to: "maintenance", from: "abel", job: "route", state: { keywords: "dot,inspection" }, hops: 0 },
      null,
    );
    expect(text.split("\n")[0]).toBe("Maintenance — handoff: job=route keywords=dot,inspection hops=0");
    expect(parseHandoff(text, "abel", RESOLVE)).toBeNull();
  });

  it("rejects a handoff to an unknown username, an unknown job, or a missing job", () => {
    expect(parseHandoff("/handoff@NobodyBot job=runnable truck=2 hops=0", "dispatch-scout", RESOLVE)).toBeNull();
    expect(parseHandoff("/handoff@MaintenanceBot job=bogus hops=0", "dispatch-scout", RESOLVE)).toBeNull();
    expect(parseHandoff("/handoff@MaintenanceBot hops=0", "dispatch-scout", RESOLVE)).toBeNull();
    expect(parseHandoff("is truck 2 runnable?", "dispatch-scout", RESOLVE)).toBeNull();
  });

  it("takes the sender from the message author, never from the line", () => {
    const parsed = parseHandoff("/handoff@MaintenanceBot job=runnable truck=2 hops=1", "dispatch-scout", RESOLVE);
    expect(parsed?.from).toBe("dispatch-scout");
    expect(parsed?.hops).toBe(1);
  });

  it("defaults a non-numeric hop count to zero instead of failing", () => {
    const parsed = parseHandoff("/handoff@MaintenanceBot job=runnable hops=soon", "dispatch-scout", RESOLVE);
    expect(parsed?.hops).toBe(0);
  });
});

describe("bot-to-bot handoffs — loop suppression", () => {
  it("drops at three hops, allows fewer", () => {
    const base: BotHandoff = { to: "maintenance", from: "abel", job: "route", state: {}, hops: 0 };
    expect(handoffAtHopLimit(base)).toBe(false);
    expect(handoffAtHopLimit({ ...base, hops: 2 })).toBe(false);
    expect(handoffAtHopLimit({ ...base, hops: 3 })).toBe(true);
    expect(handoffAtHopLimit({ ...base, hops: 4 })).toBe(true);
  });

  it("a relay increments the hop count and hands the sender role over, never resets", () => {
    const first: BotHandoff = { to: "maintenance", from: "abel", job: "route", state: { keywords: "tire" }, hops: 0 };
    const relayed = relayHandoff(first, "tracker", "location", { truck: "2" });
    expect(relayed).toEqual({ to: "tracker", from: "maintenance", job: "location", state: { truck: "2" }, hops: 1 });
  });
});
