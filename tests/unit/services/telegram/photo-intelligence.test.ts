// Photo intelligence front door (design §3): the beats - kill
// switch first (off = the legacy intake, byte for byte), store
// first always, caption settles free, one classifier call, then
// act-or-ask on the §3.2 thresholds. Nothing is ever filed under
// a guessed purpose.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleTelegramPhotoIntelligent,
  type TelegramPhotoIntelligenceDeps,
} from "@/services/telegram/photo-intelligence";
import type { TelegramPhotoSize } from "@/services/telegram/photo-intake";
import type { BotBrainStore } from "@/services/bot/store";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";
const DOC_ID = "15151515-1515-4515-8515-151515151515";
const ASK_ID = "26262626-2626-4626-8626-262626262626";
const PHOTOS: TelegramPhotoSize[] = [{ file_id: "large", width: 200, height: 150, file_size: 5_000 }];
const BYTES = new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer;

function fetchReturning(bytes: ArrayBuffer) {
  return vi.fn(async (url: string) => {
    if (url.includes("/getFile")) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: bytes.byteLength } }),
      };
    }
    return { ok: true, arrayBuffer: async () => bytes };
  });
}

interface FakeWorld {
  client: SupabaseClient;
  docUpdates: Record<string, unknown>[];
  pendingInserts: Record<string, unknown>[];
}

function fakeClient(): FakeWorld {
  const docUpdates: Record<string, unknown>[] = [];
  const pendingInserts: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => {
      if (table === "documents") {
        return {
          update: (values: Record<string, unknown>) => {
            docUpdates.push(values);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { file_name: "telegram-photo-20261101.jpg", storage_path: `${COMPANY}/x.jpg` },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "bot_pending_actions") {
        return {
          insert: (row: Record<string, unknown>) => {
            pendingInserts.push(row);
            return { select: () => ({ single: async () => ({ data: { id: ASK_ID }, error: null }) }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([BYTES]), error: null }),
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, docUpdates, pendingInserts };
}

function fakeBrain(enabled: boolean): BotBrainStore {
  return {
    isPhotoIntelligenceEnabled: vi.fn().mockResolvedValue(enabled),
  } as unknown as BotBrainStore;
}

function visionReturning(payload: unknown) {
  const completeWithImage = vi.fn().mockResolvedValue(JSON.stringify(payload));
  const create = vi.fn(() => ({ completeWithImage }));
  return { create, completeWithImage };
}

function deps(
  world: FakeWorld,
  overrides: Partial<TelegramPhotoIntelligenceDeps> = {},
): TelegramPhotoIntelligenceDeps {
  return {
    client: world.client,
    companyId: COMPANY,
    botToken: "test-token",
    brainStore: fakeBrain(true),
    fetchFn: fetchReturning(BYTES) as never,
    storeFile: vi.fn().mockResolvedValue({ id: DOC_ID }) as never,
    now: () => new Date("2026-11-01T04:30:12Z"),
    ...overrides,
  };
}

describe("handleTelegramPhotoIntelligent — the §3 beats", () => {
  it("capability off: the legacy intake runs untouched and no classifier is built (A3)", async () => {
    const world = fakeClient();
    const vision = visionReturning({ purpose: "truck_exterior", confidence: 0.99, headline: "truck" });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, {
        brainStore: fakeBrain(false),
        createVisionProvider: vision.create as never,
        processDocument: vi.fn().mockResolvedValue("off") as never,
      }),
      PHOTOS,
    );
    expect(typeof reply).toBe("string");
    expect(reply as string).toContain("Saved that photo as a document in your app");
    expect(reply as string).toContain("Document text extraction is off");
    expect(vision.create).not.toHaveBeenCalled();
    // No purpose was stamped on the legacy path.
    expect(world.docUpdates).toHaveLength(0);
  });

  it("caption settles the purpose free — no vision call, stamped as caption", async () => {
    const world = fakeClient();
    const vision = visionReturning({});
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, { createVisionProvider: vision.create as never }),
      PHOTOS,
      "odometer",
    );
    expect(vision.create).not.toHaveBeenCalled();
    expect(world.docUpdates).toContainEqual({
      photo_purpose: "odometer_dash",
      photo_purpose_source: "caption",
      photo_purpose_confidence: null,
    });
    expect(reply as string).toContain("marked as a dash photo");
    expect(reply as string).toContain('Your note on it: "odometer"');
  });

  it("a confident truck read narrates and stamps — never the generic filing reply alone (A1)", async () => {
    const world = fakeClient();
    const vision = visionReturning({
      purpose: "truck_exterior",
      confidence: 0.93,
      headline: "That's the truck — unit 214, Freightliner Cascadia.",
      fields: { unit_number: "214", make: "Freightliner", model: "Cascadia", truck_type: "sleeper" },
      field_confidences: { unit_number: 0.97 },
      alternates: [],
    });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, { createVisionProvider: vision.create as never }),
      PHOTOS,
    );
    expect(typeof reply).toBe("string");
    expect(reply as string).toContain("unit 214");
    expect(reply as string).toContain("marked as the truck");
    expect(world.docUpdates).toContainEqual({
      photo_purpose: "truck_exterior",
      photo_purpose_source: "vision",
      photo_purpose_confidence: 0.93,
    });
    expect(world.pendingInserts).toHaveLength(0);
  });

  it("a confident paperwork read hands off to the existing pipeline", async () => {
    const world = fakeClient();
    const vision = visionReturning({
      purpose: "paperwork",
      confidence: 0.96,
      headline: "A bill of lading.",
      fields: {},
      field_confidences: {},
      alternates: [],
    });
    const processDocument = vi.fn().mockResolvedValue("ran");
    const extractionStatus = vi
      .fn()
      .mockResolvedValue({ state: "done", docType: "bol", summary: "PRO 4417, pickup Atlanta" });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, {
        createVisionProvider: vision.create as never,
        processDocument: processDocument as never,
        extractionStatus: extractionStatus as never,
      }),
      PHOTOS,
    );
    expect(processDocument).toHaveBeenCalledTimes(1);
    expect(reply as string).toContain("I read it as a bol");
    expect(world.docUpdates).toContainEqual(
      expect.objectContaining({ photo_purpose: "paperwork", photo_purpose_source: "vision" }),
    );
  });

  it("a middling read recommends + asks: the question is staged and nothing is stamped", async () => {
    const world = fakeClient();
    const vision = visionReturning({
      purpose: "trailer",
      confidence: 0.7,
      headline: "Looks like the trailer to me.",
      fields: { trailer_unit_number: "5831" },
      field_confidences: {},
      alternates: [{ purpose: "truck_exterior", confidence: 0.3 }],
    });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, { createVisionProvider: vision.create as never }),
      PHOTOS,
    );
    expect(typeof reply).toBe("object");
    const ask = (reply as { ask?: { pendingId: string; options: { label: string; choice: string }[] } }).ask;
    expect(ask?.pendingId).toBe(ASK_ID);
    expect(ask?.options.map((o) => o.choice)).toEqual(["trailer", "truck_exterior", "store"]);
    expect((reply as { text: string }).text).toContain("Am I right");
    // The staged question carries the read, keyed to the document.
    expect(world.pendingInserts).toHaveLength(1);
    const row = world.pendingInserts[0]!;
    expect(row.tool_name).toBe("photo_purpose");
    expect((row.arguments as { document_id: string }).document_id).toBe(DOC_ID);
    // Nothing filed under the guess.
    expect(world.docUpdates).toHaveLength(0);
  });

  it("a weak read asks cold, with Just file it last", async () => {
    const world = fakeClient();
    const vision = visionReturning({
      purpose: "other",
      confidence: 0.3,
      headline: "A blurry close-up.",
      fields: {},
      field_confidences: {},
      alternates: [],
    });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, { createVisionProvider: vision.create as never }),
      PHOTOS,
    );
    const ask = (reply as { ask?: { options: { choice: string }[] } }).ask;
    expect(ask?.options.map((o) => o.choice)).toEqual(["other", "store"]);
    expect((reply as { text: string }).text).toContain("not sure what it is");
  });

  it("a classifier failure stores the photo and says so — no stamp, no ask, no guess", async () => {
    const world = fakeClient();
    const create = () => ({
      completeWithImage: vi.fn().mockRejectedValue(new Error("provider down")),
    });
    const reply = await handleTelegramPhotoIntelligent(
      deps(world, { createVisionProvider: create as never }),
      PHOTOS,
    );
    expect(reply as string).toContain("couldn't tell what it is");
    expect(reply as string).toContain("just stored it");
    expect(world.docUpdates).toHaveLength(0);
    expect(world.pendingInserts).toHaveLength(0);
  });
});
