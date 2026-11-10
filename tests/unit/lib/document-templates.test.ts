import { describe, expect, it } from "vitest";
import {
  CREATABLE_KIND_DOC_TYPE,
  deductionNoticeDocument,
  documentModelToText,
  expenseRecordDocument,
  structuredDocument,
} from "@/lib/document-templates";
import { getGenerator, GENERATORS } from "@/services/documents/generate-document";

const mud = {
  category: "other",
  amount_cents: 25000,
  expense_date: "2026-11-08",
  description: "Mud recovery — truck stuck in the mud; the company paid and it comes out of the check",
  bucket: "pay_deduction",
};

describe("document templates", () => {
  it("the expense record carries the record's figures and its bucket in words", () => {
    const text = documentModelToText(
      expenseRecordDocument({ expense: mud, situation: "carrier", createdDateWords: "Sunday, November 8, 2026" }),
    ).join("\n");
    expect(text).toContain("Amount: $250.00");
    expect(text).toContain("Date: 2026-11-08");
    expect(text).toContain("Pay deduction");
    expect(text).toContain("Working for a carrier");
    expect(text).toContain("not a receipt issued by a seller");
  });

  it("an unrecorded description reads 'not stated', never invented", () => {
    const text = documentModelToText(
      expenseRecordDocument({
        expense: { ...mud, description: null },
        situation: "business_records",
        createdDateWords: "Sunday, November 8, 2026",
      }),
    ).join("\n");
    expect(text).toContain("Description: not stated");
  });

  it("the deduction notice says the amount, the reason, and how it lands on the check", () => {
    const text = documentModelToText(
      deductionNoticeDocument({ expense: mud, situation: "carrier", createdDateWords: "Sunday, November 8, 2026" }),
    ).join("\n");
    expect(text).toContain("Amount deducted: $250.00");
    expect(text).toContain("Mud recovery");
    expect(text).toContain("Paychecks page");
  });

  it("structured documents render lines and an unstated total honestly", () => {
    const text = documentModelToText(
      structuredDocument({
        kind: "invoice",
        title: "Invoice 12",
        party_from: "Road to Legacy",
        party_to: "A broker",
        date_words: "Sunday, November 8, 2026",
        lines: [{ label: "Detention", amount_cents: 7500 }, { label: "Layover", amount_cents: null }],
        total_cents: null,
        notes: null,
        situation: "own_authority",
      }),
    ).join("\n");
    expect(text).toContain("Detention: $75.00");
    expect(text).toContain("Layover: not stated");
    expect(text).toContain("Total: not stated");
    expect(CREATABLE_KIND_DOC_TYPE.invoice).toBe("invoice");
    expect(CREATABLE_KIND_DOC_TYPE.expense_record).toBe("receipt");
  });
});

describe("the generator seam", () => {
  it("the in-app PDF generator renders a real PDF", () => {
    const generator = getGenerator(undefined);
    expect(generator?.id).toBe("app_pdf");
    const file = generator!.render({ title: "Invoice 12", sections: [{ heading: null, lines: ["Total: $75.00"] }] });
    expect(file.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(file.bytes).startsWith("%PDF-1.4")).toBe(true);
  });

  it("an unregistered generator is refused, never faked", () => {
    expect(getGenerator("google_docs")).toBeNull();
    expect(Object.keys(GENERATORS)).toEqual(["app_pdf"]);
  });
});
