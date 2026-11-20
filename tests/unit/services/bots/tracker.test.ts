// Tracker: check calls, ETA, detention, POD/BOL, escalation, team-room
// speech + handoffs, and the shared ten reasoning forms.
import { describe, expect, it } from "vitest";
import {
  buildHandoffPayload,
  checkTrackerAction,
  composeHandoff,
  decideTrackerSpeech,
  detectEscalation,
  detectHandoffNeed,
  detentionStatus,
  addressesTracker,
  computeEta,
  formatCheckCall,
  MAX_HANDOFF_DEPTH,
  nextHandoffDepth,
  parseCheckCall,
  parseDocReceipt,
  podPacketStatus,
  trackerSystemPrompt,
  TRACKER_REASONING_FORMS,
} from "@/services/bots/tracker";
import type { DetentionStop } from "@/services/bot/detention";

const NOW = Date.parse("2026-11-19T14:00:00-06:00");

describe("tracker reasoning — all ten forms, shared verbatim", () => {
  it("names exactly the ten canonical forms", () => {
    expect([...TRACKER_REASONING_FORMS]).toEqual([
      "temporal",
      "contextual",
      "causal",
      "practical",
      "self-correction",
      "episodic",
      "theory-of-mind",
      "value-learning",
      "consolidation",
      "restraint",
    ]);
  });

  it("carries every form's marker text in its system prompt", () => {
    const prompt = trackerSystemPrompt();
    for (const marker of [
      "TIME:",
      "CONTEXT:",
      "CAUSE BEFORE CONCLUSION:",
      "PRACTICAL:",
      "OWN YOUR MISTAKES:",
      "EPISODES, NOT JUST FACTS:",
      "WHAT HE KNOWS:",
      "LEARN WHAT HE VALUES FROM WHAT HE DOES:",
      "USE WHAT YOU ALREADY LEARNED:",
      "KNOW WHEN TO STOP:",
    ]) {
      expect(prompt).toContain(marker);
    }
    // The think-deeper blocks ride with the ten — nothing cut down.
    for (const marker of ["PLAN THEN ACT:", "CHECK BEFORE YOU SEND:", "SAY WHAT YOU DON'T KNOW:", "SHOW BOTH SIDES OF THE MATH:", "FORECAST, DON'T BLOCK:"]) {
      expect(prompt).toContain(marker);
    }
  });

  it("states its job and its hard limits, and never claims money or booking", () => {
    const prompt = trackerSystemPrompt();
    expect(prompt).toMatch(/check-call bot/);
    expect(prompt).toMatch(/detention clock/);
    expect(prompt).toMatch(/POD \/ BOL/);
    expect(prompt).toMatch(/Money \/ Pay: NO ACCESS/);
    expect(prompt).toMatch(/never book, cancel, or reassign a load/);
    expect(prompt).toMatch(/never edit a log/);
  });

  it("states the team-room rule: talk to the other bots by name, hand work off, owner only for decisions", () => {
    const prompt = trackerSystemPrompt();
    expect(prompt).toMatch(/team room/);
    expect(prompt).toMatch(/Talk to them by name/);
    expect(prompt).toMatch(/Only pull the owner in when a decision or approval actually needs him/);
  });
});

describe("tracker speech — the team room (owner rule 2026-11-19)", () => {
  it("speaks in its own 1:1 chat, directly", () => {
    expect(decideTrackerSpeech({ context: "direct", via: "default", senderKind: "owner" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "direct", via: "default", senderKind: "owner", isTrackerJob: false }).speak).toBe(true);
  });

  it("speaks on its own turn, when called by name, on a reply, and when Abel routes it", () => {
    expect(decideTrackerSpeech({ context: "group", via: "own-turn", senderKind: "owner" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "group", via: "mention", senderKind: "owner" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "group", via: "reply", senderKind: "owner" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "group", via: "abel-route", senderKind: "owner" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "group", via: "default", senderKind: "owner", routedByAbel: true }).speak).toBe(true);
  });

  it("speaks on its job by keyword — it has something to add, so it says it out loud", () => {
    const decision = decideTrackerSpeech({ context: "group", via: "keyword", senderKind: "owner" });
    expect(decision.speak).toBe(true);
    expect(decision.reason).toMatch(/something to add/);
  });

  it("stays quiet when it has nothing to add", () => {
    expect(decideTrackerSpeech({ context: "group", via: "default", senderKind: "owner" }).speak).toBe(false);
  });

  it("answers another bot ONLY when that bot addresses it — the loop guard", () => {
    expect(decideTrackerSpeech({ context: "group", via: "keyword", senderKind: "bot" }).speak).toBe(false);
    expect(decideTrackerSpeech({ context: "group", via: "mention", senderKind: "bot" }).speak).toBe(true);
    expect(decideTrackerSpeech({ context: "group", via: "reply", senderKind: "bot" }).speak).toBe(true);
  });

  it("recognises being addressed by name", () => {
    expect(addressesTracker("Tracker, what's the ETA?")).toBe(true);
    expect(addressesTracker("hey tracker")).toBe(true);
    expect(addressesTracker("what's the eta?")).toBe(false);
  });
});

describe("tracker check calls", () => {
  it("parses picked up / delivered / arrived / en route / departed with the place", () => {
    expect(parseCheckCall("picked up at the shipper in Panama City")).toEqual({ kind: "picked_up", place: "the shipper in Panama City" });
    expect(parseCheckCall("delivered at Dollar Tree DC 8")).toEqual({ kind: "delivered", place: "Dollar Tree DC 8" });
    expect(parseCheckCall("arrived at the receiver")).toEqual({ kind: "arrived", place: "the receiver" });
    expect(parseCheckCall("en route to Hattiesburg")).toEqual({ kind: "en_route", place: "Hattiesburg" });
    expect(parseCheckCall("left the receiver")).toEqual({ kind: "departed", place: "the receiver" });
  });

  it("prefers picked up over arrived when both appear", () => {
    expect(parseCheckCall("arrived, picked up at the shipper")?.kind).toBe("picked_up");
  });

  it("returns null when the message carries no check call", () => {
    expect(parseCheckCall("what's my pay this week?")).toBeNull();
    expect(parseCheckCall("left lane is closed")).toBeNull();
  });

  it("formats one line: what happened, where, when", () => {
    const line = formatCheckCall({ kind: "picked_up", place: "Panama City, FL" }, NOW);
    expect(line).toMatch(/^Picked up — Panama City, FL, \d+:\d+ [AP]M\.$/);
  });
});

describe("tracker ETA", () => {
  it("computes ETA from measured miles and speed only", () => {
    const eta = computeEta(120, 60, NOW);
    expect(eta).not.toBeNull();
    expect(eta!.etaMs).toBe(NOW + 2 * 3_600_000);
    expect(eta!.driveTimeLeft).toBe("about 2h 00m");
    expect(eta!.etaClock).toMatch(/\d+:\d+ [AP]M/);
  });

  it("refuses to invent a speed, a distance, or a time", () => {
    expect(computeEta(120, 0, NOW)).toBeNull();
    expect(computeEta(-5, 60, NOW)).toBeNull();
    expect(computeEta(Number.NaN, 60, NOW)).toBeNull();
  });
});

describe("tracker detention clock — the same 2-hour rule as Abel", () => {
  const stop = (overrides: Partial<DetentionStop> = {}): DetentionStop => ({
    id: "stop-1",
    label: "the receiver",
    arrivedAt: "2026-11-19T12:00:00-06:00",
    departedAt: null,
    appointmentAt: null,
    ...overrides,
  });

  it("is within free time before arrival + 2h", () => {
    const status = detentionStatus(stop(), Date.parse("2026-11-19T13:30:00-06:00"));
    expect(status.state).toBe("within-free-time");
    expect(status.detentionMs).toBe(0);
    expect(status.freeTimeEndsMs).toBe(Date.parse("2026-11-19T14:00:00-06:00"));
  });

  it("runs past the free time, and says so", () => {
    const status = detentionStatus(stop(), Date.parse("2026-11-19T15:30:00-06:00"));
    expect(status.state).toBe("detention-running");
    expect(status.detentionMs).toBe(90 * 60_000);
    expect(status.line).toMatch(/Detention is running at the receiver: 1h 30m/);
  });

  it("starts the clock at the appointment when the appointment is later than arrival", () => {
    const status = detentionStatus(stop({ appointmentAt: "2026-11-19T13:00:00-06:00" }), Date.parse("2026-11-19T14:30:00-06:00"));
    expect(status.state).toBe("within-free-time");
    expect(status.freeTimeEndsMs).toBe(Date.parse("2026-11-19T15:00:00-06:00"));
  });

  it("reports the total when the truck leaves in detention", () => {
    const status = detentionStatus(stop({ departedAt: "2026-11-19T16:00:00-06:00" }), Date.parse("2026-11-19T17:00:00-06:00"));
    expect(status.state).toBe("detention-ended");
    expect(status.detentionMs).toBe(2 * 3_600_000);
    expect(status.line).toMatch(/Detention at the receiver: 2h 00m/);
  });

  it("reports no detention when the truck leaves inside free time", () => {
    const status = detentionStatus(stop({ departedAt: "2026-11-19T13:00:00-06:00" }), Date.parse("2026-11-19T14:00:00-06:00"));
    expect(status.state).toBe("within-free-time");
    expect(status.line).toMatch(/No detention/);
  });
});

describe("tracker POD/BOL packet", () => {
  it("is complete only with both halves", () => {
    expect(podPacketStatus({ bolReceived: true, podReceived: true }).complete).toBe(true);
    expect(podPacketStatus({ bolReceived: true, podReceived: false }).missing).toEqual(["POD"]);
    expect(podPacketStatus({ bolReceived: false, podReceived: false }).missing).toEqual(["BOL", "POD"]);
  });

  it("parses receipts out of a message", () => {
    expect(parseDocReceipt("POD sent")).toEqual({ bol: false, pod: true });
    expect(parseDocReceipt("BOL attached")).toEqual({ bol: true, pod: false });
    expect(parseDocReceipt("paperwork done")).toEqual({ bol: true, pod: true });
    expect(parseDocReceipt("what's the ETA?")).toBeNull();
  });
});

describe("tracker escalation — flag at once, never smooth over", () => {
  it("escalates a refused load, a detention dispute, a reschedule, and an undeliverable", () => {
    expect(detectEscalation("the load was refused at the dock")?.kind).toBe("refused-load");
    expect(detectEscalation("they won't pay the detention, this is a dispute")?.kind).toBe("detention-dispute");
    expect(detectEscalation("delivery rescheduled to Friday")?.kind).toBe("reschedule");
    expect(detectEscalation("I can't deliver this, the road is closed")?.kind).toBe("undeliverable");
  });

  it("does not escalate its own status lines", () => {
    expect(detectEscalation("detention is running at the receiver")).toBeNull();
    expect(detectEscalation("reschedule the check call to 3pm")).toBeNull();
    expect(detectEscalation("picked up, en route")).toBeNull();
  });
});

describe("tracker handoffs — asking another bot for work it needs", () => {
  it("asks Maintenance for a runnable check before confirming an ETA", () => {
    const handoff = detectHandoffNeed("Tracker, what's the ETA? The tire is flat");
    expect(handoff?.to).toBe("maintenance");
    expect(composeHandoff(handoff!)).toMatch(/^Maintenance — I need a runnable check/);
    expect(composeHandoff(handoff!)).toMatch(/I'll post the ETA as soon as Maintenance clears it/);
  });

  it("asks Billing when a broker asks about payment", () => {
    expect(detectHandoffNeed("Tracker, broker is asking when the detention pay lands")?.to).toBe("billing");
  });

  it("asks the Watchdog for an hours verdict before promising an arrival", () => {
    expect(detectHandoffNeed("Tracker, can I make it to Dallas on my hours?")?.to).toBe("compliance-watchdog");
  });

  it("asks the Scout for a reload and the Auditor for a math check", () => {
    expect(detectHandoffNeed("find me a reload near the delivery")?.to).toBe("dispatch-scout");
    expect(detectHandoffNeed("check my ETA math before I send it")?.to).toBe("auditor");
  });

  it("does not hand off when it can proceed on its own", () => {
    expect(detectHandoffNeed("Tracker, what's my ETA?")).toBeNull();
    expect(detectHandoffNeed("picked up at the shipper")).toBeNull();
  });

  it("caps handoff chains at three — then it escalates to Abel instead", () => {
    expect(MAX_HANDOFF_DEPTH).toBe(3);
    expect(nextHandoffDepth(null)).toBe(0);
    expect(nextHandoffDepth(2)).toBe(3);
    expect(nextHandoffDepth(3)).toBeNull();
  });

  it("carries validated state only — objective, load, what happens next; never a transcript", () => {
    const handoff = detectHandoffNeed("Tracker, what's the ETA? The tire is flat")!;
    const payload = buildHandoffPayload(handoff, "Trip 1903");
    expect(payload).toEqual({
      loadRef: "Trip 1903",
      objective: handoff.what,
      then: handoff.then,
    });
    expect(JSON.stringify(payload)).not.toContain("tire is flat");
  });
});

describe("tracker guardrails — scoped tools, propose-only", () => {
  it("lets Tracker log check calls, update load status, record documents, and start detention", () => {
    expect(checkTrackerAction({ actionKind: "log_check_call", group: "loads" }).allowed).toBe(true);
    expect(checkTrackerAction({ actionKind: "update_load_status", group: "loads" }).allowed).toBe(true);
    expect(checkTrackerAction({ actionKind: "record_document", group: "documents" }).allowed).toBe(true);
    expect(checkTrackerAction({ actionKind: "start_detention", group: "loads" }).allowed).toBe(true);
    expect(checkTrackerAction({ actionKind: "read", group: "hos" }).allowed).toBe(true);
    expect(checkTrackerAction({ actionKind: "read", group: "maps" }).allowed).toBe(true);
  });

  it("denies Tracker money, booking, HOS edits, and external sends without a proposal", () => {
    expect(checkTrackerAction({ actionKind: "read", group: "money" }).allowed).toBe(false);
    expect(checkTrackerAction({ actionKind: "book_load", group: "loads" }).allowed).toBe(false);
    expect(checkTrackerAction({ actionKind: "change_hos_log", group: "hos" }).allowed).toBe(false);
    expect(checkTrackerAction({ actionKind: "send_to_broker", group: "email" }).allowed).toBe(false);
    expect(checkTrackerAction({ actionKind: "send_to_shipper", group: "email" }).allowed).toBe(false);
    expect(checkTrackerAction({ actionKind: "call_outbound", group: "calls" }).allowed).toBe(false);
  });

  it("still refuses execute-class actions WITH an approved proposal in this phase — no execution path exists yet", () => {
    const verdict = checkTrackerAction({ actionKind: "send_to_broker", group: "email", hasApprovedProposal: true });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/no execution path/i);
  });
});
