import { describe, expect, it } from "vitest";
import {
  TRUCK_TYPE_OPTIONS,
  truckTypeLabel,
  driverRoleLabel,
  formatMileage,
} from "@/lib/fleet-display";

describe("truckTypeLabel", () => {
  it("maps every picklist value to its label", () => {
    for (const option of TRUCK_TYPE_OPTIONS) {
      expect(truckTypeLabel(option.value)).toBe(option.label);
    }
  });

  it("passes free text (the Other case) through unchanged", () => {
    expect(truckTypeLabel("Yard dog")).toBe("Yard dog");
  });

  it("returns null for missing types", () => {
    expect(truckTypeLabel(null)).toBeNull();
    expect(truckTypeLabel(undefined)).toBeNull();
    expect(truckTypeLabel("")).toBeNull();
  });
});

describe("driverRoleLabel", () => {
  it("maps the closed role set", () => {
    expect(driverRoleLabel("owner_operator")).toBe("Owner-operator");
    expect(driverRoleLabel("company_driver")).toBe("Company driver");
    expect(driverRoleLabel("contract_driver")).toBe("Contract driver");
    expect(driverRoleLabel("other")).toBe("Other");
  });

  it("returns null for a missing role", () => {
    expect(driverRoleLabel(null)).toBeNull();
    expect(driverRoleLabel(undefined)).toBeNull();
  });
});

describe("formatMileage", () => {
  it("formats with thousands separators and a unit", () => {
    expect(formatMileage(12400)).toBe("12,400 mi");
    expect(formatMileage(0)).toBe("0 mi");
  });

  it("returns null for missing mileage", () => {
    expect(formatMileage(null)).toBeNull();
    expect(formatMileage(undefined)).toBeNull();
  });
});
