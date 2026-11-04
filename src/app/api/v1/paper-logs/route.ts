// Paper-log review (docs/design/driver-hud.md §6; docs/api-contracts.md).
// GET  - the sheets he has photographed (documents marked paper_log).
// POST - read one stored sheet's grid now (photo_intelligence gate),
//        store the read on the document, return the review payload.
// Reading never writes a duty row - only the save route does, after
// his review.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { ApiError, notFound, validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { loadHosConfig } from "@/services/api/hos-config";
import { isPhotoIntelligenceEnabled } from "@/services/ai/photo-classification";
import {
  buildPaperLogReview,
  persistPaperLogRead,
  readPaperLogFromDocument,
  PAPER_READ_KEY,
} from "@/services/fleet/paper-log-review";
import type { PaperLogListItem } from "@/types/paper-logs";

const readBodySchema = z.object({ document_id: z.string().uuid() });

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const companyId = ctx.auth.companyId;
  const { data, error } = await supabase
    .from("documents")
    .select("id, uploaded_at, file_name, extracted_fields")
    .eq("company_id", companyId)
    .eq("photo_purpose", "paper_log")
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  const docs = (data ?? []) as {
    id: string;
    uploaded_at: string;
    file_name: string;
    extracted_fields: Record<string, unknown> | null;
  }[];
  const ids = docs.map((d) => d.id);
  const savedIds = new Set<string>();
  if (ids.length > 0) {
    const { data: rows, error: rowsError } = await supabase
      .from("duty_logs")
      .select("source_document_id")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .in("source_document_id", ids);
    if (rowsError) throw new Error(rowsError.message);
    for (const r of (rows ?? []) as { source_document_id: string }[]) savedIds.add(r.source_document_id);
  }
  const items: PaperLogListItem[] = docs.map((d) => ({
    id: d.id,
    uploaded_at: d.uploaded_at,
    file_name: d.file_name,
    log_date: typeof d.extracted_fields?.paper_log_date === "string" ? d.extracted_fields.paper_log_date : null,
    read: d.extracted_fields?.[PAPER_READ_KEY] != null,
    saved: savedIds.has(d.id),
  }));
  return NextResponse.json({ data: items });
});

export const POST = createApiHandler(async (req, ctx) => {
  const parsed = readBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw validationError("Send the stored sheet's document_id.");
  const supabase = await createClient();
  const companyId = ctx.auth.companyId;

  if (!(await isPhotoIntelligenceEnabled(supabase, companyId))) {
    throw new ApiError(
      403,
      "CAPABILITY_OFF",
      "Reading photos is turned off. Turn on Photo understanding in Settings, or enter the day by hand.",
    );
  }

  let extraction;
  try {
    extraction = await readPaperLogFromDocument(supabase, companyId, parsed.data.document_id);
  } catch (err) {
    console.error("[paper-logs] read failed", err);
    throw new ApiError(
      502,
      "READ_FAILED",
      "The grid couldn't be read from that photo. Your sheet is saved; try a flatter, closer photo, or enter the day by hand.",
    );
  }
  await persistPaperLogRead(supabase, companyId, parsed.data.document_id, extraction);

  const { config } = await loadHosConfig(supabase, companyId);
  const review = await buildPaperLogReview(supabase, companyId, parsed.data.document_id, config.carrierTimeZone);
  if (!review) throw notFound();
  return NextResponse.json({ data: review });
});
