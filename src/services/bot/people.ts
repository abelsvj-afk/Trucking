// Abel Job Brain (docs/design/driver-mvp.md §11). People & business
// learning: structured profiles of the people the owner works with
// (the truck owner, carrier dispatchers, brokers, shippers) and the
// business facts of how his operation actually runs, learned from
// the conversations he forwards and the corrections he makes.
//
// Storage is the existing bot_memories table with two dedicated
// kinds (migration 00028): "person_profile" and "business_fact".
// The CONTENT is one structured line in a fixed format, so profiles
// are parseable, mergeable, and readable verbatim in any surface:
//
//   PERSON — Steven | role: truck owner | Pays on Fridays. Runs a
//   second truck leased on to the carrier. Prefers Spanish.
//
//   BUSINESS — How this carrier pays | Percentage of gross, settled
//   weekly, 7 days after delivery.
//
// Profiles are written ONLY through the agent's propose->yes write
// path (the save_memory tool) - the bot proposes what it learned,
// the owner confirms, and a correction replaces the profile line.
// Nothing about any real person is seeded in code; profiles start
// empty and fill from his actual forwards.

import type { BotMemoryRow } from "@/services/telegram/context";

export const PERSON_PROFILE_KIND = "person_profile";
export const BUSINESS_FACT_KIND = "business_fact";

const PERSON_PREFIX = "PERSON — ";
const BUSINESS_PREFIX = "BUSINESS — ";

export interface PersonProfile {
  name: string;
  role: string | null;
  facts: string[];
}

export function formatPersonProfile(profile: PersonProfile): string {
  const head = `${PERSON_PREFIX}${profile.name}${profile.role ? ` | role: ${profile.role}` : ""}`;
  return profile.facts.length > 0 ? `${head} | ${profile.facts.join(" ")}` : head;
}

export function formatBusinessFact(subject: string, fact: string): string {
  return `${BUSINESS_PREFIX}${subject} | ${fact}`;
}

/** Parses a stored profile line back into its parts; null when the content isn't one. */
export function parsePersonProfile(content: string): PersonProfile | null {
  if (!content.startsWith(PERSON_PREFIX)) return null;
  const rest = content.slice(PERSON_PREFIX.length);
  const [head, ...factParts] = rest.split(" | ");
  if (!head) return null;
  let name = head;
  let role: string | null = null;
  const factText = factParts.join(" | ");
  // The role rides in the head segment as "Name | role: X" - after
  // the split it is the first factPart when present.
  const rolePart = factParts[0]?.startsWith("role: ") ? factParts[0] : null;
  if (rolePart) {
    role = rolePart.slice("role: ".length).trim() || null;
    const facts = factParts.slice(1).join(" | ");
    return { name: name.trim(), role, facts: facts ? [facts] : [] };
  }
  return { name: name.trim(), role, facts: factText ? [factText] : [] };
}

export function parseBusinessFact(content: string): { subject: string; fact: string } | null {
  if (!content.startsWith(BUSINESS_PREFIX)) return null;
  const rest = content.slice(BUSINESS_PREFIX.length);
  const separator = rest.indexOf(" | ");
  if (separator === -1) return { subject: rest.trim(), fact: "" };
  return {
    subject: rest.slice(0, separator).trim(),
    fact: rest.slice(separator + 3).trim(),
  };
}

export function isPersonProfile(memory: BotMemoryRow): boolean {
  return memory.kind === PERSON_PROFILE_KIND || memory.content.startsWith(PERSON_PREFIX);
}

export function isBusinessFact(memory: BotMemoryRow): boolean {
  return memory.kind === BUSINESS_FACT_KIND || memory.content.startsWith(BUSINESS_PREFIX);
}

/** Every stored profile for one person (by exact name, case-insensitive) - usually one; corrections supersede by rewrite, not by piling up. */
export function profilesForPerson(memories: BotMemoryRow[], name: string): PersonProfile[] {
  const wanted = name.trim().toLowerCase();
  return memories
    .filter(isPersonProfile)
    .map((memory) => parsePersonProfile(memory.content))
    .filter((profile): profile is PersonProfile => profile !== null)
    .filter((profile) => profile.name.toLowerCase() === wanted);
}
