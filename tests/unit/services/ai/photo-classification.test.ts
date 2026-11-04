// Photo intelligence (design §3): the classifier contract -
// parsing, caption routing (the free first beat), and the act/ask
// thresholds config. A misread purpose files a photo wrong, so the
// contract is strict: unknown purposes and out-of-range
// confidences are rejected, never coerced.

import { describe, expect, it } from "vitest";
import {
  parsePhotoClassification,
  purposeFromCaption,
  PHOTO_PURPOSE_THRESHOLDS,
} from "@/services/ai/photo-classification";

describe("parsePhotoClassification", () => {
  it("accepts a full read with fields, per-field confidences, and alternates", () => {
    const parsed = parsePhotoClassification(
      JSON.stringify({
        purpose: "truck_exterior",
        confidence: 0.93,
        headline: "That's the truck — unit 214, Freightliner Cascadia.",
        fields: { unit_number: "214", make: "Freightliner", truck_type: "sleeper" },
        field_confidences: { unit_number: 0.97, make: 0.62 },
        alternates: [{ purpose: "pretrip", confidence: 0.2 }],
      }),
    );
    expect(parsed.purpose).toBe("truck_exterior");
    expect(parsed.fields.unit_number).toBe("214");
    expect(parsed.field_confidences.make).toBe(0.62);
    expect(parsed.alternates).toHaveLength(1);
  });

  it("defaults the optional blocks when the model omits them", () => {
    const parsed = parsePhotoClassification(
      JSON.stringify({ purpose: "other", confidence: 0.4, headline: "A blurry shot." }),
    );
    expect(parsed.fields).toEqual({});
    expect(parsed.field_confidences).toEqual({});
    expect(parsed.alternates).toEqual([]);
  });

  it("rejects an unknown purpose and an out-of-range confidence", () => {
    expect(() =>
      parsePhotoClassification(
        JSON.stringify({ purpose: "selfie", confidence: 0.9, headline: "x" }),
      ),
    ).toThrow(/didn't match/);
    expect(() =>
      parsePhotoClassification(
        JSON.stringify({ purpose: "trailer", confidence: 1.4, headline: "x" }),
      ),
    ).toThrow(/didn't match/);
  });

  it("rejects non-JSON output", () => {
    expect(() => parsePhotoClassification("it looks like a truck")).toThrow(/not valid JSON/);
  });
});

describe("purposeFromCaption — the free first beat (§3.1)", () => {
  it("routes the purposes his captions actually name", () => {
    expect(purposeFromCaption("pre-trip")).toBe("pretrip");
    expect(purposeFromCaption("Pre-Trip walkaround")).toBe("pretrip");
    expect(purposeFromCaption("paper log for Tuesday")).toBe("paper_log");
    expect(purposeFromCaption("log sheet")).toBe("paper_log");
    expect(purposeFromCaption("odometer")).toBe("odometer_dash");
    expect(purposeFromCaption("dash this morning")).toBe("odometer_dash");
    expect(purposeFromCaption("new trailer 5831")).toBe("trailer");
    expect(purposeFromCaption("BOL for Georgia")).toBe("paperwork");
    expect(purposeFromCaption("fuel receipt")).toBe("paperwork");
    expect(purposeFromCaption("the truck")).toBe("truck_exterior");
    expect(purposeFromCaption("door pic")).toBe("truck_exterior");
  });

  it("returns null when the caption names no purpose (vision decides)", () => {
    expect(purposeFromCaption("look at this")).toBeNull();
    expect(purposeFromCaption("")).toBeNull();
    expect(purposeFromCaption(undefined)).toBeNull();
  });

  it("most specific wins: a pre-trip trailer photo is a pre-trip", () => {
    expect(purposeFromCaption("pre-trip on the trailer")).toBe("pretrip");
    expect(purposeFromCaption("paper log in the truck")).toBe("paper_log");
  });
});

describe("PHOTO_PURPOSE_THRESHOLDS — the §3.2 bars", () => {
  it("act at 0.85, ask at 0.55", () => {
    expect(PHOTO_PURPOSE_THRESHOLDS.act).toBe(0.85);
    expect(PHOTO_PURPOSE_THRESHOLDS.ask).toBe(0.55);
  });
});
