// Task 3.13 (TASKS.md). Pure due/overdue computation - the real logic
// worth getting wrong here, per docs/design/testing.md.

import { describe, expect, it } from "vitest";
import { computeDueStatus } from "@/lib/maintenance-schedule";
import type { MaintenanceSchedule } from "@/types/entities";

function schedule(overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule {
  return {
    id: "s1",
    company_id: "c1",
    truck_id: "t1",
    trailer_id: null,
    description: "Oil change",
    interval_miles: null,
    interval_days: null,
    last_done_date: null,
    last_done_mileage: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("computeDueStatus", () => {
  it("is paused when the schedule itself is paused, regardless of interval state", () => {
    const result = computeDueStatus(
      schedule({ status: "paused", interval_miles: 5000, last_done_mileage: 0 }),
      100000,
      "2026-06-01",
    );
    expect(result.status).toBe("paused");
  });

  it("is unknown when the relevant interval has no baseline to compute from", () => {
    // interval_days set but last_done_date never recorded - never done,
    // so "next due" genuinely cannot be computed, not "ok" by default.
    const result = computeDueStatus(schedule({ interval_days: 90 }), null, "2026-06-01");
    expect(result.status).toBe("unknown");
    expect(result.nextDueDate).toBeNull();
  });

  it("is ok well before a date-based interval is due", () => {
    const result = computeDueStatus(
      schedule({ interval_days: 90, last_done_date: "2026-01-01" }),
      null,
      "2026-01-15",
    );
    expect(result.status).toBe("ok");
    expect(result.nextDueDate).toBe("2026-04-01");
  });

  it("is due-soon inside the warning window before a date-based interval", () => {
    const result = computeDueStatus(
      schedule({ interval_days: 90, last_done_date: "2026-01-01" }),
      null,
      "2026-03-25", // 7 days before the 2026-04-01 due date
    );
    expect(result.status).toBe("due-soon");
  });

  it("is overdue once a date-based interval has passed", () => {
    const result = computeDueStatus(
      schedule({ interval_days: 90, last_done_date: "2026-01-01" }),
      null,
      "2026-04-02",
    );
    expect(result.status).toBe("overdue");
  });

  it("is overdue once a mileage-based interval has passed, using the truck's current mileage", () => {
    const result = computeDueStatus(
      schedule({ interval_miles: 15000, last_done_mileage: 100000 }),
      115500,
      "2026-06-01",
    );
    expect(result.status).toBe("overdue");
    expect(result.nextDueMileage).toBe(115000);
  });

  it("is not evaluable by mileage when the truck's current mileage is unknown", () => {
    const result = computeDueStatus(
      schedule({ interval_miles: 15000, last_done_mileage: 100000 }),
      null,
      "2026-06-01",
    );
    expect(result.status).toBe("unknown");
  });

  it("takes the worse of the two when both a date and mileage interval are set", () => {
    // Date says ok (89 days into a 90-day interval), mileage says overdue.
    const result = computeDueStatus(
      schedule({
        interval_days: 90,
        last_done_date: "2026-01-01",
        interval_miles: 15000,
        last_done_mileage: 100000,
      }),
      120000,
      "2026-01-02",
    );
    expect(result.status).toBe("overdue");
  });
});
