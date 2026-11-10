import { describe, expect, it } from "vitest";
import { storeDocumentFile } from "@/services/documents/store-document";

// The 00085 metadata (doc_type / situation / source / generator) rides
// the caption pattern: if the database doesn't have the columns yet,
// the file still stores - without the metadata - instead of being lost.
function fakeClient(firstInsertError: { message: string } | null) {
  const inserted: Record<string, unknown>[] = [];
  let inserts = 0;
  const client = {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ data: [{}], error: null }),
      }),
    },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        inserts += 1;
        return {
          select: () => ({
            single: async () =>
              inserts === 1 && firstInsertError
                ? { data: null, error: firstInsertError }
                : { data: { id: "doc-1", ...row }, error: null },
          }),
        };
      },
    }),
  };
  return { client: client as never, inserted };
}

const input = {
  companyId: "11111111-1111-4111-8111-111111111111",
  relatedEntityType: "expense",
  relatedEntityId: "22222222-2222-4222-8222-222222222222",
  fileName: "pay-deduction-notice.pdf",
  body: new Blob(["%PDF"], { type: "application/pdf" }),
  contentType: "application/pdf",
  size: 4,
  docType: "statement",
  situation: "carrier",
  source: "generated" as const,
  generator: "app_pdf",
};

describe("storeDocumentFile 00085 metadata", () => {
  it("inserts the metadata when the columns exist", async () => {
    const { client, inserted } = fakeClient(null);
    const row = await storeDocumentFile(client, input);
    expect(row.id).toBe("doc-1");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ doc_type: "statement", situation: "carrier", source: "generated", generator: "app_pdf" });
  });

  it("retries without the metadata when the columns don't exist yet", async () => {
    const { client, inserted } = fakeClient({
      message: 'column "situation" of relation "documents" does not exist',
    });
    const row = await storeDocumentFile(client, input);
    expect(row.id).toBe("doc-1");
    expect(inserted).toHaveLength(2);
    expect(inserted[1]).not.toHaveProperty("situation");
    expect(inserted[1]).not.toHaveProperty("doc_type");
  });
});
