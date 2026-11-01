// §13 wiring (intake merge prep): a Telegram photo that lands in
// documents now goes through document-scan's processor — the same
// processUploadedDocument entry point a web upload uses — whenever
// the extraction gate is open, and is stored plainly when it is
// closed. These tests run handleTelegramPhoto with the REAL shared
// store pipeline, the REAL default processing dep, and the REAL
// seam reader against a fake Supabase, so what they prove is the
// wiring itself: gate open → scan rendition uploaded + processing
// state written onto the row; gate closed → no processing at all.
// (The extraction read itself is stubbed by the environment: with
// no OPENAI_API_KEY the provider construction fails inside the
// processor, which records extraction_status "failed" — the
// processor's own success paths are covered by its §10 tests.)

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleTelegramPhoto,
  type TelegramPhotoIntakeDeps,
  type TelegramPhotoSize,
} from "@/services/telegram/photo-intake";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";
const DOC_ID = "15151515-1515-4515-8515-151515151515";

const PHOTOS: TelegramPhotoSize[] = [{ file_id: "large", width: 200, height: 150, file_size: 5_000 }];

let jpegBytes: ArrayBuffer;
let savedApiKey: string | undefined;

beforeAll(async () => {
  // A real JPEG (the processor's scan step decodes it with sharp).
  const width = 200;
  const height = 150;
  const rgb = new Uint8Array(width * height * 3).fill(235);
  const buf = await sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
  jpegBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  // The provider must fail fast inside the processor — a present
  // key would attempt a real API call from a unit test.
  savedApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey;
});

function fetchReturning(bytes: ArrayBuffer) {
  return vi.fn(async (url: string) => {
    if (url.includes("/getFile")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { file_path: "photos/file_1.jpg", file_size: bytes.byteLength },
        }),
      };
    }
    return { ok: true, arrayBuffer: async () => bytes };
  });
}

/** A fake Supabase sufficient for the store pipeline, the gate, the processor, and the seam reader. */
function fakeClient(capabilityRow: { enabled: boolean } | null) {
  const uploads: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let docRow: Record<string, unknown> | null = null;

  const client = {
    from: (table: string) => {
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { ai_globally_disabled: false }, error: null }),
            }),
          }),
        };
      }
      if (table === "ai_capability_settings") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: capabilityRow, error: null }),
              }),
            }),
          }),
        };
      }
      // documents
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              docRow = { ...row, id: DOC_ID };
              return { data: docRow, error: null };
            },
          }),
        }),
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            eq: async () => {
              if (docRow) Object.assign(docRow, values);
              return { error: null };
            },
          };
        },
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: docRow
                  ? {
                      doc_type: docRow.doc_type ?? null,
                      extracted_text: docRow.extracted_text ?? null,
                      extraction_status: docRow.extraction_status ?? null,
                    }
                  : null,
                error: null,
              }),
            }),
          }),
        }),
      };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        remove: async () => ({ error: null }),
      }),
    },
  };

  return { client: client as unknown as SupabaseClient, uploads, updates, row: () => docRow };
}

function deps(
  client: SupabaseClient,
  overrides: Partial<TelegramPhotoIntakeDeps> = {},
): TelegramPhotoIntakeDeps {
  return {
    client,
    companyId: COMPANY,
    botToken: "test-token",
    fetchFn: fetchReturning(jpegBytes) as never,
    now: () => new Date("2026-11-01T04:30:12Z"),
    ...overrides,
  };
}

describe("handleTelegramPhoto — §13 processing wiring", () => {
  it("gate open: the stored photo goes through the processor (scan rendition + processing state on the row)", async () => {
    const fake = fakeClient({ enabled: true });
    const reply = await handleTelegramPhoto(deps(fake.client), PHOTOS);

    expect(reply).toContain("Saved that photo as a document");
    // Two uploads: the photo itself, then its scan rendition.
    expect(fake.uploads).toHaveLength(2);
    expect(fake.uploads[1]).toContain("-scan-");
    // The processor wrote its outcome onto the row: scan path set,
    // extraction attempted and recorded as failed (no API key in
    // the test env — the read itself is §10's tested behavior).
    const row = fake.row() as Record<string, unknown>;
    expect(row.scan_storage_path).toBe(fake.uploads[1]);
    expect(row.extraction_status).toBe("failed");
    // And the reply reports that state honestly, via the seam.
    expect(reply).toContain("reading this photo failed");
    expect(reply).toContain("stored as a photo only");
  });

  it("gate closed: the photo is stored plainly — no scan, no processing writes, off said plainly", async () => {
    const fake = fakeClient(null);
    const reply = await handleTelegramPhoto(deps(fake.client), PHOTOS);

    expect(reply).toContain("Saved that photo as a document");
    expect(fake.uploads).toHaveLength(1);
    expect(fake.updates).toHaveLength(0);
    const row = fake.row() as Record<string, unknown>;
    expect(row.extraction_status ?? null).toBeNull();
    expect(reply).toContain("Document text extraction is off");
    expect(reply).toContain("without reading its text");
  });

  it("invokes the processing dep with the stored document id and the downloaded bytes, after the store", async () => {
    const processDocument = vi.fn().mockResolvedValue("ran");
    const storeFile = vi.fn().mockResolvedValue({ id: DOC_ID });
    const extractionStatus = vi
      .fn()
      .mockResolvedValue({ state: "done", docType: "bol", summary: "PRO 4417, pickup Atlanta" });
    const d = deps({} as SupabaseClient, {
      storeFile: storeFile as never,
      processDocument,
      extractionStatus,
    });
    const reply = await handleTelegramPhoto(d, PHOTOS);

    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(processDocument).toHaveBeenCalledTimes(1);
    const [docId, buf] = processDocument.mock.calls[0]!;
    expect(docId).toBe(DOC_ID);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect((buf as Buffer).equals(Buffer.from(jpegBytes))).toBe(true);
    expect(processDocument.mock.invocationCallOrder[0]).toBeGreaterThan(
      storeFile.mock.invocationCallOrder[0]!,
    );
    expect(reply).toContain("I read it as a bol");
  });

  it("a processing failure still confirms the save and lets the seam report the state", async () => {
    const processDocument = vi.fn().mockRejectedValue(new Error("db down"));
    const storeFile = vi.fn().mockResolvedValue({ id: DOC_ID });
    const extractionStatus = vi.fn().mockResolvedValue({ state: "processing" });
    const d = deps({} as SupabaseClient, {
      storeFile: storeFile as never,
      processDocument,
      extractionStatus,
    });
    const reply = await handleTelegramPhoto(d, PHOTOS);

    expect(reply).toContain("Saved that photo as a document");
    expect(reply).toContain("still pending");
    expect(reply).not.toContain("I read it");
  });
});
