import { describe, expect, it } from "vitest";
import { EMPTY_DRIVER_PROFILE, driverProfileToPayload, driverProfileFromDriver } from "@/components/DriverProfileFields";
import { RESTORE_PARENTS } from "@/services/api/entity-registry";
import { createDriverSchema } from "@/data/schemas/drivers";
import { createLoadSchema } from "@/data/schemas/loads";

describe("trailer assignment (migration 00066)", () => {
  it("an untouched profile never sends the trailer column (safe before the migration is applied)", () => {
    expect(driverProfileToPayload({ ...EMPTY_DRIVER_PROFILE, name: "A" })).not.toHaveProperty("assigned_trailer_id");
  });
  it("choosing a trailer sends it; choosing 'Unassigned' after having one sends null", () => {
    const T = "11111111-1111-4111-8111-111111111111";
    expect(driverProfileToPayload({ ...EMPTY_DRIVER_PROFILE, name: "A", assignedTrailerId: T, trailerChanged: true })).toMatchObject({ assigned_trailer_id: T });
    expect(driverProfileToPayload({ ...EMPTY_DRIVER_PROFILE, name: "A", assignedTrailerId: "", trailerChanged: true })).toMatchObject({ assigned_trailer_id: null });
  });
  it("an existing driver's trailer loads into the form", () => {
    const v = driverProfileFromDriver({ id: "d", name: "A", assigned_trailer_id: "t1", status: "active" } as never);
    expect(v.assignedTrailerId).toBe("t1");
  });
  it("schemas accept a trailer uuid (or null) on drivers and loads", () => {
    const T = "11111111-1111-4111-8111-111111111111";
    expect(createDriverSchema.safeParse({ name: "A", assigned_trailer_id: T }).success).toBe(true);
    expect(createDriverSchema.safeParse({ name: "A", assigned_trailer_id: "not-a-uuid" }).success).toBe(false);
    expect(createLoadSchema.safeParse({ origin: "A", destination: "B", trailer_id: T }).success).toBe(true);
    expect(createLoadSchema.safeParse({ origin: "A", destination: "B", trailer_id: null }).success).toBe(true);
  });
  it("restore checks the trailer parent (a deleted trailer blocks restoring a load/driver that points at it)", () => {
    expect(RESTORE_PARENTS.loads!.some((p) => p.field === "trailer_id")).toBe(true);
    expect(RESTORE_PARENTS.drivers!.some((p) => p.field === "assigned_trailer_id")).toBe(true);
  });
});
