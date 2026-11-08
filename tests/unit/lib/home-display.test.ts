// Home "This month" business summary visibility (owner order
// 2026-11-07): hidden by default, shown only on the explicit stored
// "on" pick - the block is the future company view and reads as
// meaningless zeros while income is driver pay.
import { describe, expect, it } from "vitest";
import {
  HOME_BUSINESS_SUMMARY_DEFAULT,
  resolveShowBusinessSummary,
} from "@/lib/home-display";

describe("resolveShowBusinessSummary", () => {
  it("defaults to hidden when nothing is stored", () => {
    expect(HOME_BUSINESS_SUMMARY_DEFAULT).toBe(false);
    expect(resolveShowBusinessSummary(null)).toBe(false);
    expect(resolveShowBusinessSummary(undefined)).toBe(false);
  });

  it("shows only on the explicit stored 'on'", () => {
    expect(resolveShowBusinessSummary("on")).toBe(true);
  });

  it("hides on the explicit stored 'off' and on garbage", () => {
    expect(resolveShowBusinessSummary("off")).toBe(false);
    expect(resolveShowBusinessSummary("true")).toBe(false);
    expect(resolveShowBusinessSummary("")).toBe(false);
  });
});
