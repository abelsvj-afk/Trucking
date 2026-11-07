import { describe, expect, it } from "vitest";
import { bottomScrollTop, isAtBottom, shouldStickAfterTurnsChange } from "@/lib/chat-scroll";

describe("isAtBottom", () => {
  it("is true when the view is pinned to the newest message", () => {
    expect(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("is true within the threshold (sub-pixel / partial line slack)", () => {
    expect(isAtBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it("is false once he has scrolled up to read history", () => {
    expect(isAtBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it("is true when the conversation is shorter than the window", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true);
  });
});

describe("bottomScrollTop", () => {
  it("pins the end of the content into view", () => {
    expect(bottomScrollTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(900);
  });

  it("never goes negative for a short conversation", () => {
    expect(bottomScrollTop({ scrollTop: 0, scrollHeight: 50, clientHeight: 100 })).toBe(0);
  });
});

describe("shouldStickAfterTurnsChange", () => {
  it("sticks on open / while he is at the bottom", () => {
    expect(shouldStickAfterTurnsChange(true, false)).toBe(true);
  });

  it("does not yank him down when he scrolled up to read and a reply lands", () => {
    expect(shouldStickAfterTurnsChange(false, false)).toBe(false);
  });

  it("always sticks for his own send, wherever he was reading", () => {
    expect(shouldStickAfterTurnsChange(false, true)).toBe(true);
  });
});
