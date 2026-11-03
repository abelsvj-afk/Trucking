// UH-02 + UH-03 regression tests (union fix round).
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore } from "@/services/bot/store";
import { pretripAskMatches, pretripItemsCovered } from "@/services/telegram/photo-purpose";

const COMPANY = "22222222-2222-4222-8222-222222222222";

describe("UH-03 matching rule (pure)", () => {
  it("a tire photo does NOT fulfil a BOL-only ask for a different load (hunt proof, inverted)", () => {
    const ask = { id: "req-bol", load_id: "99999999-9999-4999-8999-999999999999", detail: { items: ["BOL"] } };
    expect(pretripAskMatches(ask, { evidenceText: "steer tire, tread looks fine", loadId: null })).toBe(false);
  });
  it("one photo does NOT discharge a four-item ask", () => {
    const ask = { id: "r", load_id: null, detail: { items: ["tires", "lights", "load securement", "BOL"] } };
    expect(pretripAskMatches(ask, { evidenceText: "tire photo", loadId: null })).toBe(false);
    expect(pretripItemsCovered(["tires"], "steer tire, tread looks fine")).toBe(true);
    expect(pretripItemsCovered(["BOL"], "BOL bill of lading")).toBe(true);
  });
  it("a matching tire ask with no load scope IS fulfilled by a tire photo", () => {
    const ask = { id: "r", load_id: null, detail: { items: ["tires"] } };
    expect(pretripAskMatches(ask, { evidenceText: "steer tire", loadId: null })).toBe(true);
  });
});

function settleFake(request: Record<string, unknown>) {
  const client = {
    from: (table: string) => {
      if (table === "documents") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { file_name: "p.jpg", storage_path: "x/p.jpg", related_entity_type: "company", related_entity_id: COMPANY },
                  error: null,
                }),
              }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
      }
      if (table === "research_requests") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [request], error: null }) }) }) }) }),
          }),
          update: (values: Record<string, unknown>) => {
            Object.assign(request, values);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (table === "pretrip_inspections") {
        return {
          select: () => ({
            eq: () => ({ is: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }) }) },
  };
  return client;
}

describe("UH-03 settle: mismatched ask stays queued", () => {
  it("tire photo leaves the BOL/different-load ask queued", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const request: Record<string, unknown> = {
      id: "req-bol", company_id: COMPANY, kind: "pretrip_photo", status: "queued",
      load_id: "99999999-9999-4999-8999-999999999999", detail: { items: ["BOL"] },
      created_at: "2026-11-02T07:00:00Z",
    };
    const client = settleFake(request);
    const brainStore = { client, companyId: COMPANY, channel: "telegram" } as unknown as BotBrainStore;
    await settlePhotoPurpose(
      { client: client as unknown as SupabaseClient, companyId: COMPANY, brainStore },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "pretrip", source: "vision", confidence: 0.9,
        headline: "Walk-around photo of the steer tire.",
        fields: { description: "steer tire, tread looks fine" },
      },
    );
    expect(request.status).toBe("queued");
  });
});

describe("Telegram repairs: seal + BOL reads surface in Abel's reply", () => {
  it("a trailer settle names the seal number and condition it read", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const client = settleFake({ id: "none", status: "queued", load_id: null, detail: { items: [] } });
    const result = await settlePhotoPurpose(
      { client: client as unknown as SupabaseClient, companyId: COMPANY },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "trailer",
        source: "vision",
        confidence: 0.94,
        headline: "The trailer doors are sealed.",
        fields: { trailer_unit_number: "5831", seal_number: "SL-004417", seal_condition: "intact" },
        fieldConfidences: { seal_number: 0.98 },
      },
    );
    expect(result.reply).toContain("Seal #: SL-004417");
    expect(result.reply).toContain("intact");
  });

  it("a paperwork settle reads back the BOL's structured fields", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const client = settleFake({ id: "none", status: "queued", load_id: null, detail: { items: [] } });
    const result = await settlePhotoPurpose(
      {
        client: client as unknown as SupabaseClient, companyId: COMPANY,
        processDocument: async () => "ran",
        extractionStatus: async () => ({ state: "done", docType: "bol", summary: "BILL OF LADING..." }),
        extractedDocument: async () => ({
          docType: "bol",
          fields: {
            bol_number: "BOL-88",
            shipper: "Acme Foods",
            receiver: "Blue Retail DC",
            pieces: 18,
            weight_lbs: 42100,
            seal_number: "SL-004417",
          },
        }),
        stageProposals: async () => null,
        clarityCheck: async () => false,
      },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "paperwork", source: "vision", confidence: 0.96,
        knownBytes: Buffer.from([1, 2, 3]),
      },
    );
    expect(result.reply).toContain("BOL details I read:");
    expect(result.reply).toContain("Shipper: Acme Foods");
    expect(result.reply).toContain("Consignee: Blue Retail DC");
    expect(result.reply).toContain("Seal #: SL-004417");
  });
});

describe("UH-02: intelligent settle stages GAP-01 proposals", () => {
  it("appends the staging outcome when extraction is done", async () => {
    const { settlePhotoPurpose } = await import("@/services/telegram/photo-purpose");
    const client = settleFake({ id: "none", status: "queued", load_id: null, detail: { items: [] } });
    const result = await settlePhotoPurpose(
      {
        client: client as unknown as SupabaseClient, companyId: COMPANY,
        processDocument: async () => "ran",
        extractionStatus: async () => ({ state: "done", docType: "fuel_receipt", summary: "Gallons 100" }),
        stageProposals: async () => "Staged a fuel purchase for your yes.",
        clarityCheck: async () => false,
      },
      {
        documentId: "15151515-1515-4515-8515-151515151515",
        choice: "paperwork", source: "vision", confidence: 0.9,
        knownBytes: Buffer.from([1, 2, 3]),
      },
    );
    expect(result.reply).toContain("Staged a fuel purchase");
  });
});
