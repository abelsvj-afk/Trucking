// Abel Job Brain (§11). People & business learning formats: the
// structured one-line profile format must round-trip exactly -
// profiles are proposed as text, stored as text in bot_memories,
// and parsed back whenever the brain needs "what do we know about
// this person".

import { describe, expect, it } from "vitest";
import {
  formatBusinessFact,
  formatPersonProfile,
  isBusinessFact,
  isPersonProfile,
  parseBusinessFact,
  parsePersonProfile,
  profilesForPerson,
} from "@/services/bot/people";
import type { BotMemoryRow } from "@/services/telegram/context";

function memory(kind: BotMemoryRow["kind"], content: string): BotMemoryRow {
  return { kind, content, created_at: "2026-10-31T00:00:00.000Z" };
}

describe("person profiles", () => {
  it("round-trips a profile with a role", () => {
    const line = formatPersonProfile({
      name: "Steven",
      role: "truck owner",
      facts: ["Settles pay on Fridays.", "Prefers Spanish."],
    });
    expect(line).toBe("PERSON — Steven | role: truck owner | Settles pay on Fridays. Prefers Spanish.");
    expect(parsePersonProfile(line)).toEqual({
      name: "Steven",
      role: "truck owner",
      facts: ["Settles pay on Fridays. Prefers Spanish."],
    });
  });

  it("round-trips a profile with no role and no facts yet", () => {
    const line = formatPersonProfile({ name: "Maria", role: null, facts: [] });
    expect(line).toBe("PERSON — Maria");
    expect(parsePersonProfile(line)).toEqual({ name: "Maria", role: null, facts: [] });
  });

  it("returns null for content that is not a profile", () => {
    expect(parsePersonProfile("Steven settles pay on Fridays")).toBeNull();
    expect(parsePersonProfile("")).toBeNull();
  });

  it("finds profiles by person, case-insensitively, including prefix-only rows from the fallback path", () => {
    const memories = [
      memory("person_profile", formatPersonProfile({ name: "Steven", role: "truck owner", facts: ["Owns the truck."] })),
      // The no-tools fallback path stores profiles as plain facts
      // with the same format line - they must still read as profiles.
      memory("fact", formatPersonProfile({ name: "Steven", role: null, facts: ["Added later."] })),
      memory("fact", "Diesel was mentioned"),
      memory("business_fact", formatBusinessFact("Pay at this carrier", "Settled weekly.")),
    ];
    expect(isPersonProfile(memories[1]!)).toBe(true);
    expect(profilesForPerson(memories, "steven")).toHaveLength(2);
    expect(profilesForPerson(memories, "Nobody")).toHaveLength(0);
  });
});

describe("business facts", () => {
  it("round-trips a business fact", () => {
    const line = formatBusinessFact("How Steven's operation settles", "Percentage of gross, Fridays.");
    expect(line).toBe("BUSINESS — How Steven's operation settles | Percentage of gross, Fridays.");
    expect(parseBusinessFact(line)).toEqual({
      subject: "How Steven's operation settles",
      fact: "Percentage of gross, Fridays.",
    });
    expect(isBusinessFact(memory("business_fact", line))).toBe(true);
    expect(parseBusinessFact("just a note")).toBeNull();
  });
});
