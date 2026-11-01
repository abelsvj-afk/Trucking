// §13: the shared documents pipeline both doors store through —
// the storage path convention the bucket policies check, the
// size/type rules from the web route (task 5.3), and the
// no-orphan cleanup when the row insert fails.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  StoreDocumentError,
  storeDocumentFile,
  type StoreDocumentInput,
} from "@/services/documents/store-document";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";

function fakeClient(opts: { uploadError?: unknown; insertError?: unknown } = {}) {
  const upload = vi.fn().mockResolvedValue({ error: opts.uploadError ?? null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const single = vi.fn().mockResolvedValue(
    opts.insertError
      ? { data: null, error: opts.insertError }
      : {
          data: {
            id: "doc-1",
            company_id: COMPANY,
            related_entity_type: "company",
            related_entity_id: COMPANY,
            file_name: "telegram-photo-1.jpg",
            storage_path: `${COMPANY}/uuid-telegram-photo-1.jpg`,
            uploaded_at: "2026-11-01T00:00:00Z",
            created_at: "2026-11-01T00:00:00Z",
          },
          error: null,
        },
  );
  const insert = vi.fn(() => ({ select: () => ({ single }) }));
  const client = {
    storage: { from: () => ({ upload, remove }) },
    from: () => ({ insert }),
  } as unknown as SupabaseClient;
  return { client, upload, remove, insert, single };
}

function input(overrides: Partial<StoreDocumentInput> = {}): StoreDocumentInput {
  return {
    companyId: COMPANY,
    relatedEntityType: "company",
    relatedEntityId: COMPANY,
    fileName: "telegram-photo-1.jpg",
    body: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    contentType: "image/jpeg",
    size: 3,
    ...overrides,
  };
}

describe("storeDocumentFile", () => {
  it("uploads under {company_id}/{uuid}-{file_name} and inserts the row", async () => {
    const { client, upload, insert } = fakeClient();
    const row = await storeDocumentFile(client, input());
    expect(row.id).toBe("doc-1");
    const [path, , uploadOpts] = upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${COMPANY}/[0-9a-f-]+-telegram-photo-1\\.jpg$`));
    expect(uploadOpts).toEqual({ contentType: "image/jpeg" });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: COMPANY,
        related_entity_type: "company",
        related_entity_id: COMPANY,
        file_name: "telegram-photo-1.jpg",
        storage_path: path,
      }),
    );
  });

  it("rejects an empty file as a validation error before any upload", async () => {
    const { client, upload } = fakeClient();
    await expect(storeDocumentFile(client, input({ size: 0 }))).rejects.toMatchObject({
      name: "StoreDocumentError",
      kind: "validation",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an oversize file as a validation error", async () => {
    const { client, upload } = fakeClient();
    await expect(
      storeDocumentFile(client, input({ size: 26 * 1024 * 1024 })),
    ).rejects.toBeInstanceOf(StoreDocumentError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content type as a validation error", async () => {
    const { client, upload } = fakeClient();
    await expect(
      storeDocumentFile(client, input({ contentType: "text/html" })),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("surfaces an upload failure as upload_failed and never inserts", async () => {
    const { client, insert } = fakeClient({ uploadError: { message: "bucket down" } });
    await expect(storeDocumentFile(client, input())).rejects.toMatchObject({
      kind: "upload_failed",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("removes the uploaded file when the row insert fails — no orphans", async () => {
    const { client, upload, remove } = fakeClient({ insertError: { message: "db down" } });
    await expect(storeDocumentFile(client, input())).rejects.toMatchObject({
      kind: "insert_failed",
    });
    const [path] = upload.mock.calls[0]!;
    expect(remove).toHaveBeenCalledWith([path]);
  });
});
