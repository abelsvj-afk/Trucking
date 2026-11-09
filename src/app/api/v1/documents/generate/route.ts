// POST /api/v1/documents/generate - create a document in the app
// (docs/design/expense-buckets-documents.md section 3). The web twin
// of Abel's create_document tool: same templates, same generator
// seam, same filing pipeline. Content is built only from recorded
// data - expense kinds read the expense row server-side; invoice /
// statement take structured fields the caller supplies - and the
// result is filed attached to its record like any upload.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { notFound, validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { createDocumentFile } from "@/services/documents/generate-document";
import {
  CREATABLE_KIND_DOC_TYPE,
  deductionNoticeDocument,
  expenseRecordDocument,
  structuredDocument,
  type DocumentModel,
} from "@/lib/document-templates";
import { documentSituationSchema, relatedEntityTypeSchema } from "@/data/schemas/documents";

const bodySchema = z.object({
  kind: z.enum(["expense_record", "deduction_notice", "invoice", "statement"]),
  expense_id: z.string().uuid().optional(),
  related_entity_type: relatedEntityTypeSchema.optional(),
  related_entity_id: z.string().uuid().optional(),
  situation: documentSituationSchema,
  title: z.string().trim().min(1).max(200).optional(),
  party_from: z.string().trim().min(1).max(200).optional(),
  party_to: z.string().trim().min(1).max(200).optional(),
  lines: z
    .array(z.object({ label: z.string().trim().min(1).max(300), amount_cents: z.number().int().nullable() }))
    .max(50)
    .optional(),
  total_cents: z.number().int().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  generator: z.string().trim().min(1).max(64).optional(),
});

function todayWords(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

export const POST = createApiHandler(async (req, ctx) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw validationError("That document request doesn't look right - check the fields and try again.");
  const body = parsed.data;
  const supabase = await createClient();
  const companyId = ctx.auth.companyId;

  let model: DocumentModel;
  let relatedEntityType: string;
  let relatedEntityId: string;

  if (body.kind === "expense_record" || body.kind === "deduction_notice") {
    if (!body.expense_id) throw validationError("expense_id is required for an expense document.");
    const { data: expense, error } = await supabase
      .from("expenses")
      .select("category, amount_cents, expense_date, description, bucket")
      .eq("id", body.expense_id)
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .single();
    if (error || !expense) throw notFound();
    const exp = expense as {
      category: string;
      amount_cents: number;
      expense_date: string;
      description: string | null;
      bucket?: string | null;
    };
    if (body.kind === "deduction_notice" && exp.bucket !== "pay_deduction") {
      throw validationError("That expense is a business expense, not a pay deduction - a deduction notice only fits a pay-deduction expense.");
    }
    model =
      body.kind === "expense_record"
        ? expenseRecordDocument({ expense: exp, situation: body.situation, createdDateWords: todayWords() })
        : deductionNoticeDocument({ expense: exp, situation: body.situation, createdDateWords: todayWords() });
    relatedEntityType = "expense";
    relatedEntityId = body.expense_id;
  } else {
    if (!body.related_entity_type || !body.related_entity_id) {
      throw validationError("An invoice or statement needs the record it belongs to (related_entity_type and related_entity_id).");
    }
    if (!body.title || !body.party_from || !body.party_to || !body.lines || body.lines.length === 0) {
      throw validationError("An invoice or statement needs a title, both parties, and at least one line.");
    }
    model = structuredDocument({
      kind: body.kind,
      title: body.title,
      party_from: body.party_from,
      party_to: body.party_to,
      date_words: todayWords(),
      lines: body.lines,
      total_cents: body.total_cents ?? null,
      notes: body.notes ?? null,
      situation: body.situation,
    });
    relatedEntityType = body.related_entity_type;
    relatedEntityId = body.related_entity_id;
  }

  const row = await createDocumentFile(supabase, {
    companyId,
    relatedEntityType,
    relatedEntityId,
    docType: CREATABLE_KIND_DOC_TYPE[body.kind],
    situation: body.situation,
    model,
    generatorId: body.generator,
  });
  return NextResponse.json(row, { status: 201 });
});
