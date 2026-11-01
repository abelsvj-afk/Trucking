// §13 extraction seam: the read side of the document-scan contract.
// Off unless a settings row enables it (fail-closed, like every
// capability); on-but-columns-absent is "unavailable", never a
// fabricated read; a processed row reports its real state.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDocumentExtractionStatus } from "@/services/documents/extraction-hook";

const COMPANY = "company-1";
const DOC = "doc-1";

function fakeClient(opts: {
  setting?: { enabled: boolean } | null;
  doc?: Record<string, unknown> | null;
  docError?: { message: string } | null;
}) {
  const maybeSingle = vi.fn(async () => ({ data: opts.setting ?? null, error: null }));
  const docMaybeSingle = vi.fn(async () => ({ data: opts.doc ?? null, error: opts.docError ?? null }));
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: table === "ai_capability_settings" ? maybeSingle : docMaybeSingle,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return client;
}

describe("getDocumentExtractionStatus", () => {
  it("is off when no settings row exists (fails closed)", async () => {
    const status = await getDocumentExtractionStatus(fakeClient({}), COMPANY, DOC);
    expect(status).toEqual({ state: "off" });
  });

  it("is off when the row disables it", async () => {
    const status = await getDocumentExtractionStatus(
      fakeClient({ setting: { enabled: false } }),
      COMPANY,
      DOC,
    );
    expect(status).toEqual({ state: "off" });
  });

  it("is unavailable when the capability is on but the extraction columns aren't in the database yet", async () => {
    const status = await getDocumentExtractionStatus(
      fakeClient({
        setting: { enabled: true },
        docError: { message: "column documents.doc_type does not exist" },
      }),
      COMPANY,
      DOC,
    );
    expect(status).toEqual({ state: "unavailable" });
  });

  it("reports done with the doc type and the text opening when text exists", async () => {
    const status = await getDocumentExtractionStatus(
      fakeClient({
        setting: { enabled: true },
        doc: { doc_type: "bol", extracted_text: "PRO 4417 — pickup Atlanta, delivery Savannah.", extraction_status: "complete" },
      }),
      COMPANY,
      DOC,
    );
    expect(status.state).toBe("done");
    if (status.state === "done") {
      expect(status.docType).toBe("bol");
      expect(status.summary).toContain("PRO 4417");
    }
  });

  it("reports processing when the row exists but no text has landed yet", async () => {
    const status = await getDocumentExtractionStatus(
      fakeClient({
        setting: { enabled: true },
        doc: { doc_type: null, extracted_text: null, extraction_status: "pending" },
      }),
      COMPANY,
      DOC,
    );
    expect(status).toEqual({ state: "processing" });
  });

  it("reports failed when the extraction status says so", async () => {
    const status = await getDocumentExtractionStatus(
      fakeClient({
        setting: { enabled: true },
        doc: { doc_type: null, extracted_text: null, extraction_status: "failed" },
      }),
      COMPANY,
      DOC,
    );
    expect(status).toEqual({ state: "failed" });
  });
});
