// Pay-period phrases from HIS saved terms - the owner's deal: week Sunday-Saturday, statement Thursday, paid Friday.

import { describe, expect, it } from "vitest";
import { resolvePayPhrase } from "@/services/bot/pay-phrases";

const DEAL = { pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 };
const WED = "2026-11-11"; // inside the week Sun Nov 8 - Sat Nov 14
const date = (phrase: string, today = WED, terms: Parameters<typeof resolvePayPhrase>[2] = DEAL) => {
  const r = resolvePayPhrase(phrase, today, terms);
  if (!r || !r.ok) throw new Error(JSON.stringify(r));
  return r.date;
};

describe("payday and statement day", () => {
  it("this week's money lands the Friday after the Saturday that ends it; the statement the Thursday before", () => {
    // Wed Nov 11: last week (Nov 1-7) pays Fri Nov 13 and its statement is Thu Nov 12 - both still ahead
    expect(date("payday")).toBe("2026-11-13");
    expect(date("statement day")).toBe("2026-11-12");
    // the week in progress (Nov 8-14) pays Fri Nov 20 - that is the one AFTER the upcoming payday
    expect(date("next payday", "2026-11-13")).toBe("2026-11-20");
  });
  it("'last payday' is the most recent one already past", () => {
    expect(date("last payday")).toBe("2026-11-06");
    expect(date("last statement day")).toBe("2026-11-05");
  });
  it("on payday itself, 'payday' is today and 'next payday' is the following week's", () => {
    expect(date("payday", "2026-11-13")).toBe("2026-11-13");
    expect(date("next payday", "2026-11-13")).toBe("2026-11-20");
  });
});

describe("pay week", () => {
  it("end and start of this, last and next pay week (Sunday-Saturday)", () => {
    expect(date("end of the pay week")).toBe("2026-11-14");
    expect(date("start of the pay week")).toBe("2026-11-08");
    expect(date("end of last pay week")).toBe("2026-11-07");
    expect(date("end of next pay week")).toBe("2026-11-21");
  });
});

describe("honesty", () => {
  it("not a pay phrase -> null so the ordinary resolver handles it", () => {
    expect(resolvePayPhrase("next friday", WED, DEAL)).toBeNull();
    expect(resolvePayPhrase("the 6th", WED, DEAL)).toBeNull();
  });
  it("no saved terms, or an unset day, is said plainly - never guessed", () => {
    const none = resolvePayPhrase("payday", WED, null)!;
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toMatch(/no pay terms saved/);
    const noPayday = resolvePayPhrase("payday", WED, { pay_week_ends_on: 6 })!;
    expect(!noPayday.ok && noPayday.error).toMatch(/payday isn't set/);
    const noWeek = resolvePayPhrase("end of the pay week", WED, { payday_weekday: 5 })!;
    expect(noWeek.ok && noWeek.note).toMatch(/Monday-Sunday weeks were used/);
  });
});
