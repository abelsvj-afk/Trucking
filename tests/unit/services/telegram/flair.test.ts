// Stickers and reactions: Abel asks with markers, code decides (owner 2026-11-07).

import { describe, expect, it } from "vitest";
import { describeIncomingMedia, extractFlair, isSeriousMessage, FLAIR_RULES } from "@/services/telegram/flair";

describe("extractFlair", () => {
  it("pulls out one sticker and one reaction and removes the markers from the text", () => {
    const f = extractFlair("🚚 Delivered! Nice work.\n{{sticker:🎉}}\n{{react:🔥}}");
    expect(f).toEqual({ text: "🚚 Delivered! Nice work.", sticker: "🎉", reaction: "🔥", gif: null });
  });
  it("keeps only the first sticker and the first reaction", () => {
    const f = extractFlair("Great {{sticker:😂}} {{sticker:🎉}} {{react:👍}} {{react:🔥}}");
    expect(f.sticker).toBe("😂");
    expect(f.reaction).toBe("👍");
    expect(f.text).not.toMatch(/\{\{/);
  });
  it("strips markers it will not act on: unknown reactions, non-emoji stickers, malformed ones", () => {
    const f = extractFlair("Hi {{react:💩}} {{sticker:hello}} {{sticker:}} {{react:👍");
    expect(f.sticker).toBeNull();
    expect(f.reaction).toBeNull();
    expect(f.text).toBe("Hi"); // an unclosed marker is removed too, never shown
  });
  it("accepts an emoji written with a variation selector (the heart)", () => {
    expect(extractFlair("Thanks {{react:❤️}}").reaction).toBe("❤");
  });
  it("sends NOTHING extra on a serious message - but still removes the markers", () => {
    for (const bad of ["⚠️ You are over the limit {{sticker:😂}}", "I have NOT recorded this yet.\n👉 Reply YES to confirm {{react:👍}}", "❌ FAILED to save {{sticker:🎉}}", "I couldn't find that load {{react:👍}}"]) {
      const f = extractFlair(bad);
      expect(f.sticker).toBeNull();
      expect(f.reaction).toBeNull();
      expect(f.text).not.toMatch(/\{\{/);
    }
  });
  it("a plain reply with no markers is untouched", () => {
    expect(extractFlair("You have 3h 10m left.")).toEqual({ text: "You have 3h 10m left.", sticker: null, reaction: null, gif: null });
  });
  it("isSeriousMessage", () => {
    expect(isSeriousMessage("🎉 Load delivered, paycheck landed")).toBe(false);
    expect(isSeriousMessage("⚠️ heads up")).toBe(true);
  });
});

describe("incoming media becomes text Abel can read - never a command", () => {
  it("a sticker carries its emoji; a GIF keeps its caption", () => {
    expect(describeIncomingMedia({ sticker: { emoji: "😂" } })).toBe("[sticker 😂]");
    expect(describeIncomingMedia({ sticker: {} })).toBe("[sticker]");
    expect(describeIncomingMedia({ animation: { file_id: "x" }, caption: "my truck" })).toBe("[GIF] my truck");
    expect(describeIncomingMedia({ animation: {} })).toBe("[GIF]");
    expect(describeIncomingMedia({})).toBeNull();
  });
  it("the prompt tells Abel the rules, including never on errors or approvals", () => {
    expect(FLAIR_RULES).toMatch(/NEVER on errors, warnings/);
    expect(FLAIR_RULES).toMatch(/never commands/);
  });
});

describe("a reply with no markers is returned exactly as written (indentation kept)", () => {
  it("keeps indentation and double spaces when nothing was removed", () => {
    const text = "Plan:\n  ▫️ one  two\n  ▫️ three";
    expect(extractFlair(text).text).toBe(text);
  });
});

describe("GIF memes: {{gif:search words}}", () => {
  it("extracts one plain-words search and removes the marker", () => {
    const f = extractFlair("🎉 Delivered!\n{{gif:celebration dance}}");
    expect(f).toEqual({ text: "🎉 Delivered!", sticker: null, reaction: null, gif: "celebration dance" });
  });
  it("keeps only the first GIF, tidies spacing, and can ride with a sticker and a reaction", () => {
    const f = extractFlair("Nice {{gif:  big   win }} {{gif:second one}} {{sticker:🎉}} {{react:🔥}}");
    expect(f.gif).toBe("big win");
    expect(f.sticker).toBe("🎉");
    expect(f.reaction).toBe("🔥");
    expect(f.text).toBe("Nice");
  });
  it("rejects anything that is not a few plain words, but still strips the marker", () => {
    for (const bad of ["{{gif:}}", "{{gif:x}}", "{{gif:http://evil.example/x.gif}}", "{{gif:a;drop table}}", `{{gif:${"word ".repeat(20)}}}`]) {
      const f = extractFlair(`Hi ${bad}`);
      expect(f.gif).toBeNull();
      expect(f.text).toBe("Hi");
    }
  });
  it("never on a serious message", () => {
    const f = extractFlair("⚠️ You're over the limit {{gif:facepalm}}");
    expect(f.gif).toBeNull();
    expect(f.text).not.toContain("{{");
  });
});
