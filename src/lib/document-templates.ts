// Document templates for CREATED documents (owner spec 2026-11-09;
// docs/design/expense-buckets-documents.md section 3). Pure: a
// template turns recorded data into a document model (title +
// sections + lines) that a generator renders. Content comes only
// from the record - a figure that isn't recorded is written as
// "not stated", never invented.

import { formatCents } from "./pay-projection";
import { BUCKET_LABELS, type ExpenseBucket } from "./expense-buckets";

export type DocumentSituation = "carrier" | "own_authority" | "business_records";

export const SITUATION_LABELS: Record<DocumentSituation, string> = {
  carrier: "Working for a carrier",
  own_authority: "Own authority",
  business_records: "Business records",
};

export type CreatableDocumentKind = "expense_record" | "deduction_notice" | "invoice" | "statement";

export const CREATABLE_KIND_LABELS: Record<CreatableDocumentKind, string> = {
  expense_record: "Expense record",
  deduction_notice: "Pay deduction notice",
  invoice: "Invoice",
  statement: "Statement",
};

/** The documents.doc_type each creatable kind files under. */
export const CREATABLE_KIND_DOC_TYPE: Record<CreatableDocumentKind, string> = {
  expense_record: "receipt",
  deduction_notice: "statement",
  invoice: "invoice",
  statement: "statement",
};

export interface DocumentSection {
  heading: string | null;
  lines: string[];
}

export interface DocumentModel {
  title: string;
  sections: DocumentSection[];
}

/** The whole document as plain text lines - what the proposal summary shows him before it files. */
export function documentModelToText(model: DocumentModel): string[] {
  const out = [model.title];
  for (const section of model.sections) {
    if (section.heading) out.push(section.heading);
    out.push(...section.lines);
  }
  return out;
}

export interface ExpenseForDocument {
  category: string;
  amount_cents: number;
  expense_date: string;
  description: string | null;
  bucket?: string | null;
}

/** Receipt-style proof page for one expense, from the expense record alone. */
export function expenseRecordDocument(input: {
  expense: ExpenseForDocument;
  situation: DocumentSituation;
  createdDateWords: string;
}): DocumentModel {
  const { expense, situation, createdDateWords } = input;
  const bucket: ExpenseBucket = expense.bucket === "pay_deduction" ? "pay_deduction" : "business";
  return {
    title: "Expense Record",
    sections: [
      {
        heading: null,
        lines: [
          `Amount: ${formatCents(expense.amount_cents)}`,
          `Date: ${expense.expense_date}`,
          `Category: ${expense.category}`,
          `Description: ${expense.description?.trim() ? expense.description : "not stated"}`,
          `Bucket: ${BUCKET_LABELS[bucket]}`,
          `Situation: ${SITUATION_LABELS[situation]}`,
          `Record created: ${createdDateWords}`,
        ],
      },
      {
        heading: "What this document is",
        lines: [
          "This page was created in the app from the expense record above, as the",
          "bookkeeping proof for that expense. It records what the books say; it",
          "is not a receipt issued by a seller.",
        ],
      },
    ],
  };
}

/** The pay deduction, its reason, and its paycheck effect in words. */
export function deductionNoticeDocument(input: {
  expense: ExpenseForDocument;
  situation: DocumentSituation;
  createdDateWords: string;
}): DocumentModel {
  const { expense, situation, createdDateWords } = input;
  const reason = expense.description?.trim() ? expense.description : "not stated";
  return {
    title: "Pay Deduction Notice",
    sections: [
      {
        heading: null,
        lines: [
          `Amount deducted: ${formatCents(expense.amount_cents)}`,
          `Date of the cost: ${expense.expense_date}`,
          `Reason: ${reason}`,
          `Situation: ${SITUATION_LABELS[situation]}`,
          `Record created: ${createdDateWords}`,
        ],
      },
      {
        heading: "How it lands",
        lines: [
          "This amount comes out of the driver's pay for the pay week that",
          "contains the date above. It appears on the Paychecks page as its",
          "own line - pay deduction, with this reason - next to any cash",
          "advances, and the check's expected net is reduced by it.",
        ],
      },
    ],
  };
}

export interface StructuredLine {
  label: string;
  amount_cents: number | null;
}

export interface StructuredDocumentInput {
  kind: "invoice" | "statement";
  title: string;
  party_from: string;
  party_to: string;
  date_words: string;
  lines: StructuredLine[];
  total_cents: number | null;
  notes: string | null;
  situation: DocumentSituation;
}

/** Invoice / statement from structured fields the owner (or Abel, from records) supplied. */
export function structuredDocument(input: StructuredDocumentInput): DocumentModel {
  const lines = input.lines.map(
    (l) => `${l.label}: ${l.amount_cents === null ? "not stated" : formatCents(l.amount_cents)}`,
  );
  return {
    title: input.title,
    sections: [
      {
        heading: null,
        lines: [
          `From: ${input.party_from}`,
          `To: ${input.party_to}`,
          `Date: ${input.date_words}`,
          `Situation: ${SITUATION_LABELS[input.situation]}`,
        ],
      },
      { heading: input.kind === "invoice" ? "Charges" : "Lines", lines },
      {
        heading: null,
        lines: [`Total: ${input.total_cents === null ? "not stated" : formatCents(input.total_cents)}`],
      },
      ...(input.notes ? [{ heading: "Notes", lines: [input.notes] }] : []),
    ],
  };
}
