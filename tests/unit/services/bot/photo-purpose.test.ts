// Photo purpose resolution (design §3.3): the text spine and the
// by-id tap path. His reply to a staged question resolves in code
// (a number, a purpose word, a plain naming) - never through the
// write-tool path - and an expired question resolves with the
// honest expiry reply while the photo stays stored-unfiled (A5).

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn, BOT_DISABLED_REPLY } from "@/services/bot/agent-turn";
import type { BotBrainStore, PendingAction } from "@/services/bot/store";
import {
  parsePhotoPurposeAnswer,
  resolvePhotoPurposeAskById,
  settlePhotoPurpose,
  PHOTO_ASK_EXPIRED_REPLY,
} from "@/services/telegram/photo-purpose";
import type { PhotoPurposeCandidate } from "@/services/telegram/photo-purpose";

const COMPANY = "company-1";
const DOC_ID = "15151515-1515-4515-8515-151515151515";
const ASK_ID = "26262626-2626-4626-8626-262626262626";

const CANDIDATES: PhotoPurposeCandidate[] = [
  { purpose: "truck_exterior", confidence: 0.7 },
  { purpose: "trailer", confidence: 0.3 },
];

describe("parsePhotoPurposeAnswer", () => {
  it("resolves numbers over the shown options, store last", () => {
    expect(parsePhotoPurposeAnswer("1", CANDIDATES)).toBe("truck_exterior");
    expect(parsePhotoPurposeAnswer("2", CANDIDATES)).toBe("trailer");
    expect(parsePhotoPurposeAnswer("3", CANDIDATES)).toBe("store");
    expect(parsePhotoPurposeAnswer("4", CANDIDATES)).toBeNull();
  });

  it("resolves purpose words, slugs, and plain namings", () => {
    expect(parsePhotoPurposeAnswer("trailer", CANDIDATES)).toBe("trailer");
    expect(parsePhotoPurposeAnswer("that's the trailer", CANDIDATES)).toBe("trailer");
    expect(parsePhotoPurposeAnswer("it's the truck", CANDIDATES)).toBe("truck_exterior");
    expect(parsePhotoPurposeAnswer("truck_exterior", CANDIDATES)).toBe("truck_exterior");
    expect(parsePhotoPurposeAnswer("just file it", CANDIDATES)).toBe("store");
  });

  it("never settles from prose that merely touches a purpose", () => {
    expect(parsePhotoPurposeAnswer("the trailer door is bent, log it", CANDIDATES)).toBeNull();
    expect(parsePhotoPurposeAnswer("how is my week looking", CANDIDATES)).toBeNull();
    // A purpose that wasn't offered doesn't settle either.
    expect(parsePhotoPurposeAnswer("odometer", CANDIDATES)).toBeNull();
  });
});

interface FakeWorld {
  client: SupabaseClient;
  docUpdates: Record<string, unknown>[];
}

function fakeClient(): FakeWorld {
  const docUpdates: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => {
      if (table === "documents") {
        return {
          update: (values: Record<string, unknown>) => {
            docUpdates.push(values);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient, docUpdates };
}

function askRow(createdAt: Date): PendingAction {
  return {
    id: ASK_ID,
    tool_name: "photo_purpose",
    arguments: {
      document_id: DOC_ID,
      headline: "Looks like the trailer to me.",
      fields: {},
      candidates: CANDIDATES,
      classifier_confidence: 0.7,
    },
    summary: "Photo purpose question",
    channel: "telegram",
    created_at: createdAt.toISOString(),
    batch_id: null,
    item_number: null,
    source_quote: null,
    confidence: null,
  };
}

function fakeStore(world: FakeWorld, pending: PendingAction | null) {
  const cleared: string[] = [];
  const store = {
    client: world.client,
    companyId: COMPANY,
    channel: "telegram",
    loadPendingAction: vi.fn().mockResolvedValue(pending),
    loadPendingBatch: vi.fn().mockResolvedValue([]),
    clearPendingAction: vi.fn(async (id: string) => {
      cleared.push(id);
    }),
    clearPendingActions: vi.fn().mockResolvedValue(undefined),
    isBotChatEnabled: vi.fn().mockResolvedValue(false),
    savePendingAction: vi.fn().mockResolvedValue(undefined),
  };
  return { store: store as unknown as BotBrainStore, cleared };
}

const PROVIDER = {} as never;
const INPUT = {
  history: [],
  snapshotText: null,
  instructions: [],
  memories: [],
};

describe("runAgentTurn — photo-purpose interception (§3.3)", () => {
  it("a number reply settles the purpose in code, no model involved", async () => {
    const world = fakeClient();
    const { store, cleared } = fakeStore(world, askRow(new Date()));
    const out = await runAgentTurn(PROVIDER, store, { ...INPUT, userText: "2" });
    expect(out.reply).toContain("marked as the trailer");
    expect(cleared).toEqual([ASK_ID]);
    expect(world.docUpdates).toContainEqual({
      photo_purpose: "trailer",
      photo_purpose_source: "owner",
      photo_purpose_confidence: 0.3,
    });
  });

  it("a plain naming settles it too — conversation is a first-class answer", async () => {
    const world = fakeClient();
    const { store } = fakeStore(world, askRow(new Date()));
    const out = await runAgentTurn(PROVIDER, store, { ...INPUT, userText: "that's the truck" });
    expect(out.reply).toContain("marked as the truck");
    expect(world.docUpdates).toContainEqual(expect.objectContaining({ photo_purpose: "truck_exterior" }));
  });

  it("an expired question resolves with the expiry reply and stages nothing (A5)", async () => {
    const world = fakeClient();
    const { store, cleared } = fakeStore(world, askRow(new Date(Date.now() - 3 * 60 * 60 * 1000)));
    const out = await runAgentTurn(PROVIDER, store, { ...INPUT, userText: "2" });
    expect(out.reply).toBe(PHOTO_ASK_EXPIRED_REPLY);
    expect(cleared).toEqual([ASK_ID]);
    expect(world.docUpdates).toHaveLength(0);
  });

  // Telegram repairs D6: the button path re-checks the
  // photo_intelligence kill switch before settling (§3.4); the
  // text-reply path must honor the same switch - off means the
  // question settles nothing, whichever surface answers it.
  it("with photo understanding OFF, a number reply settles nothing and the ask stays open", async () => {
    const world = fakeClient();
    const { store, cleared } = fakeStore(world, askRow(new Date()));
    (store as unknown as { isPhotoIntelligenceEnabled: unknown }).isPhotoIntelligenceEnabled =
      vi.fn().mockResolvedValue(false);
    const out = await runAgentTurn(PROVIDER, store, { ...INPUT, userText: "2" });
    expect(out.reply).toBe(BOT_DISABLED_REPLY);
    expect(cleared).toEqual([]);
    expect(world.docUpdates).toHaveLength(0);
  });

  it("an unrelated message leaves the question open and the turn proceeds", async () => {
    const world = fakeClient();
    const { store, cleared } = fakeStore(world, askRow(new Date()));
    const out = await runAgentTurn(PROVIDER, store, {
      ...INPUT,
      userText: "how is my week looking",
    });
    // Falls through to the (disabled) chat path - proof the ask
    // wasn't force-settled by unrelated prose.
    expect(out.reply).toBe(BOT_DISABLED_REPLY);
    expect(cleared).toEqual([]);
    expect(world.docUpdates).toHaveLength(0);
  });
});

describe("settlePhotoPurpose narration (Telegram repairs D8)", () => {
  it("a field read below the ask bar is not narrated as read", async () => {
    const world = fakeClient();
    const result = await settlePhotoPurpose(
      { client: world.client, companyId: COMPANY },
      {
        documentId: DOC_ID,
        choice: "truck_exterior",
        source: "vision",
        confidence: 0.9,
        headline: "That's the truck.",
        fields: { unit_number: "214", make: "Freightliner" },
        fieldConfidences: { unit_number: 0.95, make: 0.4 },
      },
    );
    expect(result.reply).toContain("unit 214");
    expect(result.reply).not.toContain("Freightliner");
  });
});

describe("resolvePhotoPurposeAskById — the button path", () => {
  function askClient(createdAt: Date) {
    const docUpdates: Record<string, unknown>[] = [];
    const clearedUpdates: Record<string, unknown>[] = [];
    const row = {
      id: ASK_ID,
      arguments: {
        document_id: DOC_ID,
        headline: "Looks like the trailer to me.",
        fields: { trailer_unit_number: "5831" },
        candidates: CANDIDATES,
        classifier_confidence: 0.7,
      },
      summary: "Photo purpose question",
      created_at: createdAt.toISOString(),
    };
    const client = {
      from: (table: string) => {
        if (table === "bot_pending_actions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    is: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
                  }),
                }),
              }),
            }),
            update: (values: Record<string, unknown>) => {
              clearedUpdates.push(values);
              return { eq: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }) };
            },
          };
        }
        if (table === "documents") {
          return {
            update: (values: Record<string, unknown>) => {
              docUpdates.push(values);
              return { eq: () => ({ eq: async () => ({ error: null }) }) };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return { client: client as unknown as SupabaseClient, docUpdates, clearedUpdates };
  }

  it("settles the tapped purpose as the owner's word", async () => {
    const world = askClient(new Date());
    const reply = await resolvePhotoPurposeAskById(
      { client: world.client, companyId: COMPANY },
      ASK_ID,
      "trailer",
    );
    expect(reply).toContain("trailer 5831");
    expect(world.docUpdates).toContainEqual({
      photo_purpose: "trailer",
      photo_purpose_source: "owner",
      photo_purpose_confidence: 0.3,
    });
    expect(world.clearedUpdates).toHaveLength(1);
  });

  it("an expired ask clears and answers with the expiry reply", async () => {
    const world = askClient(new Date(Date.now() - 3 * 60 * 60 * 1000));
    const reply = await resolvePhotoPurposeAskById(
      { client: world.client, companyId: COMPANY },
      ASK_ID,
      "trailer",
    );
    expect(reply).toBe(PHOTO_ASK_EXPIRED_REPLY);
    expect(world.docUpdates).toHaveLength(0);
  });

  it("an unknown choice is a dead button, never a stamp", async () => {
    const world = askClient(new Date());
    const reply = await resolvePhotoPurposeAskById(
      { client: world.client, companyId: COMPANY },
      ASK_ID,
      "banana" as never,
    );
    expect(reply).toContain("doesn't work anymore");
    expect(world.docUpdates).toHaveLength(0);
  });
});
