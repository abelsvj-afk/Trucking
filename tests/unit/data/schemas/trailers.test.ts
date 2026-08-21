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
