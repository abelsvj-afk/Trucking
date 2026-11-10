// Abel's create_document tool (owner spec 2026-11-09; design
// docs/design/expense-buckets-documents.md section 3). A WRITE tool -
// propose -> yes like every write. It generates a real document from
// recorded data and files it attached to its record through the one
// storage pipeline.
//
// Grounding discipline: the proposal summary carries the document's
// FULL text, built from the args (which the model takes from the
// record it just read). At execution the tool re-reads the record and
// REFUSES if the money-critical fields in the args don't match it -
// so what he approved is what gets filed, and a drifted summary can
// never file a wrong document.

import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { validateWith } from "./tool-helpers";
import { createDocumentFile } from "@/services/documents/generate-document";
import {
  CREATABLE_KIND_DOC_TYPE,
  deductionNoticeDocument,
  documentModelToText,
  expenseRecordDocument,
  structuredDocument,
  type DocumentModel,
} from "@/lib/document-templates";

export function todayWordsEastern(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

const createDocumentArgs = z.object({
  kind: z.enum(["expense_record", "deduction_notice", "invoice", "statement"]),
  // Expense kinds: the expense this document is the proof page for.
  expense_id: z.string().uuid().optional(),
  // The expense facts as read from the record (verified at execution).
  expense_amount_dollars: z.number().positive().optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expense_category: z.string().min(1).optional(),
  expense_description: z.string().nullable().optional(),
  expense_bucket: z.enum(["business", "pay_deduction"]).optional(),
  // Invoice / statement kinds: the record the document files under,
  // and its structured content.
  related_entity_type: z.enum(["truck", "trailer", "driver", "load", "expense"]).optional(),
  related_entity_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  party_from: z.string().min(1).max(200).optional(),
  party_to: z.string().min(1).max(200).optional(),
  lines: z.array(z.object({ label: z.string().min(1).max(300), amount_cents: z.number().int().nullable() })).max(50).optional(),
  line_amounts_dollars: z
    .array(z.object({ label: z.string().min(1).max(300), amount_dollars: z.number().nullable() }))
    .max(50)
    .optional(),
  total_dollars: z.number().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  situation: z.enum(["carrier", "own_authority", "business_records"]),
});

type CreateDocumentArgs = z.infer<typeof createDocumentArgs>;

function modelFromArgs(parsed: CreateDocumentArgs): DocumentModel {
  if (parsed.kind === "expense_record" || parsed.kind === "deduction_notice") {
    const expense = {
      category: parsed.expense_category ?? "other",
      amount_cents: Math.round((parsed.expense_amount_dollars ?? 0) * 100),
      expense_date: parsed.expense_date ?? "",
      description: parsed.expense_description ?? null,
      bucket: parsed.expense_bucket ?? null,
    };
    return parsed.kind === "expense_record"
      ? expenseRecordDocument({ expense, situation: parsed.situation, createdDateWords: todayWordsEastern() })
      : deductionNoticeDocument({ expense, situation: parsed.situation, createdDateWords: todayWordsEastern() });
  }
  const lines = (parsed.lines ?? parsed.line_amounts_dollars?.map((l) => ({
    label: l.label,
    amount_cents: l.amount_dollars === null ? null : Math.round(l.amount_dollars * 100),
  })) ?? []) as { label: string; amount_cents: number | null }[];
  return structuredDocument({
    kind: parsed.kind,
    title: parsed.title ?? "Document",
    party_from: parsed.party_from ?? "not stated",
    party_to: parsed.party_to ?? "not stated",
    date_words: todayWordsEastern(),
    lines,
    total_cents: parsed.total_dollars === null || parsed.total_dollars === undefined ? null : Math.round(parsed.total_dollars * 100),
    notes: parsed.notes ?? null,
    situation: parsed.situation,
  });
}

export function buildDocumentTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;
  return [
    {
      name: "create_document",
      description:
        "Create a real document in the app and file it attached to its record (Documents area). Kinds: 'expense_record' (receipt-style proof page for one expense - pass the expense_id and the expense's amount/date/category/description/bucket exactly as read from the record), 'deduction_notice' (the pay-deduction proof page for a pay_deduction expense), 'invoice' and 'statement' (structured: title, party_from, party_to, line_amounts_dollars, total_dollars, optional notes, and the record it files under via related_entity_type/related_entity_id). Always pass 'situation': 'carrier' (working for a company), 'own_authority', or 'business_records'. The proposal shows him the document's full text before it files; content comes only from recorded data - never invent an amount.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["expense_record", "deduction_notice", "invoice", "statement"] },
          expense_id: { type: "string", description: "Expense id (uuid) for expense_record / deduction_notice." },
          expense_amount_dollars: { type: "number", description: "The expense amount exactly as recorded." },
          expense_date: { type: "string", description: "The expense date exactly as recorded, YYYY-MM-DD." },
          expense_category: { type: "string" },
          expense_description: { type: "string" },
          expense_bucket: { type: "string", enum: ["business", "pay_deduction"] },
          related_entity_type: { type: "string", enum: ["truck", "trailer", "driver", "load", "expense"] },
          related_entity_id: { type: "string" },
          title: { type: "string" },
          party_from: { type: "string" },
          party_to: { type: "string" },
          line_amounts_dollars: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, amount_dollars: { type: ["number", "null"] } },
              required: ["label", "amount_dollars"],
            },
          },
          total_dollars: { type: ["number", "null"] },
          notes: { type: "string" },
          situation: { type: "string", enum: ["carrier", "own_authority", "business_records"] },
        },
        required: ["kind", "situation"],
      },
      access: "write",
      validateArgs: validateWith(createDocumentArgs),
      summarize(args) {
        const parsed = createDocumentArgs.parse(args);
        return `Create this document:\n${documentModelToText(modelFromArgs(parsed)).join("\n")}`;
      },
      async run(args) {
        const parsed = createDocumentArgs.parse(args);
        let relatedEntityType: string;
        let relatedEntityId: string;
        let model: DocumentModel;

        if (parsed.kind === "expense_record" || parsed.kind === "deduction_notice") {
          if (!parsed.expense_id) throw new Error("create_document needs the expense_id for an expense document.");
          const { data, error } = await client
            .from("expenses")
            .select("category, amount_cents, expense_date, description, bucket")
            .eq("id", parsed.expense_id)
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .single();
          if (error || !data) throw new Error("That expense could not be found - it may have been deleted. Nothing was filed.");
          const exp = data as {
            category: string;
            amount_cents: number;
            expense_date: string;
            description: string | null;
            bucket?: string | null;
          };
          // Verify the approved text against the record: the amount
          // and date in the proposal must be the record's, or the
          // document he approved is not the document on file.
          if (
            parsed.expense_amount_dollars !== undefined &&
            Math.round(parsed.expense_amount_dollars * 100) !== exp.amount_cents
          ) {
            throw new Error(
              `The proposal's amount does not match the expense record - nothing was filed. Re-read the expense and propose again.`,
            );
          }
          if (parsed.expense_date !== undefined && parsed.expense_date !== exp.expense_date) {
            throw new Error("The proposal's date does not match the expense record - nothing was filed. Re-read the expense and propose again.");
          }
          if (parsed.kind === "deduction_notice" && exp.bucket !== "pay_deduction") {
            throw new Error("That expense is recorded as a business expense, not a pay deduction - a deduction notice only fits a pay-deduction expense. Nothing was filed.");
          }
          model =
            parsed.kind === "expense_record"
              ? expenseRecordDocument({ expense: exp, situation: parsed.situation, createdDateWords: todayWordsEastern() })
              : deductionNoticeDocument({ expense: exp, situation: parsed.situation, createdDateWords: todayWordsEastern() });
          relatedEntityType = "expense";
          relatedEntityId = parsed.expense_id;
        } else {
          if (!parsed.related_entity_type || !parsed.related_entity_id) {
            throw new Error("An invoice or statement needs the record it files under (related_entity_type and related_entity_id).");
          }
          model = modelFromArgs(parsed);
          relatedEntityType = parsed.related_entity_type;
          relatedEntityId = parsed.related_entity_id;
        }

        const row = await createDocumentFile(client, {
          companyId,
          relatedEntityType,
          relatedEntityId,
          docType: CREATABLE_KIND_DOC_TYPE[parsed.kind],
          situation: parsed.situation,
          model,
        });
        return `Created and filed "${row.file_name}" under Documents, attached to the ${relatedEntityType} record. He can open it in the app (Documents, or the record's own page) and share or download it from there.`;
      },
    },
  ];
}
