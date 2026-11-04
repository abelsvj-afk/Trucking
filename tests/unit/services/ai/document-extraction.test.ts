import { describe, expect, it, vi } from "vitest";
import {
  extractDocumentText,
  formatExtractedFieldsForReply,
  parseDocumentExtraction,
} from "@/services/ai/document-extraction";
import type { AiVisionProvider, AiVisionRequest } from "@/services/ai/provider";

const VALID = {
  doc_type: "bol",
  text: "BILL OF LADING\nShipper: Acme Foods, Jacksonville FL\nPickup #: 4417",
  fields: { pickup_number: "4417", rate_amount: 1250.0, seal_number: null },
};

describe("parseDocumentExtraction", () => {
  it("parses a contract-shaped response, keeping the raw text whole", () => {
    const parsed = parseDocumentExtraction(JSON.stringify(VALID));
    expect(parsed.doc_type).toBe("bol");
    expect(parsed.text).toContain("Pickup #: 4417");
    expect(parsed.fields.pickup_number).toBe("4417");
    expect(parsed.fields.rate_amount).toBe(1250.0);
  });

  it("throws on non-JSON output", () => {
    expect(() => parseDocumentExtraction("BILL OF LADING...")).toThrow("not valid JSON");
  });

  it("throws on an unknown doc_type", () => {
    expect(() =>
      parseDocumentExtraction(JSON.stringify({ ...VALID, doc_type: "invoice" })),
    ).toThrow("didn't match the document extraction contract");
  });

  it("throws when the full text is missing - a summary is not a transcription", () => {
    expect(() => parseDocumentExtraction(JSON.stringify({ ...VALID, text: "" }))).toThrow(
      "didn't match the document extraction contract",
    );
  });

  it("throws on non-scalar field values", () => {
    expect(() =>
      parseDocumentExtraction(
        JSON.stringify({ ...VALID, fields: { parties: { shipper: "Acme" } } }),
      ),
    ).toThrow("didn't match the document extraction contract");
  });
});

describe("extractDocumentText", () => {
  it("sends the image through the vision path and returns the parsed extraction", async () => {
    const seen: AiVisionRequest[] = [];
    const provider: AiVisionProvider = {
      completeWithImage: vi.fn(async (request: AiVisionRequest) => {
        seen.push(request);
        return JSON.stringify(VALID);
      }),
    };

    const result = await extractDocumentText(provider, {
      imageBase64: "aGVsbG8=",
      mediaType: "image/png",
    });

    expect(result.doc_type).toBe("bol");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.imageBase64).toBe("aGVsbG8=");
    expect(seen[0]!.mediaType).toBe("image/png");
    expect(seen[0]!.system).toContain("never guess");
    // The BOL field set is explicit, not left to the model's habits:
    // parties AND their addresses, appointment times, references, seal.
    for (const key of [
      "shipper_address",
      "consignee",
      "consignee_address",
      "pickup_time",
      "delivery_time",
      "reference_number",
    ]) {
      expect(seen[0]!.system).toContain(key);
    }
  });

  it("formats the BOL fields Abel should read back, in a stable order, skipping blanks", () => {
    const lines = formatExtractedFieldsForReply("bol", {
      bol_number: "BOL-88",
      shipper: "Acme Foods",
      shipper_address: "12 Dock Rd, Jacksonville, FL",
      receiver: "Blue Retail DC",
      consignee_address: "900 Peachtree St, Atlanta, GA",
      pieces: 18,
      weight_lbs: 42100,
      seal_number: "SL-004417",
      pickup_time: null,
      commodity: "",
    });
    expect(lines[0]).toBe("BOL details I read:");
    expect(lines.join("\n")).toContain("BOL #: BOL-88");
    expect(lines.join("\n")).toContain("Shipper: Acme Foods — 12 Dock Rd, Jacksonville, FL");
    expect(lines.join("\n")).toContain("Consignee: Blue Retail DC — 900 Peachtree St, Atlanta, GA");
    expect(lines.join("\n")).toContain("Pieces: 18");
    expect(lines.join("\n")).toContain("Weight: 42100 lbs");
    expect(lines.join("\n")).toContain("Seal #: SL-004417");
    expect(lines.join("\n")).not.toContain("Pickup time");
  });

  it("propagates a provider failure to the caller", async () => {
    const provider: AiVisionProvider = {
      completeWithImage: vi.fn(async () => {
        throw new Error("provider is down");
      }),
    };
    await expect(
      extractDocumentText(provider, { imageBase64: "x", mediaType: "image/jpeg" }),
    ).rejects.toThrow("provider is down");
  });
});
