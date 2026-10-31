import { describe, expect, it } from "vitest";
import { researchNowSchema } from "@/data/schemas/research";

describe("researchNowSchema", () => {
  it("accepts a real topic and trims it", () => {
    expect(researchNowSchema.parse({ topic: "  factoring costs  " }).topic).toBe("factoring costs");
  });

  it("rejects empty, too-short, and over-long topics", () => {
    expect(researchNowSchema.safeParse({ topic: "" }).success).toBe(false);
    expect(researchNowSchema.safeParse({ topic: "ab" }).success).toBe(false);
    expect(researchNowSchema.safeParse({ topic: "x".repeat(201) }).success).toBe(false);
  });
});
