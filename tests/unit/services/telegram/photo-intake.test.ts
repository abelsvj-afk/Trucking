// §13 Telegram photo intake: a photo message becomes a document
// through the shared pipeline — largest rendition, oversize refused
// before anything is stored, download/store failures are honest
// replies that saved nothing, and the extraction state is reported
// as it actually is (off is said plainly, done quotes the read,
// pending is never dressed up as read).

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleTelegramPhoto,
  pickLargestPhoto,
  type TelegramPhotoIntakeDeps,
  type TelegramPhotoSize,
} from "@/services/telegram/photo-intake";
import { StoreDocumentError } from "@/services/documents/store-document";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";
const DOC_ID = "15151515-1515-4515-8515-151515151515";

const PHOTOS: TelegramPhotoSize[] = [
  { file_id: "small", width: 90, height: 90, file_size: 2_000 },
  { file_id: "large", width: 1280, height: 960, file_size: 180_000 },
  { file_id: "medium", width: 800, height: 600, file_size: 90_000 },
];

function fetchReturning(bytes: ArrayBuffer, opts: { getFileOk?: boolean; downloadOk?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("/getFile")) {
      return {
        ok: true,
        json: async () =>
          opts.getFileOk === false
            ? { ok: false, description: "file not found" }
            : { ok: true, result: { file_path: "photos/file_1.jpg", file_size: bytes.byteLength } },
      };
    }
    return {
      ok: opts.downloadOk !== false,
      arrayBuffer: async () => bytes,
    };
  });
}

function deps(overrides: Partial<TelegramPhotoIntakeDeps> = {}): TelegramPhotoIntakeDeps & {
  storeFile: ReturnType<typeof vi.fn>;
} {
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
  return {
    client: {} as SupabaseClient,
    companyId: COMPANY,
    botToken: "test-token",
    fetchFn: fetchReturning(bytes) as never,
    storeFile: vi.fn().mockResolvedValue({
      id: DOC_ID,
      company_id: COMPANY,
      related_entity_type: "company",
      related_entity_id: COMPANY,
      file_name: "telegram-photo-x.jpg",
      storage_path: `${COMPANY}/x`,
      uploaded_at: "2026-11-01T00:00:00Z",
      created_at: "2026-11-01T00:00:00Z",
    }),
    extractionStatus: vi.fn().mockResolvedValue({ state: "off" }),
    now: () => new Date("2026-11-01T04:30:12Z"),
    ...overrides,
  } as TelegramPhotoIntakeDeps & { storeFile: ReturnType<typeof vi.fn> };
}

describe("pickLargestPhoto", () => {
  it("picks by declared file size when present", () => {
    expect(pickLargestPhoto(PHOTOS).file_id).toBe("large");
  });

  it("falls back to pixel area when sizes are undeclared", () => {
    const photos: TelegramPhotoSize[] = [
      { file_id: "a", width: 100, height: 100 },
      { file_id: "b", width: 400, height: 300 },
    ];
    expect(pickLargestPhoto(photos).file_id).toBe("b");
  });
});

describe("handleTelegramPhoto", () => {
  it("downloads the largest rendition and stores it under the company via the shared pipeline", async () => {
    const d = deps();
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("Saved that photo as a document");
    expect(reply).toContain("filed under your company");
    // getFile was asked for the LARGEST rendition, not the first.
    const fetchFn = d.fetchFn as unknown as ReturnType<typeof vi.fn>;
    expect(fetchFn.mock.calls[0]?.[0]).toContain("file_id=large");
    const storeArgs = d.storeFile.mock.calls[0]!;
    expect(storeArgs[1]).toMatchObject({
      companyId: COMPANY,
      relatedEntityType: "company",
      relatedEntityId: COMPANY,
      contentType: "image/jpeg",
      size: 4,
    });
    expect(storeArgs[1].fileName).toBe("telegram-photo-20261101043012.jpg");
  });

  it("says plainly that extraction is off and the photo was stored unread", async () => {
    const d = deps();
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("Document text extraction is off");
    expect(reply).toContain("without reading its text");
  });

  it("reports the doc type and the read's opening when extraction is done", async () => {
    const d = deps({
      extractionStatus: vi
        .fn()
        .mockResolvedValue({ state: "done", docType: "bol", summary: "PRO 4417, pickup Atlanta" }),
    });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("I read it as a bol");
    expect(reply).toContain("PRO 4417, pickup Atlanta");
  });

  it("calls a pending read pending — never read", async () => {
    const d = deps({ extractionStatus: vi.fn().mockResolvedValue({ state: "processing" }) });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("still pending");
    expect(reply).not.toContain("I read it");
  });

  it("includes his caption as his note on the document", async () => {
    const d = deps();
    const reply = await handleTelegramPhoto(d, PHOTOS, "BOL for the Georgia load");
    expect(reply).toContain('Your note on it: "BOL for the Georgia load"');
  });

  it("refuses an oversize photo from its declared size — no download, no store", async () => {
    const d = deps();
    const big: TelegramPhotoSize[] = [{ file_id: "huge", file_size: 26 * 1024 * 1024 }];
    const reply = await handleTelegramPhoto(d, big);
    expect(reply).toContain("bigger than the 25MB limit");
    expect(reply).toContain("nothing was saved");
    expect(d.fetchFn).not.toHaveBeenCalled();
    expect(d.storeFile).not.toHaveBeenCalled();
  });

  it("refuses when the downloaded bytes themselves are oversize", async () => {
    const bigBytes = new ArrayBuffer(26 * 1024 * 1024);
    const d = deps({ fetchFn: fetchReturning(bigBytes) as never });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("bigger than the 25MB limit");
    expect(d.storeFile).not.toHaveBeenCalled();
  });

  it("stores nothing and says so when Telegram can't produce the file", async () => {
    const bytes = new Uint8Array([1]).buffer as ArrayBuffer;
    const d = deps({ fetchFn: fetchReturning(bytes, { getFileOk: false }) as never });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("couldn't download that photo");
    expect(reply).toContain("nothing was stored");
    expect(d.storeFile).not.toHaveBeenCalled();
  });

  it("stores nothing and says so when the file download itself fails", async () => {
    const bytes = new Uint8Array([1]).buffer as ArrayBuffer;
    const d = deps({ fetchFn: fetchReturning(bytes, { downloadOk: false }) as never });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("couldn't download that photo");
    expect(d.storeFile).not.toHaveBeenCalled();
  });

  it("reports a store failure honestly — nothing half-stored", async () => {
    const d = deps({
      storeFile: vi.fn().mockRejectedValue(new StoreDocumentError("upload_failed", "boom")),
    });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("couldn't save it into your documents");
    expect(reply).toContain("nothing was stored");
  });

  it("still confirms the save when the extraction check itself fails", async () => {
    const d = deps({
      extractionStatus: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const reply = await handleTelegramPhoto(d, PHOTOS);
    expect(reply).toContain("Saved that photo as a document");
    expect(reply).toContain("couldn't check whether its text was read");
  });
});
