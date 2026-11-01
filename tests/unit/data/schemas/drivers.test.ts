import { describe, expect, it } from "vitest";
import { createDriverSchema } from "@/data/schemas/drivers";

describe("createDriverSchema", () => {
  it("accepts a minimal valid driver", () => {
    expect(createDriverSchema.safeParse({ name: "Jane Doe" }).success).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(createDriverSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an explicit null assigned_truck_id (unassigned)", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", assigned_truck_id: null }).success,
    ).toBe(true);
  });

  it("rejects a non-UUID assigned_truck_id", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", assigned_truck_id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

// UI/UX upgrade (migration 00027): the complete driver profile.
describe("createDriverSchema (UI/UX upgrade fields)", () => {
  it("accepts a full profile", () => {
    const result = createDriverSchema.safeParse({
      name: "Jane Doe",
      phone: "904-555-0100",
      role: "owner_operator",
      cdl_number: "S1234567",
      cdl_expires_on: "2028-05-01",
      photo_document_id: "00000000-0000-4000-8000-000000000002",
    });
    expect(result.success).toBe(true);
  });

  it("accepts every role in the closed set", () => {
    for (const role of ["owner_operator", "company_driver", "contract_driver", "other"]) {
      expect(createDriverSchema.safeParse({ name: "Jane Doe", role }).success).toBe(true);
    }
  });

  it("rejects a role outside the closed set", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", role: "owner op" }).success,
    ).toBe(false);
  });

  it("rejects an over-long phone and a non-UUID photo_document_id", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", phone: "1".repeat(41) }).success,
    ).toBe(false);
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", photo_document_id: "photo-1" }).success,
    ).toBe(false);
  });

  it("accepts an explicit null photo_document_id (photo removed)", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", photo_document_id: null }).success,
    ).toBe(true);
  });
});
