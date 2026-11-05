// UH-14 regression tests (union fix round): album grouping helpers.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachAlbumPage, findAlbumPrimary, markAlbumPrimary } from "@/services/telegram/album";

const COMPANY = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  const rows: Record<string, unknown>[] = [
    { id: "doc1", company_id: COMPANY, storage_path: "c/doc1.jpg", extracted_fields: { media_group_id: "g1", album_pages: ["c/doc1.jpg"] } },
  ];
  const uploads: { path: string }[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          filter: () => ({
            limit: async () => ({ data: rows, error: null }),
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: () => ({
          eq: async () => {
            Object.assign(rows[0]!, values);
            return { error: null };
          },
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push({ path });
          return { error: null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, rows, uploads };
}

describe("UH-14: album grouping", () => {
  it("finds the primary and attaches page 2 to the SAME document", async () => {
    const { client, rows, uploads } = fakeDb();
    const primary = await findAlbumPrimary(client, COMPANY, "g1");
    expect(primary?.id).toBe("doc1");
    const count = await attachAlbumPage(client, COMPANY, primary!, new ArrayBuffer(3));
    expect(count).toBe(2);
    // DH-2: page paths carry a unique suffix so racing attaches can
    // never overwrite each other's bytes.
    expect(uploads[0]!.path).toMatch(/^c\/doc1\.jpg\.page2-[0-9a-f]{8}$/);
    expect((rows[0]!.extracted_fields as { album_pages: string[] }).album_pages).toEqual([
      "c/doc1.jpg",
      uploads[0]!.path,
    ]);
  });
  it("markAlbumPrimary stamps group + first page", async () => {
    const { client, rows } = fakeDb();
    rows[0]!.extracted_fields = null;
    await markAlbumPrimary(client, COMPANY, "doc1", "g9", "c/doc1.jpg", null);
    const fields = rows[0]!.extracted_fields as { media_group_id: string; album_pages: string[] };
    expect(fields.media_group_id).toBe("g9");
    expect(fields.album_pages).toEqual(["c/doc1.jpg"]);
  });
});
