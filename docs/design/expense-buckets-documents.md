# Expense buckets + document creation (owner spec 2026-11-09)

Governing spec: the owner's 2026-11-09 requirements, filed as
`Expense-Buckets-and-Documents-Spec-2026-11-09.md` in the trucking goal
files. This note is the repo-side design the code conforms to.

## 1. Two expense buckets

Every expense carries `bucket` (migration 00085):

- `business` — his own company's costs (own-authority books). Never
  touches driver pay. **Default for every existing row** and for new
  expenses that don't say otherwise: nothing already recorded changes
  buckets without his yes.
- `pay_deduction` — a cost the company he drives for takes out of his
  check (recovery/tow after an incident, damage, chargebacks). It
  reduces expected pay in the paycheck picture, as **its own visible
  line with the reason in words**, alongside cash advances — one
  coherent "what comes out of my check" view, one net number:
  `net = expected − advances − pay deductions`, applied to both ends
  of the expected range (while the miles basis is UNSET the net stays
  a range, never one confident number; a net can go negative and is
  shown as-is).

The bucket is chosen at entry everywhere an expense can be entered:
the app forms (with a plain-words warning when pay-deduction is
picked), and Abel's `create_expense` / `update_expense` (the proposal
shows the bucket in words; Abel asks or infers and confirms in the
proposal). **Reclassification is a proposal, never a silent edit** —
the $250 mud-recovery record is the first candidate: Abel's
`update_expense` with `bucket: "pay_deduction"` is the mechanism, and
it executes only on the owner's yes like every write. No live data is
changed by this build.

Grouping mirrors cash advances exactly (lib/expense-buckets.ts): a
deduction belongs to the pay week containing its `expense_date`,
grouped with the pay terms in force on that date, and deducts from
that week's payday. The paycheck builder (services/api/pay-summary.ts)
is the one place the netting happens for the Paychecks page, the Home
pay card and Abel's paycheck tool; the Projected Pay surface
(use-pay-projection + DriverPayHomeCard + Money → Pay) nets the same
deductions client-side so no screen tells a different story.

A deduction read that fails fails **visibly** (the advances
discipline): expected pay with deductions silently zeroed would
present as final while an input failed. The one exception is the
pre-00085 database, where the `bucket` column does not exist yet —
there the read degrades to "no deductions recorded" (true: none can
exist) and everything else works.

## 2. Documents: attached, previewable, typed

Documents already attach to truck/trailer/driver/load, preview in
place (DocumentPreview) and open full-size. This build closes the
remaining gaps against the spec:

- **Expenses become document targets.** `related_entity_type` gains
  `expense` (zod enum, TS type, Documents-page picker, and the 00071
  reference trigger extended in 00085 with the same identical-error
  discipline). The expense detail page gains a Documents section:
  thumbnails in place, tap to preview full screen, upload in place.
- **Typed by situation.** Two orthogonal fields, both set at upload
  or creation and shown in the preview:
  - `doc_type` (widened in 00085): the paperwork kind — existing
    bol / rate_confirmation / scale_ticket / fuel_receipt /
    settlement / other, plus **receipt, agreement, invoice,
    statement** for the books' needs.
  - `situation`: **carrier** (working for a company), **own_authority**
    (his own authority/truck), **business_records** (the company's
    own paperwork). Nullable: legacy rows simply don't claim one.
- **Provenance.** `source` = `upload` | `generated`, and `generator`
  names the backend that made a generated document (`app_pdf` today).
  A generated document is visibly "Created in the app" in its preview.

## 3. Abel creates documents (create_document)

The books sometimes need a document that doesn't exist as a photo —
the proof page for a pay deduction, a receipt record for an expense,
an invoice or statement. `create_document` (write tool, propose→yes)
generates a real document and files it attached to its record:

- **Kinds** (lib/document-templates.ts, pure): `expense_record`
  (receipt-style proof of one expense), `deduction_notice` (the pay
  deduction, its reason and its paycheck effect in words), `invoice`
  and `statement` (structured: title, parties, dated lines, total).
  The content is built **only from recorded data** — an amount or
  rate that isn't recorded is written as "not stated", never invented.
- **Generation seam** (services/documents/generate-document.ts):
  a `DocumentGenerator` registry. The default `app_pdf` generator
  renders the document model to a real PDF in-app
  (lib/simple-pdf.ts — a small dependency-free PDF writer). A free
  Google-Docs-type backend can be added later as a second generator
  behind the same interface, selected per document type; it is NOT
  wired to any live Google account in this build, and selecting an
  unconfigured generator fails honestly instead of faking a document.
- **Filing** rides the one storage pipeline (store-document.ts), so
  generated documents land in the same Documents area, attached to
  their record, previewable like uploads, with `source = 'generated'`.
  The proposal summary carries the document's full text in words —
  he sees the document before it files.
- The app can create too: `POST /api/v1/documents/generate` + a
  create form on the Documents page (same service, same filing).

## 4. Migration 00085 (authored, NOT applied by this build)

- `expenses.bucket` text NOT NULL DEFAULT 'business' + CHECK.
- `documents.doc_type` CHECK widened (receipt/agreement/invoice/statement).
- `documents.situation`, `documents.source` (DEFAULT 'upload'),
  `documents.generator` columns.
- `documents_validate_reference()` extended with the `expense` arm,
  byte-identical error discipline preserved.
- No new tables; RLS unchanged (tenant policies already cover both
  tables). Applied migrations 00001–00084 are untouched.

## 5. Go-live order

Owner merge tap → migration 00085 applied (probe-verified) → deploy
tap. All code degrades honestly pre-00085 (bucket reads fall back to
business-only; document metadata fields strip on insert like the
00033 caption pattern).
