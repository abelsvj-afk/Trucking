// UH-14 fix (union fix round): Telegram album (media_group_id)
// grouping. Album photos used to become unrelated single documents —
// page 2 of a rate con mapped to nothing and staged its own
// proposals. Now: the FIRST photo of an album becomes the document;
// every later photo of the same group is attached to that one
// document as an additional page, and proposals/purpose settle ONCE
// (for the first page).
//
// Representation without a schema change: the primary document's
// extracted_fields (existing jsonb) carries { media_group_id,
// album_pages: [storage_path, ...] } in page order; page files live
// in the same documents bucket next to the primary's file. Group
// lookup filters on the jsonb field via PostgREST's ->> operator.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AlbumPrimary {
  id: string;
  storage_path: string;
  extracted_fields: Record<string, unknown> | null;
}

/** Finds the primary document for a media group, or null when this is the group's first photo. */
export async function findAlbumPrimary(
  client: SupabaseClient,
  companyId: string,
  mediaGroupId: string,
): Promise<AlbumPrimary | null> {
  const { data, error } = await client
    .from("documents")
    .select("id, storage_path, extracted_fields")
    .eq("company_id", companyId)
    .filter("extracted_fields->>media_group_id", "eq", mediaGroupId)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as AlbumPrimary;
}

/** Stamps the album marker + first page onto a freshly stored primary document. */
export async function markAlbumPrimary(
  client: SupabaseClient,
  companyId: string,
  documentId: string,
  mediaGroupId: string,
  storagePath: string,
  existingFields: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await client
    .from("documents")
    .update({
      extracted_fields: {
        ...(existingFields ?? {}),
        media_group_id: mediaGroupId,
        album_pages: [storagePath],
      },
    })
    .eq("id", documentId)
    .eq("company_id", companyId);
  if (error) console.error("[telegram] album primary stamp failed", error.message);
}

/**
 * Attaches one more page to the group's primary document: uploads
 * the bytes beside the primary file and appends the path to
 * album_pages (order = arrival order). Returns the new page count,
 * or null when the attach failed (caller then falls back to storing
 * the photo as its own document — a photo is never lost to grouping).
 */
export async function attachAlbumPage(
  client: SupabaseClient,
  companyId: string,
  primary: AlbumPrimary,
  bytes: ArrayBuffer,
  contentType = "image/jpeg",
): Promise<number | null> {
  const fields = (primary.extracted_fields ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(fields.album_pages)
    ? (fields.album_pages as string[])
    : [primary.storage_path];
  const pagePath = `${primary.storage_path}.page${pages.length + 1}`;
  const { error: uploadError } = await client.storage
    .from("documents")
    .upload(pagePath, bytes, { contentType, upsert: true });
  if (uploadError) {
    console.error("[telegram] album page upload failed", uploadError.message);
    return null;
  }
  const nextPages = [...pages, pagePath];
  const { error } = await client
    .from("documents")
    .update({ extracted_fields: { ...fields, album_pages: nextPages } })
    .eq("id", primary.id)
    .eq("company_id", companyId);
  if (error) {
    console.error("[telegram] album page stamp failed", error.message);
    return null;
  }
  return nextPages.length;
}
