// Phase C acceptance (design §4 + owner per-person scope): the
// code half of thread intelligence - append matching, participant
// merge, per-message language shape, evidence-based person models
// with computed confidence, and the life-phase framing block.

import { describe, expect, it } from "vitest";
import {
  buildPersonModel,
  formatOpenLoopsBlock,
  matchThreadForAppend,
  mergeParticipants,
  normalizeName,
  sharedCounterparties,
  threadLanguageFromMessages,
  topTopics,
  type PersonEvidence,
} from "@/services/bot/threads";
import { buildLifePhaseText } from "@/services/bot/life-phase";
import { UNKNOWN_PIN, type PayPin } from "@/services/bot/pay-pin";
import type { ThreadParticipant } from "@/services/ai/thread-extraction";

const P = (name: string, role: ThreadParticipant["role"]): ThreadParticipant => ({ name, role });

describe("append matching (code, conservative)", () => {
  it("the owner never counts as a match; counterparties do", () => {
    expect(sharedCounterparties([P("Sajacous", "owner"), P("Steven", "steven")], [P("Sajacous", "owner")])).toEqual([]);
    expect(
      sharedCounterparties([P("Steven", "steven")], [P("steven", "steven"), P("Dispatch", "carrier_dispatch")]),
    ).toEqual(["steven"]);
  });

  it("picks the open thread with the most shared counterparties; recency breaks ties; no share = new thread", () => {
    const threads = [
      { id: "t-old", participants: [P("Steven", "steven")], updatedAt: "2026-11-01T00:00:00Z" },
      { id: "t-new", participants: [P("Steven", "steven"), P("Maria", "carrier_dispatch")], updatedAt: "2026-11-02T00:00:00Z" },
    ];
    expect(matchThreadForAppend(threads, [P("Steven", "steven"), P("Maria", "carrier_dispatch")])).toBe("t-new");
    expect(matchThreadForAppend(threads, [P("Steven", "steven")])).toBe("t-new"); // tie on 1 share -> most recent
    expect(matchThreadForAppend(threads, [P("Broker Bob", "broker")])).toBeNull();
    expect(matchThreadForAppend([], [P("Steven", "steven")])).toBeNull();
  });

  it("normalizes names (case, punctuation, spacing) for matching", () => {
    expect(normalizeName("  Steven  R. ")).toBe("steven r");
    expect(
      matchThreadForAppend(
        [{ id: "t1", participants: [P("STEVEN", "steven")], updatedAt: "2026-11-01T00:00:00Z" }],
        [P("steven", "steven")],
      ),
    ).toBe("t1");
  });
});

describe("mergeParticipants", () => {
  it("unions by name; a real role upgrades 'other', an established role is never overwritten", () => {
    const merged = mergeParticipants(
      [P("Steven", "other"), P("Maria", "carrier_dispatch")],
      [P("steven", "steven"), P("Maria", "broker"), P("New Guy", "shipper")],
    );
    expect(merged).toHaveLength(3);
    expect(merged.find((p) => p.name === "Steven")?.role).toBe("steven");
    expect(merged.find((p) => p.name === "Maria")?.role).toBe("carrier_dispatch");
  });
});

describe("threadLanguageFromMessages (per-message, §11)", () => {
  it("derives the thread shape from message tags; unknown-only is null", () => {
    expect(threadLanguageFromMessages([{ language: "en" }, { language: "en" }])).toBe("en");
    expect(threadLanguageFromMessages([{ language: "es" }])).toBe("es");
    expect(threadLanguageFromMessages([{ language: "en" }, { language: "es" }])).toBe("mixed");
    expect(threadLanguageFromMessages([{ language: "unknown" }])).toBeNull();
    expect(threadLanguageFromMessages([{ language: "unknown" }, { language: "en" }])).toBe("en");
  });
});

describe("topTopics", () => {
  it("counts a person's own repeated content words; one-offs and stopwords don't become 'topics'", () => {
    const topics = topTopics([
      "the detention at the warehouse was long, detention again",
      "warehouse detention pay, detention detention",
      "ok",
    ]);
    expect(topics[0]).toBe("detention");
    expect(topics).toContain("warehouse");
    expect(topics).not.toContain("ok");
  });
});

describe("buildPersonModel (evidence + confidence, never overstated)", () => {
  const empty: PersonEvidence = { confirmedProfile: null, threads: [], messageBodies: [], exchangeMentions: 0 };

  it("no evidence: says so plainly and proposes nothing", () => {
    const model = buildPersonModel("Ghost", empty);
    expect(model.confidence).toBe("no evidence");
    expect(model.proposedProfileLine).toBeNull();
    expect(model.lines.join("\n")).toContain("nothing honest to model");
  });

  it("thin evidence is labeled thin; the proposed line carries the label and the counts", () => {
    const model = buildPersonModel("Maria", {
      confirmedProfile: null,
      threads: [{ title: "Dispatch — DAL", role: "carrier_dispatch", messagesFromThem: 2, lastActiveAt: "2026-11-01T00:00:00Z" }],
      messageBodies: ["appt moved to friday", "friday appt confirmed"],
      exchangeMentions: 0,
    });
    expect(model.confidence).toBe("thin"); // 1 thread + 2 messages = 3
    expect(model.roleFromEvidence).toBe("carrier_dispatch");
    expect(model.proposedProfileLine).toContain("confidence thin");
    expect(model.proposedProfileLine).toContain("NOT confirmed by him");
    expect(model.lines.join("\n")).toContain("THIN");
  });

  it("a confirmed profile outranks the model and is quoted as his words", () => {
    const model = buildPersonModel("Steven", {
      confirmedProfile: { name: "Steven", role: "truck owner", facts: ["Pays on Fridays."] },
      threads: [{ title: "t", role: "steven", messagesFromThem: 20, lastActiveAt: "2026-11-01T00:00:00Z" }],
      messageBodies: Array(20).fill("settlement friday settlement"),
      exchangeMentions: 3,
    });
    expect(model.confidence).toBe("well-evidenced"); // 1 + 20 + 3 = 24
    expect(model.lines[0]).toContain("Confirmed profile (his approved words");
    expect(model.lines[0]).toContain("Pays on Fridays.");
    expect(model.topics).toContain("settlement");
  });
});

describe("formatOpenLoopsBlock", () => {
  it("null when nothing hangs; lists asks with who waits and deadlines otherwise", () => {
    expect(formatOpenLoopsBlock([])).toBeNull();
    const block = formatOpenLoopsBlock([
      {
        title: "Dispatch — DAL load",
        theAsk: "Confirm the 6pm appointment",
        askOf: "Sajacous",
        deadlineText: "Friday 6pm",
        participants: [P("Maria", "carrier_dispatch"), P("Sajacous", "owner")],
      },
    ]);
    expect(block).toContain("OPEN LOOPS");
    expect(block).toContain("Confirm the 6pm appointment");
    expect(block).toContain("deadline Friday 6pm");
  });
});

describe("buildLifePhaseText", () => {
  it("default: the lease-on learning seat, pin-aware, never W-2 fleet framing", () => {
    const text = buildLifePhaseText(UNKNOWN_PIN, null);
    expect(text).toContain("lease-on learning seat");
    expect(text).toContain("NOT pinned yet");
    expect(text).toContain("never frame him as a career company driver");
  });

  it("pinned pin shows in the framing; his override replaces the default wholesale", () => {
    const pin: PayPin = { ...UNKNOWN_PIN, model: "percentage_gross", rate: 30 };
    expect(buildLifePhaseText(pin, null)).toContain("pinned (percentage_gross at 30)");
    const overridden = buildLifePhaseText(pin, "Own truck bought 2027-01-15; running under his own authority now.");
    expect(overridden).toContain("Own truck bought 2027-01-15");
    expect(overridden).not.toContain("learning seat");
  });
});
