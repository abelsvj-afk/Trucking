import { describe, expect, it, vi } from "vitest";
import { createDocumentFile } from "@/services/documents/generate-document";
import type { DocumentModel } from "@/lib/document-templates";

// Pins Phase 3 §1: createDocumentFile stores input.model on the row
// (via storeDocumentFile's insert), for every caller that goes through it.
function fakeClient() {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ data: [{}], error: null }) }) },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "doc-9", ...row }, error: null }) }) };
      },
    }),
  };
  return { client: client as never, inserted };
}

const model: DocumentModel = {
  title: "Expense Record",
  sections: [{ heading: null, lines: ["Amount: $250.00", "Date: 2026-11-08"] }],
};

describe("createDocumentFile model storage", () => {
  it("stores the model on the created documents row", async () => {
    const { client, inserted } = fakeClient();
    const row = await createDocumentFile(client, {
      companyId: "11111111-1111-4111-8111-111111111111",
      relatedEntityType: "expense",
      relatedEntityId: "22222222-2222-4222-8222-222222222222",
      docType: "receipt",
      situation: "carrier",
      model,
    });
    expect(row.id).toBe("doc-9");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ model, source: "generated", generator: "app_pdf" });
    // The caption (searchable text) still derives from the model.
    expect(String(inserted[0]!.caption)).toContain("$250.00");
  });

  it("still files the document when the model column is absent (graceful retry without model)", async () => {
    const inserted: Record<string, unknown>[] = [];
    let n = 0;
    const client = {
      storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ data: [{}], error: null }) }) },
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row); n += 1;
          const first = n === 1;
          return { select: () => ({ single: async () => first ? { data: null, error: { message: 'column "model" of relation "documents" does not exist' } } : { data: { id: "doc-9", ...row }, error: null } }) };
        },
      }),
    };
    const row = await createDocumentFile(client as never, {
      companyId: "11111111-1111-4111-8111-111111111111",
      relatedEntityType: "expense",
      relatedEntityId: "22222222-2222-4222-8222-222222222222",
      docType: "receipt", situation: "carrier", model,
    });
    expect(row.id).toBe("doc-9");
    expect(inserted).toHaveLength(2);
    expect(inserted[1]).not.toHaveProperty("model");
    vi.restoreAllMocks();
  });
});
