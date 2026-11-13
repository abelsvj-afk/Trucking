// Content-derived document names (Telegram review D8, 2026-11-12).
import { describe, expect, it } from "vitest";
import { displayFileName, documentDisplayName, isRawPhotoFileName } from "@/services/documents/document-naming";

describe("documentDisplayName", () => {
  it("names a BOL from its kind + trip + vision detail", () => {
    expect(documentDisplayName({ docType: "bol", summary: "BILL OF LADING, seal SL-004417", caption: "Bol for trip 1874" })).toBe(
      "Trip 1874 — BOL (seal photo)",
    );
    expect(documentDisplayName({ docType: "bol", summary: "A side view of a trailer H1181" })).toBe("BOL (trailer H1181 side view)");
    expect(documentDisplayName({ docType: "fuel_receipt", summary: "Pilot $412.10" })).toBe("Fuel receipt");
  });

  it("a caption can name the kind when extraction did not", () => {
    expect(documentDisplayName({ docType: null, summary: null, caption: "Bol for trip 1874" })).toBe("Trip 1874 — BOL");
  });

  it("a genuinely unknown kind has no name - the caller asks once instead", () => {
    expect(documentDisplayName({ docType: "other", summary: "A close-up of a trailer seal" })).toBeNull();
    expect(documentDisplayName({ docType: null, summary: null, caption: null })).toBeNull();
    // A trip number alone is not a kind.
    expect(documentDisplayName({ docType: null, summary: "trip 1874 paperwork", caption: null })).toBeNull();
  });

  it("never invents a detail that is not in the read", () => {
    expect(documentDisplayName({ docType: "bol", summary: "BILL OF LADING" })).toBe("BOL");
  });
});

describe("displayFileName", () => {
  it("a raw storage key shows its kind or 'photo', never the key", () => {
    expect(isRawPhotoFileName("telegram-photo-20261111215931.jpg")).toBe(true);
    expect(displayFileName("telegram-photo-20261111215931.jpg", "bol")).toBe("BOL");
    expect(displayFileName("telegram-photo-20261111215931.jpg", null)).toBe("photo");
    expect(displayFileName("telegram-photo-20261111215931.jpg")).toBe("photo");
  });

  it("an already-human name passes through", () => {
    expect(displayFileName("Trip 1874 — BOL.jpg", "bol")).toBe("Trip 1874 — BOL.jpg");
  });
});
