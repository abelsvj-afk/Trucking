// Owner 2026-11-07: no raw stars in Telegram; emoji-labelled, easy-to-read layout.

import { describe, expect, it } from "vitest";
import { formatReply, STYLE_RULES } from "@/services/telegram/format-reply";

describe("formatReply", () => {
  it("removes markdown stars, underscores and backticks but keeps every word", () => {
    const out = formatReply("**Load** to *Atlanta* is __ready__ - use `update_load`.");
    expect(out).toBe("Load to Atlanta is ready - use update_load.");
    expect(out).not.toMatch(/[*`]/);
    expect(out).toContain("update_load"); // a real name keeps its underscore
  });
  it("turns star and dash bullets into topic emojis (neutral marker when no topic)", () => {
    const out = formatReply("Here is the plan:\n* Pay: $1,700.00\n- Fuel on the company card\n• something else");
    expect(out).toBe("Here is the plan:\n💵 Pay: $1,700.00\n⛽ Fuel on the company card\n▫️ something else");
  });
  it("turns markdown headings into an emoji header", () => {
    expect(formatReply("## Pay this week")).toBe("💵 Pay this week");
    expect(formatReply("# Summary")).toBe("📌 Summary");
  });
  it("adds a topic emoji to bare 'Label: value' lines, leaves other colons alone", () => {
    const out = formatReply("Load: Macon, GA → Tampa, FL\nPay: $1,700.00\nMiles: 480\nReply YES to confirm: or NO\nNow: delivery date → 2026-11-06");
    expect(out.split("\n")).toEqual([
      "🚚 Load: Macon, GA → Tampa, FL",
      "💵 Pay: $1,700.00",
      "🛣️ Miles: 480",
      "Reply YES to confirm: or NO",
      "📌 Now: delivery date → 2026-11-06",
    ]);
  });
  it("never touches numbers, money, multiplication, ids or urls", () => {
    const text = "5 * 55 cents = $2.75 and 2*3 and tdv_abc_def_ghi and https://trucking.fly.dev/api_v1/x_y";
    expect(formatReply(text)).toBe(text);
  });
  it("keeps numbered lists and emoji-led lines as they are", () => {
    const text = "1. Expense: $88.00\n2. Load update\n✅ Done - saved";
    expect(formatReply(text)).toBe(text);
  });
  it("is idempotent", () => {
    const messy = "## Pay\n**Pay**: $1,700\n* Fuel: not mine\n\n\n\n- note to self";
    const once = formatReply(messy);
    expect(formatReply(once)).toBe(once);
  });
  it("collapses runs of blank lines and trims", () => {
    expect(formatReply("a\n\n\n\n\nb\n")).toBe("a\n\nb");
  });
  it("the prompt rules forbid stars and name the two kinds of saving", () => {
    expect(STYLE_RULES).toMatch(/NEVER use asterisks/);
    expect(STYLE_RULES).toMatch(/💾/);
    expect(STYLE_RULES).toMatch(/🧠/);
  });
});
