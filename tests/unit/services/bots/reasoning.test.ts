// Shared reasoning: every bot's prompt carries the same ten
// reasoning forms + the five think-deeper forms, verbatim, with
// only the identity and scope line differing. The owner asked to
// see all ten named exactly as they exist in the code — the
// markers below ARE those names.
import { describe, expect, it } from "vitest";
import { BOT_SLUGS, type BotSlug } from "@/services/bots/registry";
import {
  buildBotSystemPrompt,
  formatSharedReasoning,
  SHARED_REASONING_MARKERS,
  SHARED_REASONING_TEXT,
  TEN_REASONING_FORMS,
  THINK_DEEPER_FORMS,
} from "@/services/bots/reasoning";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const IDENTITY_OPENERS: Record<BotSlug, string> = {
  abel: "You are Abel",
  "dispatch-scout": "You are the Dispatch Scout",
  tracker: "You are the Tracker",
  "compliance-watchdog": "You are the Compliance Watchdog",
  maintenance: "You are the Maintenance bot",
  billing: "You are the Billing bot",
  auditor: "You are the Auditor",
};

describe("shared reasoning", () => {
  it("names all ten reasoning forms, plus the five think-deeper forms", () => {
    expect(TEN_REASONING_FORMS).toHaveLength(10);
    expect(THINK_DEEPER_FORMS).toHaveLength(5);
    expect(SHARED_REASONING_MARKERS).toHaveLength(15);
  });

  it("carries every shared block exactly once in the shared text", () => {
    for (const marker of SHARED_REASONING_MARKERS) {
      expect(countOccurrences(SHARED_REASONING_TEXT, marker)).toBe(1);
    }
    expect(formatSharedReasoning()).toBe(SHARED_REASONING_TEXT);
  });

  it("gives every bot the same reasoning — all fifteen markers, exactly once, no cut-down versions", () => {
    for (const slug of BOT_SLUGS) {
      const prompt = buildBotSystemPrompt(slug);
      for (const marker of SHARED_REASONING_MARKERS) {
        expect(countOccurrences(prompt, marker)).toBe(1);
      }
    }
  });

  it("gives every bot only its own identity — never another bot's", () => {
    for (const slug of BOT_SLUGS) {
      const prompt = buildBotSystemPrompt(slug);
      expect(prompt).toContain(IDENTITY_OPENERS[slug]);
      for (const other of BOT_SLUGS) {
        if (other === slug) continue;
        expect(prompt).not.toContain(IDENTITY_OPENERS[other]);
      }
    }
  });

  it("tells every bot the room shape: its own Telegram account, handoffs inside the app", () => {
    for (const slug of BOT_SLUGS) {
      const prompt = buildBotSystemPrompt(slug);
      expect(prompt).toContain("its own Telegram account and profile photo");
      expect(prompt).toContain("Telegram does not deliver one bot's messages to another bot");
      expect(prompt).toContain("PROPOSE ONLY");
    }
  });

  it("gives Abel the team-room rule, not the old strict-routing rule", () => {
    const prompt = buildBotSystemPrompt("abel");
    expect(prompt).toContain("TEAM ROOM");
    expect(prompt).toContain("only pull him in when a decision or approval is needed");
    expect(prompt).not.toContain("only that bot answers");
    expect(prompt).not.toContain("name the bot that owns it and stop");
  });
});
