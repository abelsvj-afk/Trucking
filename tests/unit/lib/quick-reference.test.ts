import { describe, expect, it } from "vitest";
import { FOOTER, REFERENCES, REFERENCE_TOPICS, findReference, formatReference } from "@/lib/quick-reference";

describe("quick reference content rules", () => {
  it("every topic has a title, steps and keywords", () => {
    expect(REFERENCE_TOPICS.length).toBeGreaterThanOrEqual(12);
    for (const [key, r] of Object.entries(REFERENCES)) {
      expect(r.title.length, key).toBeGreaterThan(3);
      expect(r.steps.length, key).toBeGreaterThanOrEqual(3);
      expect(r.keywords.length, key).toBeGreaterThan(0);
    }
  });
  it("contains NO dollar amount, fine, rate or tax limit - those change and must never be quoted from memory", () => {
    for (const [key, r] of Object.entries(REFERENCES)) {
      const text = r.steps.join(" ");
      expect(text, key).not.toMatch(/\$\s?\d/);
      expect(text, key).not.toMatch(/\b\d{1,3}(,\d{3})+\b/); // 80,000-style figures
      expect(text, key).not.toMatch(/\b(fine|penalty) of\b/i);
      expect(text, key).not.toMatch(/\bper diem (rate )?(is|of) \d/i);
    }
  });
  it("the only hour/minute figures are the federal HOS limits the app's own clocks use", () => {
    for (const [key, r] of Object.entries(REFERENCES)) {
      if (key === "hos_overview") continue;
      expect(r.steps.join(" "), key).not.toMatch(/\b(11|14|60|70|34)[ -]hour/i);
    }
    const hos = REFERENCES.hos_overview!.steps.join(" ");
    for (const figure of ["11 hours", "14-hour", "30-minute", "8 hours", "60/70-hour", "34-hour", "10 consecutive hours"]) expect(hos).toContain(figure);
  });
  it("is honest about what the app is: a paper-log helper, not a registered ELD", () => {
    expect(REFERENCES.eld_malfunction!.steps.join(" ")).toMatch(/not a registered ELD/);
  });
  it("every formatted answer carries the not-advice footer", () => {
    for (const key of REFERENCE_TOPICS) expect(formatReference(key).endsWith(FOOTER), key).toBe(true);
  });
});

describe("findReference", () => {
  it.each([
    ["I just got a flat tire", "breakdown"], ["what do I do after a crash", "accident"], ["DOT pulled me over for an inspection", "roadside_inspection"],
    ["I lost my BOL", "lost_bol"], ["they're holding me at the dock", "detention"], ["how many hours do I have", "hos_overview"],
    ["my ELD is down", "eld_malfunction"], ["I'm so tired", "fatigue"], ["what can I deduct", "deductions_overview"], ["my settlement is short", "settlement_check"],
    ["breakdown", "breakdown"], ["roadside inspection", "roadside_inspection"], ["lost-bol", "lost_bol"],
  ])("%s -> %s", (query, topic) => expect(findReference(query)).toBe(topic));
  it("returns null for what it does not cover, instead of guessing", () => {
    expect(findReference("what is the capital of France")).toBeNull();
    expect(findReference("")).toBeNull();
    expect(findReference("that symbol looks odd")).toBeNull(); // "bol" inside another word is not a match
  });
});
