// Auditor recomputation: miles x rate must equal the pay quoted,
// $ per loaded mile and $ per ALL miles must match the miles given,
// windows must make sense. A number that does not add up is flagged
// with both numbers shown; a missing source is "cannot verify", never
// presented as a fact.
import { describe, expect, it } from "vitest";
import { auditDraftVsSource, auditInvoiceDraft, auditLoadDraft, auditSummary, formatAuditReply } from "@/services/bots/auditor";

const WINDOWS = {
  pickupWindowStart: "2026-11-20T08:00:00-06:00",
  pickupWindowEnd: "2026-11-20T16:00:00-06:00",
  deliveryWindowStart: "2026-11-21T08:00:00-05:00",
  deliveryWindowEnd: "2026-11-21T16:00:00-05:00",
};

describe("auditor load-draft checks", () => {
  it("passes a clean draft and computes both per-mile figures", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      claimedPerLoadedMileCents: 300,
      claimedPerAllMilesCents: 250,
      ...WINDOWS,
    });
    expect(result.passed).toBe(true);
    expect(result.flags).toEqual([]);
    expect(result.computed.expectedPayCents).toBe(150000);
    expect(result.computed.perLoadedMileCents).toBe(300);
    expect(result.computed.perAllMilesCents).toBe(250);
    expect(auditSummary(result)).toBe("checks out");
  });

  it("flags pay that does not equal rate x loaded miles, with both numbers", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 140000,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    expect(result.passed).toBe(false);
    const pay = result.flags.find((f) => f.field === "pay");
    expect(pay?.severity).toBe("error");
    expect(pay?.claim).toContain("$1,400.00");
    expect(pay?.source).toContain("$1,500.00");
  });

  it("flags a claimed $ per all miles that does not match", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      claimedPerAllMilesCents: 300,
      ...WINDOWS,
    });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.field === "per-all-miles")).toBe(true);
  });

  it("flags a pickup window that ends before it starts", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupWindowStart: "2026-11-20T16:00:00-06:00",
      pickupWindowEnd: "2026-11-20T08:00:00-06:00",
      deliveryWindowStart: "2026-11-21T08:00:00-05:00",
      deliveryWindowEnd: "2026-11-21T16:00:00-05:00",
    });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.field === "pickup-window")).toBe(true);
  });

  it("flags a delivery scheduled before the pickup", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      pickupWindowStart: "2026-11-21T08:00:00-06:00",
      pickupWindowEnd: "2026-11-21T16:00:00-06:00",
      deliveryWindowStart: "2026-11-20T08:00:00-05:00",
      deliveryWindowEnd: "2026-11-20T16:00:00-05:00",
    });
    expect(result.flags.some((f) => f.field === "delivery-window")).toBe(true);
  });

  it("says 'cannot verify' — never a guess — when miles or pay are missing", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: null,
      payCents: 150000,
      loadedMiles: null,
      deadheadMiles: null,
      ...WINDOWS,
    });
    expect(result.flags.some((f) => f.severity === "unverifiable")).toBe(true);
    expect(result.flags.every((f) => f.severity !== "error")).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("tolerates rounding: a pay mismatch of $1.00 or less is not an error", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150050,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    expect(result.flags.filter((f) => f.field === "pay")).toEqual([]);
  });
});

describe("auditor invoice checks", () => {
  it("passes an invoice that equals the agreed pay and the rate con", () => {
    const result = auditInvoiceDraft({ invoicedCents: 150000, agreedPayCents: 150000, rateConTotalCents: 150000 });
    expect(result.passed).toBe(true);
    expect(result.flags).toEqual([]);
  });

  it("flags an invoice that does not match the agreed pay, with both numbers", () => {
    const result = auditInvoiceDraft({ invoicedCents: 140000, agreedPayCents: 150000, rateConTotalCents: 150000 });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.field === "invoice" && f.severity === "error")).toBe(true);
    expect(result.flags[0]?.claim).toContain("$1,400.00");
    expect(result.flags[0]?.source).toContain("$1,500.00");
  });

  it("flags an invoice that does not match the rate confirmation", () => {
    const result = auditInvoiceDraft({ invoicedCents: 150000, agreedPayCents: 150000, rateConTotalCents: 145000 });
    expect(result.passed).toBe(false);
    expect(result.flags.some((f) => f.source.includes("rate confirmation"))).toBe(true);
  });

  it("says 'cannot verify' — never a pass by default — when no agreed pay and no rate con exist", () => {
    const result = auditInvoiceDraft({ invoicedCents: 150000, agreedPayCents: null, rateConTotalCents: null });
    expect(result.passed).toBe(true);
    expect(result.flags.some((f) => f.severity === "unverifiable")).toBe(true);
  });
});

describe("auditor draft-vs-source checks", () => {
  it("passes fields that match their source exactly", () => {
    const flags = auditDraftVsSource([
      { field: "pickup-address", draft: "100 Main St, Dallas, TX", source: "100 Main St, Dallas, TX" },
      { field: "broker-rate", draft: "$3.00/mi", source: "$3.00/mi" },
    ]);
    expect(flags).toEqual([]);
  });

  it("flags a time that moved and an address that changed, with both values shown", () => {
    const flags = auditDraftVsSource([
      { field: "pickup-window", draft: "Nov 20 08:00-16:00", source: "Nov 21 08:00-16:00" },
      { field: "delivery-address", draft: "200 Oak Ave, Houston, TX", source: "400 Pine St, Houston, TX" },
    ]);
    expect(flags).toHaveLength(2);
    expect(flags[0]?.severity).toBe("error");
    expect(flags[0]?.claim).toContain("Nov 20");
    expect(flags[0]?.source).toContain("Nov 21");
    expect(flags[1]?.detail).toContain("400 Pine St");
  });

  it("says 'cannot verify' and names the missing piece when the source is gone", () => {
    const flags = auditDraftVsSource([{ field: "broker-rate", draft: "$3.00/mi", source: null }]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("unverifiable");
    expect(flags[0]?.detail).toContain("source is missing");
  });
});

describe("auditor reply format", () => {
  it("says 'checks out' when nothing is flagged", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    expect(formatAuditReply(result)).toBe("checks out");
  });

  it("leads with the check that passed and names what could not be verified", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 150000,
      loadedMiles: 500,
      deadheadMiles: 100,
    });
    expect(formatAuditReply(result)).toMatch(/^Checks out on the numbers given\. Cannot verify: windows/);
  });

  it("lists only the errors when the numbers disagree", () => {
    const result = auditLoadDraft({
      rateCentsPerLoadedMile: 300,
      payCents: 140000,
      loadedMiles: 500,
      deadheadMiles: 100,
      ...WINDOWS,
    });
    const reply = formatAuditReply(result);
    expect(reply).toContain("pay: Pay does not add up");
    expect(reply).not.toContain("Cannot verify");
  });
});
