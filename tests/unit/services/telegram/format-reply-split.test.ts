// T-006: Telegram rejects a message over 4096 chars, and the old route splitter sent a single
// over-long line whole. splitTelegramMessage must keep every chunk within the limit, prefer
// line breaks, hard-split long lines at a back-half space (consuming it) or at the limit, and
// never tear a UTF-16 surrogate pair.

import { describe, expect, it } from "vitest";
import { splitTelegramMessage } from "@/services/telegram/format-reply";

describe("splitTelegramMessage", () => {
  it("returns short text and packed lines untouched", () => {
    expect(splitTelegramMessage("hello")).toEqual(["hello"]);
    expect(splitTelegramMessage("one\ntwo\nthree")).toEqual(["one\ntwo\nthree"]);
    expect(splitTelegramMessage("")).toEqual([]);
  });

  it("packs whole lines up to the limit, then starts a new chunk", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    expect(splitTelegramMessage(`${a}\n${b}`)).toEqual([a, b]);
    // A line that fits exactly stays whole.
    expect(splitTelegramMessage("x".repeat(4000))).toEqual(["x".repeat(4000)]);
  });

  it("hard-splits a 9000-char single line with no spaces at the limit", () => {
    const line = "a".repeat(9000);
    const chunks = splitTelegramMessage(line);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    // No spaces to consume: concatenation reproduces the line exactly.
    expect(chunks.join("")).toBe(line);
  });

  it("splits at the last space in the back half and consumes that one space", () => {
    const line = `${"x".repeat(3990)} ${"y".repeat(5000)}`;
    const chunks = splitTelegramMessage(line);
    expect(chunks.map((c) => c.length)).toEqual([3990, 4000, 1000]);
    expect(chunks[0]).toBe("x".repeat(3990));
    // Exactly one character is lost versus the original: the split space.
    expect(chunks.join("")).toBe(line.replace(" ", ""));
  });

  it("ignores a space in the front half and cuts at the limit instead", () => {
    const line = `${"x".repeat(100)} ${"y".repeat(5000)}`;
    const chunks = splitTelegramMessage(line);
    expect(chunks.map((c) => c.length)).toEqual([4000, 1101]);
    // The early space survives inside the first chunk; nothing is lost.
    expect(chunks.join("")).toBe(line);
  });

  it("never tears a surrogate pair: an emoji at the boundary stays whole", () => {
    // "a" + 2000 emoji = 4001 UTF-16 units; a cut at 4000 would land between
    // the high and low surrogate of the last emoji, so it backs off to 3999.
    const line = `a${"😀".repeat(2000)}`;
    const chunks = splitTelegramMessage(line);
    expect(chunks.map((c) => c.length)).toEqual([3999, 2]);
    expect(chunks.join("")).toBe(line);
    for (const c of chunks) {
      expect(c).not.toMatch(/[\uD800-\uDBFF]$/); // no chunk ends on a lone high surrogate
      expect(c).not.toMatch(/^[\uDC00-\uDFFF]/); // no chunk starts on a lone low surrogate
    }
  });

  it("a run of repeated emoji splits on pair boundaries", () => {
    const line = "😀".repeat(4500); // 9000 UTF-16 units
    const chunks = splitTelegramMessage(line);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000]);
    expect(chunks.join("")).toBe(line);
  });

  it("honours a custom limit, including the space rule", () => {
    // Spaces at index 3 and 7; the one at 7 is in the back half of a 7-char window.
    expect(splitTelegramMessage("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(splitTelegramMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("a long line after a short line flushes the short line first", () => {
    const chunks = splitTelegramMessage(`short\n${"z".repeat(5000)}`);
    expect(chunks[0]).toBe("short");
    expect(chunks.map((c) => c.length)).toEqual([5, 4000, 1000]);
  });
});
