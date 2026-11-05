// Doc-intake pitfall hunt (King, 2026-11-05): failing-first tests for
// the confirmed defects DH-1..DH-5 + DH-7. Register:
// ~/workspace/trucking-king-review/DOC-INTAKE-HUNT.md (mirrored in the
// PR description). Each describe names the defect it pins.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processUploadedDocument } from "@/services/documents/process-document";
import type { AiVisionProvider } from "@/services/ai/provider";
import { attachAlbumPage, findAlbumPrimary } from "@/services/telegram/album";
import {
  handleTelegramUpdate,
  type TelegramConfig,
  type TelegramDeps,
} from "@/services/telegram/dispatch-bot";
import type { TelegramStore } from "@/services/telegram/store";
import { resolvePhotoPurposeAskById } from "@/services/telegram/photo-purpose";
import { photoFileName } from "@/services/telegram/photo-intake";

const COMPANY = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// DH-1: processing must not erase the album marker stamped before it ran.
// ---------------------------------------------------------------------------

describe("DH-1: extraction preserves the album keys in extracted_fields", () => {
  function mockSupabase(existingFields: Record<string, unknown> | null) {
    const updates: Record<string, unknown>[] = [];
    const supabase = {
      from: (table: string) => {
        if (table === "companies") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { ai_globally_disabled: false }, error: null }),
              }),
            }),
          };
        }
        if (table === "ai_capability_settings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: { enabled: true }, error: null }),
                }),
              }),
            }),
          };
        }
        // documents
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { extracted_fields: existingFields }, error: null }),
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            updates.push(values);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      },
      storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    };
    return { supabase: supabase as never, updates };
  }

  const provider: AiVisionProvider = {
    completeWithImage: async () =>
      JSON.stringify({ doc_type: "bol", text: "BILL OF LADING", fields: { pickup_number: "4417" } }),
  };

  it("keeps media_group_id + album_pages alongside the extracted fields", async () => {
    const { supabase, updates } = mockSupabase({
      media_group_id: "g1",
      album_pages: ["co/doc.jpg", "co/doc.jpg.page2-x"],
    });
    await processUploadedDocument(
      supabase,
      {
        companyId: COMPANY,
        documentId: "doc-1",
        fileName: "telegram-photo-1.jpg",
        fileBuffer: Buffer.from("not really a jpeg"),
        contentType: "image/jpeg",
      },
      { createVisionProvider: () => provider },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.extraction_status).toBe("done");
    expect(updates[0]!.extracted_fields).toEqual({
      pickup_number: "4417",
      media_group_id: "g1",
      album_pages: ["co/doc.jpg", "co/doc.jpg.page2-x"],
    });
  });
});

// ---------------------------------------------------------------------------
// DH-2: attach merges onto the row's CURRENT fields; page paths never collide.
// ---------------------------------------------------------------------------

describe("DH-2: album attach freshness + unique page paths", () => {
  function fakeDb() {
    const row: Record<string, unknown> = {
      id: "doc1",
      company_id: COMPANY,
      storage_path: "c/doc1.jpg",
      extracted_fields: { media_group_id: "g1", album_pages: ["c/doc1.jpg"] },
    };
    const uploads: string[] = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            // Reads cross a serialization boundary in production: hand
            // back deep copies, never the live row object.
            filter: () => ({ limit: async () => ({ data: [structuredClone(row)], error: null }) }),
            eq: () => ({
              maybeSingle: async () => ({
                data: { extracted_fields: structuredClone(row.extracted_fields) },
                error: null,
              }),
            }),
          }),
        }),
        update: (values: Record<string, unknown>) => ({
          eq: () => ({
            eq: async () => {
              Object.assign(row, values);
              return { error: null };
            },
          }),
        }),
      }),
      storage: {
        from: () => ({
          upload: async (path: string) => {
            uploads.push(path);
            return { error: null };
          },
        }),
      },
    };
    return { client: client as unknown as SupabaseClient, row, uploads };
  }

  it("does not resurrect the pre-extraction snapshot when processing landed first", async () => {
    const { client, row } = fakeDb();
    const primary = await findAlbumPrimary(client, COMPANY, "g1");
    // Processing lands between the find and the attach: the row's
    // fields now ALSO carry the extraction result.
    row.extracted_fields = {
      media_group_id: "g1",
      album_pages: ["c/doc1.jpg"],
      pickup_number: "4417",
    };
    const count = await attachAlbumPage(client, COMPANY, primary!, new ArrayBuffer(3));
    expect(count).toBe(2);
    const fields = row.extracted_fields as Record<string, unknown>;
    expect(fields.pickup_number).toBe("4417");
    expect(fields.album_pages).toHaveLength(2);
  });

  it("two attaches from the same stale snapshot write distinct page files", async () => {
    const { client, row, uploads } = fakeDb();
    const primary = await findAlbumPrimary(client, COMPANY, "g1");
    await attachAlbumPage(client, COMPANY, primary!, new ArrayBuffer(3));
    await attachAlbumPage(client, COMPANY, primary!, new ArrayBuffer(3));
    expect(new Set(uploads).size).toBe(2);
    const fields = row.extracted_fields as { album_pages: string[] };
    expect(fields.album_pages).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// DH-3: a failed reply send after the store must not reprocess the photo.
// ---------------------------------------------------------------------------

const CONFIG: TelegramConfig = {
  botToken: "test-token",
  webhookSecret: null,
  allowedChatId: "4242",
  companyId: "company-1",
};

const PHOTO = [{ file_id: "large", width: 1280, height: 960, file_size: 180_000 }];

describe("DH-3: photo reply send failure keeps the claim (no duplicate store)", () => {
  function storeWithClaim() {
    return {
      loadHistory: vi.fn().mockResolvedValue([]),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      loadMemories: vi.fn().mockResolvedValue([]),
      saveMemory: vi.fn().mockResolvedValue(undefined),
      loadSnapshot: vi.fn().mockResolvedValue(null),
      storeExchange: vi.fn().mockResolvedValue(undefined),
      claimTelegramUpdate: vi.fn().mockResolvedValue(true),
      releaseTelegramUpdate: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramStore & {
      claimTelegramUpdate: ReturnType<typeof vi.fn>;
      releaseTelegramUpdate: ReturnType<typeof vi.fn>;
    };
  }

  it("resolves photo_replied and never releases the claim when sendMessage throws", async () => {
    const store = storeWithClaim();
    const deps = {
      sendMessage: vi.fn().mockRejectedValue(new Error("Telegram sendMessage failed.")),
      getSuggestion: vi.fn(),
      runChat: vi.fn(),
      handlePhoto: vi.fn().mockResolvedValue("Saved that photo as a document in your app."),
      store,
    } as unknown as TelegramDeps & { handlePhoto: ReturnType<typeof vi.fn> };

    const result = await handleTelegramUpdate(
      { update_id: 77, message: { chat: { id: 4242, type: "private" }, photo: PHOTO } },
      CONFIG,
      deps,
    );
    expect(result).toBe("photo_replied");
    expect(deps.handlePhoto).toHaveBeenCalledTimes(1);
    expect(store.releaseTelegramUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DH-4: two concurrent taps settle a purpose ask exactly once.
// ---------------------------------------------------------------------------

describe("DH-4: purpose ask claim is atomic", () => {
  const ASK_ID = "33333333-3333-4333-8333-333333333333";
  const DOC_ID = "44444444-4444-4444-8444-444444444444";

  function raceClient() {
    const state: { deleted_at: string | null } = { deleted_at: null };
    const row = {
      id: ASK_ID,
      arguments: {
        document_id: DOC_ID,
        headline: "Looks like paperwork.",
        fields: {},
        candidates: [
          { purpose: "paperwork", confidence: 0.7 },
          { purpose: "trailer", confidence: 0.3 },
        ],
        classifier_confidence: 0.7,
      },
      summary: "Photo purpose question",
      created_at: new Date().toISOString(),
    };
    const client = {
      from: (table: string) => {
        if (table !== "bot_pending_actions") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    maybeSingle: async () => ({
                      data: state.deleted_at ? null : row,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                is: async () => {
                  if (state.deleted_at) return { error: null, count: 0 };
                  state.deleted_at = (values.deleted_at as string) ?? "claimed";
                  return { error: null, count: 1 };
                },
              }),
            }),
          }),
        };
      },
    };
    return client as unknown as SupabaseClient;
  }

  it("the loser of a double-tap gets 'already settled', never a second settle", async () => {
    const client = raceClient();
    const deps = { client, companyId: COMPANY };
    const [r1, r2] = await Promise.all([
      resolvePhotoPurposeAskById(deps, ASK_ID, "store"),
      resolvePhotoPurposeAskById(deps, ASK_ID, "store"),
    ]);
    const replies = [r1, r2];
    expect(replies.filter((r) => r.includes("Filed as a plain document"))).toHaveLength(1);
    expect(replies.filter((r) => r.includes("already settled"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DH-5: an edit-only update is silent - no boilerplate reply.
// ---------------------------------------------------------------------------

describe("DH-5: edited-message-only updates get no reply", () => {
  it("a message edit is ignored silently", async () => {
    const deps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSuggestion: vi.fn(),
      runChat: vi.fn(),
      handlePhoto: vi.fn(),
      store: null,
    } as unknown as TelegramDeps & { sendMessage: ReturnType<typeof vi.fn> };

    const result = await handleTelegramUpdate(
      {
        update_id: 91,
        edited_message: {
          chat: { id: 4242, type: "private" },
          date: 1_762_000_000,
          edit_date: 1_762_000_600,
        },
      },
      CONFIG,
      deps,
    );
    expect(result).toBe("edit_ignored");
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DH-7: stored-photo filenames carry Eastern time, never a UTC stamp.
// ---------------------------------------------------------------------------

describe("DH-7: photoFileName stamps America/New_York", () => {
  it("converts a UTC instant to the Eastern wall clock (EDT)", () => {
    // 2026-11-01T04:30:12Z is 12:30:12 AM EDT in New York.
    expect(photoFileName(new Date("2026-11-01T04:30:12.000Z"))).toBe(
      "telegram-photo-20261101003012.jpg",
    );
  });
  it("converts a UTC instant to the Eastern wall clock (EST)", () => {
    // 2026-01-15T12:00:00Z is 7:00:00 AM EST in New York.
    expect(photoFileName(new Date("2026-01-15T12:00:00.000Z"))).toBe(
      "telegram-photo-20260115070000.jpg",
    );
  });
});
