import { describe, expect, it } from "vitest";
import { createTrailerSchema } from "@/data/schemas/trailers";

describe("createTrailerSchema", () => {
  it("accepts a minimal valid trailer", () => {
    expect(createTrailerSchema.safeParse({ unit_number: "Trailer #1" }).success).toBe(true);
  });

  it("rejects a missing unit_number", () => {
    expect(createTrailerSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    expect(
      createTrailerSchema.safeParse({ unit_number: "Trailer #1", status: "lost" }).success,
    ).toBe(false);
  });
});

// UI/UX upgrade (migration 00027): trailer photo pointer.
describe("createTrailerSchema (UI/UX upgrade fields)", () => {
  it("accepts a trailer photo pointer", () => {
    expect(
      createTrailerSchema.safeParse({
        unit_number: "Trailer #1",
        photo_document_id: "00000000-0000-4000-8000-000000000003",
      }).success,
    ).toBe(true);
  });

  it("accepts an explicit null photo_document_id", () => {
    expect(
      createTrailerSchema.safeParse({ unit_number: "Trailer #1", photo_document_id: null }).success,
    ).toBe(true);
  });

  it("rejects a non-UUID photo_document_id", () => {
    expect(
      createTrailerSchema.safeParse({ unit_number: "Trailer #1", photo_document_id: "pic" })
        .success,
    ).toBe(false);
  });
});
