// GAP-05 (Fresh-Eyes Register 2026-11-02) — load closeout.
//
// A load can be marked "completed" today with its paperwork
// incomplete, and nobody chases it — but the load isn't payable
// until the paperwork is in. This module computes the checklist
// from what the load REQUIRES vs what is actually attached:
//
// - rate_confirmation: always required (it is the contract).
// - bol: always required — the signed BOL is the POD; without it
//   the load can't be billed.
// - scale_ticket: required when the load carries a weight
//   (weight_lbs set, e.g. from GAP-01's scale-ticket proposal) —
//   a weight-rated load is argued from its ticket.
// - lumper_receipt: required when a lumper expense is booked
//   against the load (the receipt is the reimbursement proof).
//   The expense taxonomy has no lumper category (that's the
//   Reliability program's), so a lumper expense is an 'other'
//   expense whose description names it. The documents model has
//   no lumper_receipt doc_type either, so the receipt is any
//   attached document beyond the typed ones.
//
// Pure functions: the load page, the closeout warning, Abel's read
// tools, and the day-wrap (GAP-08) all quote this one computation.

import type { Document, Expense, Load } from "@/types/entities";

export type PaperworkDocKind = "rate_confirmation" | "bol" | "scale_ticket" | "lumper_receipt";

export interface PaperworkItem {
  kind: PaperworkDocKind;
  label: string;
  required: boolean;
  present: boolean;
  /** Document id satisfying the requirement, when present. */
  documentId: string | null;
  /** Why it matters, in the driver's terms — shown when missing. */
  why: string;
}

export interface PaperworkState {
  items: PaperworkItem[];
  missing: PaperworkItem[];
  complete: boolean;
  /** One plain sentence for warnings and Abel's answers. */
  summaryLine: string;
}

interface AttachedDoc {
  id: string;
  doc_type: string | null;
}

export function computePaperwork(
  load: Load,
  documents: Pick<AttachedDoc, "id" | "doc_type">[],
  expenses: Pick<Expense, "category" | "description">[],
): PaperworkState {
  const byType = (type: string) => documents.find((d) => d.doc_type === type) ?? null;
  const rateCon = byType("rate_confirmation");
  const bol = byType("bol");
  const scale = byType("scale_ticket");
  const hasLumperExpense = expenses.some((e) => /lumper/i.test(e.description ?? ""));
  // A lumper receipt has no doc_type of its own; any attached
  // document that isn't one of the typed requirements counts.
  const typedIds = new Set([rateCon?.id, bol?.id, scale?.id].filter(Boolean));
  const lumperReceipt = hasLumperExpense
    ? (documents.find((d) => !typedIds.has(d.id)) ?? null)
    : null;

  const allItems: PaperworkItem[] = [
    {
      kind: "rate_confirmation",
      label: "Rate confirmation",
      required: true,
      present: rateCon != null,
      documentId: rateCon?.id ?? null,
      why: "It's the contract for the load — rate, terms, and detention all argue from it.",
    },
    {
      kind: "bol",
      label: "BOL / proof of delivery",
      required: true,
      present: bol != null,
      documentId: bol?.id ?? null,
      why: "No POD on this load yet — it can't be billed without it.",
    },
    {
      kind: "scale_ticket",
      label: "Scale ticket",
      required: load.weight_lbs != null,
      present: scale != null,
      documentId: scale?.id ?? null,
      why: "This load carries a weight — the ticket is what proves it.",
    },
    {
      kind: "lumper_receipt",
      label: "Lumper receipt",
      required: hasLumperExpense,
      present: lumperReceipt != null,
      documentId: lumperReceipt?.id ?? null,
      why: "A lumper expense is booked on this load — the receipt is the reimbursement proof.",
    },
  ];
  const items = allItems.filter((item) => item.required);

  const missing = items.filter((item) => !item.present);
  return {
    items,
    missing,
    complete: missing.length === 0,
    summaryLine:
      missing.length === 0
        ? "Paperwork complete — everything this load needs is attached."
        : `Missing: ${missing.map((m) => m.label.toLowerCase()).join(", ")}. ${missing[0]!.why}`,
  };
}

/** Document rows as the paperwork computation needs them. */
export type PaperworkDocument = Pick<Document, "id" | "doc_type">;
