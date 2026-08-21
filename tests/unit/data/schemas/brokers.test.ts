import { describe, expect, it } from "vitest";
import { createBrokerSchema } from "@/data/schemas/brokers";

describe("createBrokerSchema", () => {
  it("accepts a minimal valid broker", () => {
    expect(createBrokerSchema.safeParse({ name: "Best Brokerage" }).success).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(createBrokerSchema.safeParse({}).success).toBe(false);
  });
});
