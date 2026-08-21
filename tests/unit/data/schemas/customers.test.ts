import { describe, expect, it } from "vitest";
import { createCustomerSchema } from "@/data/schemas/customers";

describe("createCustomerSchema", () => {
  it("accepts a minimal valid customer", () => {
    expect(createCustomerSchema.safeParse({ name: "Acme Freight" }).success).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(createCustomerSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(
      createCustomerSchema.safeParse({ name: "Acme Freight", contact_email: "not-an-email" })
        .success,
    ).toBe(false);
  });
});
