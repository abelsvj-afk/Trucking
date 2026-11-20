// Shared reasoning layer: every bot carries Abel's full reasoning —
// all ten core forms and the five think-deeper forms, the same rule
// blocks Abel's own prompt assembles — while its tool scope and its
// memory stay its own seat's. Sharing the reasoning must never leak
// another bot's tools or another bot's memory.
import { describe, expect, it } from "vitest";
import {
  REASONING_FORMS,
  buildBotMemoryContext,
  buildBotSystemPrompt,
  sharedReasoningPrompt,
  toolScopeFraming,
} from "@/services/bots/reasoning";
import { BOT_SLUGS, visibleToolGroups, type ToolGroup } from "@/services/bots/registry";
import type { BotMemoryRow } from "@/services/bots/store";

// One distinctive marker per form, matched the same way Abel's own
// prompt-assembly test matches them (agent-turn.test.ts).
const FORM_MARKERS: { id: string; marker: string }[] = [
  { id: "temporal", marker: "TIME: never work out a weekday" },
  { id: "contextual", marker: "CONTEXT: hold the whole thread" },
  { id: "causal", marker: "CAUSE BEFORE CONCLUSION" },
  { id: "practical", marker: "PRACTICAL: fit the action to the moment" },
  { id: "self-correction", marker: "OWN YOUR MISTAKES" },
  { id: "episodic", marker: "EPISODES, NOT JUST FACTS" },
  { id: "theory-of-mind", marker: "WHAT HE KNOWS" },
  { id: "value-learning", marker: "LEARN WHAT HE VALUES FROM WHAT HE DOES" },
  { id: "consolidation", marker: "USE WHAT YOU ALREADY LEARNED" },
  { id: "restraint", marker: "KNOW WHEN TO STOP" },
  { id: "chained", marker: "PLAN THEN ACT" },
  { id: "self-verification", marker: "CHECK BEFORE YOU SEND" },
  { id: "honest-uncertainty", marker: "SAY WHAT YOU DON'T KNOW" },
  { id: "trade-off-math", marker: "SHOW BOTH SIDES OF THE MATH" },
  { id: "causal-prediction", marker: "FORECAST, DON'T BLOCK" },
];

function count(haystack: string, marker: string): number {
  return haystack.split(marker).length - 1;
}

function memoryRow(partial: Partial<BotMemoryRow> & { content: string }): BotMemoryRow {
  return {
    id: "row-1",
    bot_slug: "abel",
    kind: "fact",
    source: "test",
    created_at: new Date().toISOString(),
    ...partial,
  };
}

describe("the shared reasoning forms", () => {
  it("names all ten core forms and the five think-deeper forms, in Abel's order", () => {
    expect(REASONING_FORMS.filter((f) => f.layer === "core").map((f) => f.id)).toEqual([
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
    expect(REASONING_FORMS.filter((f) => f.layer === "think-deeper").map((f) => f.id)).toEqual([
      "chained",
      "self-verification",
      "honest-uncertainty",
      "trade-off-math",
      "causal-prediction",
    ]);
  });

  it("assembles every form's block exactly once in the shared prompt", () => {
    const prompt = sharedReasoningPrompt();
    for (const { id, marker } of FORM_MARKERS) {
      expect(count(prompt, marker), id).toBe(1);
    }
  });

  it("gives EVERY bot the full brain — no cut-down version for any seat", () => {
    for (const slug of BOT_SLUGS) {
      const prompt = buildBotSystemPrompt(slug);
      expect(prompt, slug).not.toBeNull();
      for (const { id, marker } of FORM_MARKERS) {
        expect(count(prompt ?? "", marker), `${slug}/${id}`).toBe(1);
      }
    }
  });

  it("refuses an unknown slug instead of handing it Abel's brain by accident", () => {
    expect(buildBotSystemPrompt("not-a-bot")).toBeNull();
    expect(buildBotSystemPrompt("")).toBeNull();
  });
});

describe("tool scope framing — the reasoning is shared, the tools are not", () => {
  const GROUP_LINES: { group: ToolGroup; line: RegExp }[] = [
    { group: "loads", line: /^- loads: /m },
    { group: "hos", line: /^- hours \(HOS\): /m },
    { group: "money", line: /^- money: /m },
    { group: "documents", line: /^- documents: /m },
    { group: "email", line: /^- email: /m },
    { group: "maps", line: /^- maps: /m },
    { group: "app-actions", line: /^- app actions: /m },
    { group: "calls", line: /^- phone calls: /m },
    { group: "signature", line: /^- signing documents: /m },
  ];

  it("names exactly the bot's own visible groups — never another bot's", () => {
    for (const slug of BOT_SLUGS) {
      const framing = toolScopeFraming(slug);
      const visible = visibleToolGroups(slug);
      for (const { group, line } of GROUP_LINES) {
        if (visible.includes(group)) {
          expect(framing, `${slug} should name ${group}`).toMatch(line);
        } else {
          expect(framing, `${slug} must not name ${group}`).not.toMatch(line);
        }
      }
    }
  });

  it("the Auditor — read/flag only — is never told it can call, sign, or send", () => {
    const framing = toolScopeFraming("auditor");
    expect(framing).not.toMatch(/^- phone calls: /m);
    expect(framing).not.toMatch(/^- signing documents: /m);
    expect(framing).toMatch(/do not exist for you/);
  });

  it("the Tracker has no money or email scope in its framing", () => {
    const framing = toolScopeFraming("tracker");
    expect(framing).not.toMatch(/^- money: /m);
    expect(framing).not.toMatch(/^- email: /m);
  });
});

describe("per-bot memory context", () => {
  it("renders the bot's own facts, preferences, and standing rules", () => {
    const context = buildBotMemoryContext([
      memoryRow({ kind: "fact", content: "He parks at the Hattiesburg Walmart when passing through." }),
      memoryRow({ kind: "preference", content: "Prefers loads that end near home on Fridays." }),
      memoryRow({ kind: "rule", content: "Never quote a rate you have not loaded." }),
    ]);
    expect(context).toContain("Hattiesburg Walmart");
    expect(context).toContain("end near home on Fridays");
    expect(context).toContain("YOUR STANDING RULES");
    expect(context).toContain("Never quote a rate");
  });

  it("puts watch-outs derived from its own corrections first, and does not list the raw correction rows", () => {
    const context = buildBotMemoryContext([
      memoryRow({ kind: "correction", content: "corrected fields: rate" }),
      memoryRow({ kind: "correction", content: "corrected fields: rate" }),
      memoryRow({ kind: "fact", content: "Some fact." }),
    ]);
    expect(context).toMatch(/^WATCH-OUTS FROM HIS OWN CORRECTIONS \(/);
    expect(context).toContain("- rate: corrected 2 times");
    expect(context).not.toContain("corrected fields:");
  });

  it("a single correction is not yet a watch-out", () => {
    const context = buildBotMemoryContext([memoryRow({ kind: "correction", content: "corrected fields: rate" })]);
    expect(context).not.toContain("WATCH-OUTS");
  });

  it("a stored watch-out stands even when its correction rows are no longer in the window", () => {
    const context = buildBotMemoryContext([
      memoryRow({ kind: "watch-out", content: "rate: corrected 2 times — double-check it against the source before using it, or ask him for the value instead of guessing." }),
    ]);
    expect(context).toContain("WATCH-OUTS FROM HIS OWN CORRECTIONS:");
    expect(context).toContain("rate: corrected 2 times");
  });

  it("empty memory renders an empty context — no invented content", () => {
    expect(buildBotMemoryContext([])).toBe("");
  });
});

describe("the Auditor on the shared brain (branch feat/bot-auditor-2026-11-19)", () => {
  it("scopes the framing to the Auditor's seat: six reads + flag, never calls or signature", () => {
    const framing = toolScopeFraming("auditor");
    expect(framing).toContain("- loads: read");
    expect(framing).toContain("- money: read");
    expect(framing).toContain("- app actions: flag");
    expect(framing).not.toContain("phone calls");
    expect(framing).not.toContain("signing documents");
    expect(framing).toContain("Tool groups not listed here do not exist for you");
  });

  it("composes the Auditor's prompt overlay-first over the full shared brain", async () => {
    const { AUDITOR_REASONING_OVERLAY, buildAuditorSystemPrompt } = await import("@/services/bots/auditor");
    const prompt = buildAuditorSystemPrompt();
    expect(prompt.startsWith(AUDITOR_REASONING_OVERLAY)).toBe(true);
    expect(prompt).toContain("FLAG, NEVER FIX");
    expect(prompt).toContain("CANNOT VERIFY IS AN ANSWER");
    expect(prompt).toContain("WORK OUT LOUD IN THE ROOM");
    // The overlay scopes the brain; it never replaces it — all
    // fifteen shared forms are still present, exactly once each.
    for (const { id, marker } of FORM_MARKERS) {
      expect(count(prompt, marker), id).toBe(1);
    }
  });
});
