import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { processUploadedDocument } from "@/services/documents/process-document";
import type { AiVisionProvider } from "@/services/ai/provider";

// The orchestration contract (docs/design/driver-mvp.md §8):
// processing never throws, a scan failure or an AI failure degrades
// to state on the row, and the capability switches are honored
// before any provider call happens.

let jpegBuffer: Buffer;

beforeAll(async () => {
  const width = 200;
  const height = 150;
  const rgb = new Uint8Array(width * height * 3).fill(235);
  for (let y = 40; y < 46; y++) {
    for (let x = 30; x < 160; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = 20;
      rgb[i + 1] = 20;
      rgb[i + 2] = 20;
    }
  }
  jpegBuffer = await sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
});

function mockSupabase(options: {
  globallyDisabled?: boolean;
  capabilityRow?: { enabled: boolean } | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const storageUploads: string[] = [];

  const supabase = {
    from: (table: string) => {
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { ai_globally_disabled: options.globallyDisabled ?? false },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "ai_capability_settings") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: options.capabilityRow === undefined ? null : options.capabilityRow,
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      // documents
      return {
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    storage: {
      from: () => ({
        upload: (path: string) => {
          storageUploads.push(path);
          return Promise.resolve({ error: null });
        },
      }),
    },
  };

  return { supabase: supabase as never, updates, storageUploads };
}

const EXTRACTION_JSON = JSON.stringify({
  doc_type: "bol",
  text: "BILL OF LADING\nPickup #: 4417",
  fields: { pickup_number: "4417" },
});

function fakeProvider(impl: () => Promise<string>) {
  const calls: { imageBase64: string; mediaType: string }[] = [];
  const provider: AiVisionProvider = {
    completeWithImage: async (request) => {
      calls.push({ imageBase64: request.imageBase64, mediaType: request.mediaType });
      return impl();
    },
  };
  return { provider, calls };
}

const BASE_INPUT = {
  companyId: "company-1",
  documentId: "doc-1",
  fileName: "bol-photo.jpg",
};

describe("processUploadedDocument", () => {
  it("stores a scan and marks extraction disabled when the capability is off (no provider call)", async () => {
    const { supabase, updates, storageUploads } = mockSupabase({});
    const { provider, calls } = fakeProvider(async () => EXTRACTION_JSON);
    const createVisionProvider = vi.fn(() => provider);

    await processUploadedDocument(
      supabase,
      { ...BASE_INPUT, fileBuffer: jpegBuffer, contentType: "image/jpeg" },
      { createVisionProvider },
    );

    expect(storageUploads).toHaveLength(1);
    expect(storageUploads[0]).toContain("-scan-bol-photo.png");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.scan_storage_path).toBe(storageUploads[0]);
    expect(updates[0]!.extraction_status).toBe("disabled");
    expect(createVisionProvider).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("extracts from the scan rendition when the capability is enabled", async () => {
    const { supabase, updates } = mockSupabase({ capabilityRow: { enabled: true } });
    const { provider, calls } = fakeProvider(async () => EXTRACTION_JSON);

    await processUploadedDocument(
      supabase,
      { ...BASE_INPUT, fileBuffer: jpegBuffer, contentType: "image/jpeg" },
      { createVisionProvider: () => provider },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.extraction_status).toBe("done");
    expect(updates[0]!.doc_type).toBe("bol");
    expect(updates[0]!.extracted_text).toContain("Pickup #: 4417");
    expect(updates[0]!.extracted_fields).toEqual({ pickup_number: "4417" });
    expect(updates[0]!.extracted_at).toBeTypeOf("string");
    // The provider read the scan (PNG), not the original JPEG.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mediaType).toBe("image/png");
  });

  it("records a generic failure - never the provider's raw error - and doesn't throw", async () => {
    const { supabase, updates } = mockSupabase({ capabilityRow: { enabled: true } });
    const { provider } = fakeProvider(async () => {
      throw new Error("sk-live-secret-looking detail from the provider");
    });

    await expect(
      processUploadedDocument(
        supabase,
        { ...BASE_INPUT, fileBuffer: jpegBuffer, contentType: "image/jpeg" },
        { createVisionProvider: () => provider },
      ),
    ).resolves.toBeUndefined();

    expect(updates[0]!.extraction_status).toBe("failed");
    expect(String(updates[0]!.extraction_error)).not.toContain("sk-live");
    expect(updates[0]!.scan_storage_path).toBeTypeOf("string"); // scan survived the AI failure
  });

  it("marks PDFs not_applicable: no scan, no provider call", async () => {
    const { supabase, updates, storageUploads } = mockSupabase({
      capabilityRow: { enabled: true },
    });
    const createVisionProvider = vi.fn(() => {
      throw new Error("must not be constructed for a PDF");
    });

    await processUploadedDocument(
      supabase,
      { ...BASE_INPUT, fileBuffer: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" },
      { createVisionProvider },
    );

    expect(storageUploads).toHaveLength(0);
    expect(updates[0]!.extraction_status).toBe("not_applicable");
    expect(updates[0]!.scan_storage_path).toBeUndefined();
    expect(createVisionProvider).not.toHaveBeenCalled();
  });

  it("honors the global kill switch even when the capability row is enabled", async () => {
    const { supabase, updates } = mockSupabase({
      globallyDisabled: true,
      capabilityRow: { enabled: true },
    });
    const { provider, calls } = fakeProvider(async () => EXTRACTION_JSON);

    await processUploadedDocument(
      supabase,
      { ...BASE_INPUT, fileBuffer: jpegBuffer, contentType: "image/jpeg" },
      { createVisionProvider: () => provider },
    );

    expect(updates[0]!.extraction_status).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("still lands the document state when the photo is undecodable (no scan, extraction attempted on the original)", async () => {
    const { supabase, updates, storageUploads } = mockSupabase({
      capabilityRow: { enabled: true },
    });
    const { provider, calls } = fakeProvider(async () => EXTRACTION_JSON);

    await processUploadedDocument(
      supabase,
      { ...BASE_INPUT, fileBuffer: Buffer.from("not really a jpeg"), contentType: "image/jpeg" },
      { createVisionProvider: () => provider },
    );

    expect(storageUploads).toHaveLength(0);
    expect(updates[0]!.scan_storage_path).toBeUndefined();
    expect(updates[0]!.extraction_status).toBe("done");
    expect(calls[0]!.mediaType).toBe("image/jpeg"); // fell back to the original
  });
});
