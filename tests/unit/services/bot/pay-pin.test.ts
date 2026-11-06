// Phase D acceptance (design §5): the pay pin - explicit UNKNOWN
// state, roundtrip through the business_fact line format, and the
// context block that must never let Abel state an un-pinned model
// as fact.

import { describe, expect, it } from "vitest";
import {
  findPayPin,
  formatPayPin,
  formatPayPinLine,
  isPinned,
  parsePayPin,
  UNKNOWN_PIN,
  type PayPin,
} from "@/services/bot/pay-pin";

const FULL_PIN: PayPin = {
  model: "percentage_gross",
  rate: 30,
  employment: "1099",
  fuelPaidBy: "owner",
  tollsPaidBy: "driver",
  settlementDay: "Friday",
  taxSetasidePercent: 25,
  source: "Settlement dated 2026-10-24 (Steven's carrier, weekly statement)",
  pinnedAt: "2026-11-02",
};

describe("pay pin format/parse", () => {
  it("roundtrips a full pin, free-text source (spaces, parens) intact", () => {
    const line = formatPayPin(FULL_PIN);
    expect(line.startsWith("BUSINESS — Pay structure | ")).toBe(true);
    expect(parsePayPin(line)).toEqual(FULL_PIN);
  });

  it("roundtrips a partial pin (model + rate only, rest UNKNOWN)", () => {
    const partial: PayPin = { ...UNKNOWN_PIN, model: "cpm_all_miles", rate: 0.62, source: "his words", pinnedAt: "2026-11-02" };
    expect(parsePayPin(formatPayPin(partial))).toEqual(partial);
  });

  it("non-pin content is not a pin; a broken pin line degrades fields to UNKNOWN, never to a guess", () => {
    expect(parsePayPin("BUSINESS — How this carrier pays | Weekly.")).toBeNull();
    expect(parsePayPin("not a memory at all")).toBeNull();
    const broken = parsePayPin("BUSINESS — Pay structure | PIN model=wizardry rate=abc employment=?");
    expect(broken?.model).toBe("UNKNOWN");
    expect(broken?.rate).toBeNull();
    expect(broken?.employment).toBe("UNKNOWN");
  });

  it("findPayPin defaults to the explicit UNKNOWN pin when no pin row exists", () => {
    expect(findPayPin([])).toEqual(UNKNOWN_PIN);
    expect(findPayPin([{ content: "BUSINESS — How this carrier pays | Weekly." }])).toEqual(UNKNOWN_PIN);
    expect(findPayPin([{ content: formatPayPin(FULL_PIN) }])).toEqual(FULL_PIN);
  });

  it("isPinned distinguishes a real pin from the UNKNOWN state", () => {
    expect(isPinned(UNKNOWN_PIN)).toBe(false);
    expect(isPinned(FULL_PIN)).toBe(true);
    expect(isPinned({ ...UNKNOWN_PIN, rate: 30 })).toBe(false);
  });
});

describe("formatPayPinLine (the context block)", () => {
  it("unpinned: says NOT PINNED and forbids stating a figure as his", () => {
    const line = formatPayPinLine(UNKNOWN_PIN);
    expect(line).toContain("NOT PINNED");
    expect(line).toContain("never state a single pay figure as his");
    expect(line).toContain("candidate models side by side");
  });

  it("pinned: carries the model, rate, employment, and the source", () => {
    const line = formatPayPinLine(FULL_PIN);
    expect(line).toContain("PAY PIN");
    expect(line).toContain("percentage_gross");
    expect(line).toContain("30%");
    expect(line).toContain("1099");
    expect(line).toContain("source: Settlement dated 2026-10-24");
  });
});

import { payPinFromProfile } from "@/services/bot/pay-pin";

describe("payPinFromProfile (owner pay terms, migration 00063)", () => {
  const row = { employer_name: "Acme Freight", rate_cents_per_mile: 55, mile_basis: null, worker_type: null, fuel_paid_by: null, effective_from: "2026-10-01" } as const;
  it("an unset miles basis is NOT a pin - nothing is inferred from 55 cents", () => {
    expect(payPinFromProfile(row).model).toBe("UNKNOWN");
    expect(payPinFromProfile(null).model).toBe("UNKNOWN");
    expect(payPinFromProfile({ ...row, mile_basis: "practical" }).model).toBe("UNKNOWN");
  });
  it("loaded / all miles become a cents-per-mile pin; unset worker type and fuel stay unknown", () => {
    const loaded = payPinFromProfile({ ...row, mile_basis: "loaded" });
    expect(loaded).toMatchObject({ model: "cpm_loaded", rate: 0.55, employment: "UNKNOWN", fuelPaidBy: "unknown" });
    expect(payPinFromProfile({ ...row, mile_basis: "all", worker_type: "1099", fuel_paid_by: "employer" })).toMatchObject({
      model: "cpm_all_miles", employment: "1099", fuelPaidBy: "owner",
    });
  });
  it("a percent of the load is a percentage pin (alone) or a mixed structure (with a per-mile rate)", () => {
    expect(payPinFromProfile({ ...row, rate_cents_per_mile: 0, percent_of_load_bps: 8500 })).toMatchObject({ model: "percentage_gross", rate: 85 });
    expect(payPinFromProfile({ ...row, percent_of_load_bps: 1000 })).toMatchObject({ model: "mixed", rate: null });
  });
});
