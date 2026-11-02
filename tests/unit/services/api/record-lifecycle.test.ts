// Reliability Unit A + Unit F acceptance tests for the shared CRUD
// factory (design docs/reliability-wave1-design-package.md A.8 / F.4):
// truthful delete (F-005), idempotent creates (F-006), merged-record
// validation (F-028), safeguarded restore, and the load status
// transitions (F-016) - all against an in-memory fake of the Supabase
// query builder that implements just the semantics the factory uses,
// including the named submission unique index from migration 00041.

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { createCrudRoutes } from "@/services/api/crud-routes";
import {
  isSubmissionIndexViolation,
  payloadFingerprint,
} from "@/services/api/submission";
import { loadTransitionRefusal } from "@/services/api/load-transitions";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";
import {
  createPretripInspectionSchema,
  updatePretripInspectionSchema,
} from "@/data/schemas/pretrip-inspections";
import { createLoadSchema, updateLoadSchema } from "@/data/schemas/loads";
import type { Load, PretripInspection, Truck } from "@/types/entities";

// ---------------------------------------------------------------------------
// In-memory fake of the Supabase query builder.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Filter {
  kind: "eq" | "isnull" | "notnull";
  col: string;
  val?: unknown;
}

function makeFakeDb(seed: Record<string, Row[]>) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((r) => ({ ...r }))]),
  );
  let idCounter = 0;

  function builder(table: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};

    const matches = (row: Row) =>
      filters.every((f) =>
        f.kind === "eq" ? row[f.col] === f.val : f.kind === "isnull" ? row[f.col] == null : row[f.col] != null,
      );

    const execSingle = () => {
      const rows = tables.get(table) ?? [];
      if (mode === "insert") {
        // The named partial unique index of migration 00041.
        if (payload.submission_id != null) {
          const clash = rows.some(
            (r) => r.company_id === payload.company_id && r.submission_id === payload.submission_id,
          );
          if (clash) {
            return {
              data: null,
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint "${table}_submission_idempotency"`,
                details: "Key (company_id, submission_id) already exists.",
              },
            };
          }
        }
        const row: Row = { id: `row-${++idCounter}`, deleted_at: null, ...payload };
        rows.push(row);
        tables.set(table, rows);
        return { data: { ...row }, error: null };
      }
      if (mode === "update") {
        const matched = rows.filter(matches);
        matched.forEach((r) => Object.assign(r, payload));
        return { data: matched[0] ? { ...matched[0] } : null, error: null };
      }
      const matched = rows.filter(matches);
      return { data: matched[0] ? { ...matched[0] } : null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (obj: Row) => {
        mode = "insert";
        payload = obj;
        return b;
      },
      update: (obj: Row) => {
        mode = "update";
        payload = obj;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push(
          val === null ? { kind: "isnull", col } : { kind: "eq", col, val },
        );
        return b;
      },
      not: (col: string, _op: string, val: unknown) => {
        filters.push(val === null ? { kind: "notnull", col } : { kind: "eq", col, val });
        return b;
      },
      order: () => b,
      range: () => b,
      single: async () => execSingle(),
      maybeSingle: async () => execSingle(),
      then: (resolve: (v: unknown) => void) => {
        const rows = tables.get(table) ?? [];
        if (mode === "update") {
          const matched = rows.filter(matches);
          matched.forEach((r) => Object.assign(r, payload));
          resolve({ data: matched.map((r) => ({ ...r })), error: null });
          return;
        }
        const matched = rows.filter(matches);
        resolve({
          data: matched.map((r) => ({ ...r })),
          count: matched.length,
          error: null,
        });
      },
    };
    return b;
  }

  return {
    client: { from: (table: string) => builder(table) },
    tables,
  };
}

function useDb(seed: Record<string, Row[]>) {
  const db = makeFakeDb(seed);
  vi.mocked(createClient).mockResolvedValue(db.client as never);
  return db;
}

const CTX = { params: Promise.resolve({ id: "x" }) };
function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const truckRoutes = () =>
  createCrudRoutes<Truck>("trucks", { create: createTruckSchema, update: updateTruckSchema });

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

// ---------------------------------------------------------------------------

describe("truthful delete (F-005 / A.8.2)", () => {
  it("DELETE of a real row is 204; the same DELETE again is 404; a nonexistent id is 404", async () => {
    useDb({ trucks: [{ id: "t1", company_id: "company-1", unit_number: "12", deleted_at: null }] });
    const routes = truckRoutes();

    const first = await routes.remove(jsonReq("http://x/api/v1/trucks/t1", "DELETE"), ctxFor("t1"));
    expect(first.status).toBe(204);

    const second = await routes.remove(jsonReq("http://x/api/v1/trucks/t1", "DELETE"), ctxFor("t1"));
    expect(second.status).toBe(404);

    const missing = await routes.remove(jsonReq("http://x/api/v1/trucks/nope", "DELETE"), ctxFor("nope"));
    expect(missing.status).toBe(404);
  });
});

describe("delete / restore round trip (A.8.1)", () => {
  it("create -> delete -> hidden from list, present in Deleted view -> restore -> visible again", async () => {
    const db = useDb({ trucks: [] });
    const routes = truckRoutes();

    const created = await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { unit_number: "12", status: "active" }),
    );
    expect(created.status).toBe(201);
    const row = await created.json();

    const removed = await routes.remove(
      jsonReq(`http://x/api/v1/trucks/${row.id}`, "DELETE"),
      ctxFor(row.id),
    );
    expect(removed.status).toBe(204);

    const list = await (await routes.list(new NextRequest("http://x/api/v1/trucks"))).json();
    expect(list.data).toHaveLength(0);

    const deletedList = await (
      await routes.list(new NextRequest("http://x/api/v1/trucks?deleted=only"))
    ).json();
    expect(deletedList.data).toHaveLength(1);
    expect(deletedList.data[0].id).toBe(row.id);

    const restored = await routes.restore(
      jsonReq(`http://x/api/v1/trucks/${row.id}/restore`, "POST"),
      ctxFor(row.id),
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).deleted_at).toBeNull();
    expect(db.tables.get("trucks")![0]!.deleted_at).toBeNull();

    const listAgain = await (await routes.list(new NextRequest("http://x/api/v1/trucks"))).json();
    expect(listAgain.data).toHaveLength(1);
  });

  it("restore of a record that is not deleted answers 200 with its current state; restore of a missing record is 404", async () => {
    useDb({ trucks: [{ id: "t1", company_id: "company-1", unit_number: "12", status: "active", deleted_at: null }] });
    const routes = truckRoutes();

    const res = await routes.restore(jsonReq("http://x/api/v1/trucks/t1/restore", "POST"), ctxFor("t1"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("t1");

    const missing = await routes.restore(
      jsonReq("http://x/api/v1/trucks/nope/restore", "POST"),
      ctxFor("nope"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("idempotent creates (F-006 / A.8.3, A.8.4)", () => {
  it("same token + same payload replays (200, deduplicated, one row); the deduped response identifies the record", async () => {
    const db = useDb({ trucks: [] });
    const routes = truckRoutes();
    const payload = { submission_id: TOKEN, unit_number: "12", status: "active" };

    const first = await routes.create(jsonReq("http://x/api/v1/trucks", "POST", payload));
    expect(first.status).toBe(201);
    const firstRow = await first.json();

    const replay = await routes.create(jsonReq("http://x/api/v1/trucks", "POST", payload));
    expect(replay.status).toBe(200);
    const replayRow = await replay.json();
    expect(replayRow.deduplicated).toBe(true);
    expect(replayRow.id).toBe(firstRow.id);
    expect(db.tables.get("trucks")).toHaveLength(1);
  });

  it("same token + different payload is a 409 with the design's error code, and creates nothing", async () => {
    const db = useDb({ trucks: [] });
    const routes = truckRoutes();

    const first = await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { submission_id: TOKEN, unit_number: "12", status: "active" }),
    );
    expect(first.status).toBe(201);

    const conflict = await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { submission_id: TOKEN, unit_number: "99", status: "active" }),
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe(
      "submission_token_reused_with_different_payload",
    );
    expect(db.tables.get("trucks")).toHaveLength(1);
    expect(db.tables.get("trucks")![0]!.unit_number).toBe("12");
  });

  it("a genuinely new record with identical field values but a NEW token creates a second row (no fuzzy dedup)", async () => {
    const db = useDb({ trucks: [] });
    const routes = truckRoutes();
    const otherToken = "123e4567-e89b-42d3-a456-426614174999";

    await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { submission_id: TOKEN, unit_number: "12", status: "active" }),
    );
    const second = await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { submission_id: otherToken, unit_number: "12", status: "active" }),
    );
    expect(second.status).toBe(201);
    expect(db.tables.get("trucks")).toHaveLength(2);
  });

  it("creates without a token behave exactly as before (no dedup)", async () => {
    const db = useDb({ trucks: [] });
    const routes = truckRoutes();
    await routes.create(jsonReq("http://x/api/v1/trucks", "POST", { unit_number: "12", status: "active" }));
    await routes.create(jsonReq("http://x/api/v1/trucks", "POST", { unit_number: "12", status: "active" }));
    expect(db.tables.get("trucks")).toHaveLength(2);
  });

  it("a malformed submission_id is a 400", async () => {
    useDb({ trucks: [] });
    const routes = truckRoutes();
    const res = await routes.create(
      jsonReq("http://x/api/v1/trucks", "POST", { submission_id: "not-a-uuid", unit_number: "12" }),
    );
    expect(res.status).toBe(400);
  });

  it("only the NAMED idempotency constraint enters the dedup path", () => {
    expect(
      isSubmissionIndexViolation(
        { code: "23505", message: 'duplicate key value violates unique constraint "trucks_submission_idempotency"' },
        "trucks",
      ),
    ).toBe(true);
    expect(
      isSubmissionIndexViolation(
        { code: "23505", message: 'duplicate key value violates unique constraint "trucks_pkey"' },
        "trucks",
      ),
    ).toBe(false);
    expect(
      isSubmissionIndexViolation({ code: "23503", message: "foreign key violation" }, "trucks"),
    ).toBe(false);
  });

  it("fingerprints are key-order insensitive and payload-sensitive", () => {
    expect(payloadFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(
      payloadFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
  });
});

describe("merged-record validation (F-028 / F.4)", () => {
  it("loads: a PATCH moving delivery before pickup is a 422 naming the date rule; the row is untouched", async () => {
    const db = useDb({
      loads: [
        {
          id: "l1",
          company_id: "company-1",
          origin: "A",
          destination: "B",
          pickup_date: "2026-02-10",
          delivery_date: "2026-02-12",
          status: "draft",
          deleted_at: null,
        },
      ],
    });
    const routes = createCrudRoutes<Load>("loads", {
      create: createLoadSchema,
      update: updateLoadSchema,
    });

    const res = await routes.update(
      jsonReq("http://x/api/v1/loads/l1", "PATCH", { delivery_date: "2026-02-01" }),
      ctxFor("l1"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body.error.fields)).toContain("delivery_date must not be before pickup_date");
    expect(db.tables.get("loads")![0]!.delivery_date).toBe("2026-02-12");
  });

  it("pretrip: a legacy row violating the vehicle rule blocks unrelated PATCHes with a 422 naming the rule, and supplying the missing vehicle in the PATCH unblocks it", async () => {
    const db = useDb({
      pretrip_inspections: [
        {
          id: "p1",
          company_id: "company-1",
          truck_id: null,
          trailer_id: null,
          driver_id: null,
          inspected_at: "2026-01-01T00:00:00Z",
          passed: true,
          defects_found: null,
          deleted_at: null,
        },
      ],
    });
    const routes = createCrudRoutes<PretripInspection>("pretrip_inspections", {
      create: createPretripInspectionSchema,
      update: updatePretripInspectionSchema,
    });

    const blocked = await routes.update(
      jsonReq("http://x/api/v1/pretrip-inspections/p1", "PATCH", { defects_found: "cracked mirror" }),
      ctxFor("p1"),
    );
    expect(blocked.status).toBe(422);
    expect(JSON.stringify((await blocked.json()).error.fields)).toContain(
      "exactly one of truck_id or trailer_id is required",
    );
    expect(db.tables.get("pretrip_inspections")![0]!.defects_found).toBeNull();

    const fixed = await routes.update(
      jsonReq("http://x/api/v1/pretrip-inspections/p1", "PATCH", {
        truck_id: "123e4567-e89b-42d3-a456-426614174001",
        defects_found: "cracked mirror",
      }),
      ctxFor("p1"),
    );
    expect(fixed.status).toBe(200);
    expect(db.tables.get("pretrip_inspections")![0]!.defects_found).toBe("cracked mirror");
  });

  it("a legitimately partial record (only required fields set) still PATCHes fine - merged validation demands nothing beyond the create schema", async () => {
    useDb({
      trucks: [
        {
          id: "t1",
          company_id: "company-1",
          unit_number: "12",
          vin: null,
          make: null,
          model: null,
          year: null,
          status: "active",
          current_mileage: null,
          deleted_at: null,
        },
      ],
    });
    const routes = truckRoutes();
    const res = await routes.update(
      jsonReq("http://x/api/v1/trucks/t1", "PATCH", { unit_number: "13" }),
      ctxFor("t1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).unit_number).toBe("13");
  });

  it("PATCH of a missing record is a 404 before any validation detail", async () => {
    useDb({ trucks: [] });
    const routes = truckRoutes();
    const res = await routes.update(
      jsonReq("http://x/api/v1/trucks/nope", "PATCH", { unit_number: "13" }),
      ctxFor("nope"),
    );
    expect(res.status).toBe(404);
  });
});

describe("safeguarded restore (A.4 / A.8.5)", () => {
  it("restore under a deleted parent is refused with a named 422; restoring the parent first unblocks it; restore never cascades", async () => {
    const DRIVER_ID = "123e4567-e89b-42d3-a456-426614174010";
    const db = useDb({
      drivers: [
        { id: DRIVER_ID, company_id: "company-1", name: "Sam", status: "active", deleted_at: "2026-01-02T00:00:00Z" },
      ],
      duty_logs: [
        {
          id: "log1",
          company_id: "company-1",
          driver_id: DRIVER_ID,
          load_id: null,
          duty_status: "driving",
          started_at: "2026-01-01T00:00:00Z",
          deleted_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const { createDutyLogSchema, updateDutyLogSchema } = await import("@/data/schemas/duty-logs");
    const { createDriverSchema, updateDriverSchema } = await import("@/data/schemas/drivers");
    const logRoutes = createCrudRoutes("duty_logs", {
      create: createDutyLogSchema,
      update: updateDutyLogSchema,
    });
    const driverRoutes = createCrudRoutes("drivers", {
      create: createDriverSchema,
      update: updateDriverSchema,
    });

    const refused = await logRoutes.restore(
      jsonReq("http://x/api/v1/duty-logs/log1/restore", "POST"),
      ctxFor("log1"),
    );
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.message).toContain("driver");
    expect(db.tables.get("duty_logs")![0]!.deleted_at).not.toBeNull();

    const parentRestored = await driverRoutes.restore(
      jsonReq(`http://x/api/v1/drivers/${DRIVER_ID}/restore`, "POST"),
      ctxFor(DRIVER_ID),
    );
    expect(parentRestored.status).toBe(200);

    const nowOk = await logRoutes.restore(
      jsonReq("http://x/api/v1/duty-logs/log1/restore", "POST"),
      ctxFor("log1"),
    );
    expect(nowOk.status).toBe(200);
    expect((await nowOk.json()).deleted_at).toBeNull();
  });
});

describe("load status transitions (F-016)", () => {
  const loadRoutes = () =>
    createCrudRoutes<Load>(
      "loads",
      { create: createLoadSchema, update: updateLoadSchema },
      {
        validateMerged: (merged, existing) => loadTransitionRefusal(merged, existing),
      },
    );

  const seedLoad = (overrides: Row = {}) => ({
    loads: [
      {
        id: "l1",
        company_id: "company-1",
        origin: "A",
        destination: "B",
        pickup_date: null,
        delivery_date: null,
        rate_cents: null,
        status: "draft",
        deleted_at: null,
        ...overrides,
      },
    ],
  });

  it("confirming a draft missing rate/dates is a 422 naming the missing fields", async () => {
    useDb(seedLoad());
    const res = await loadRoutes().update(
      jsonReq("http://x/api/v1/loads/l1", "PATCH", { status: "confirmed" }),
      ctxFor("l1"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    const paths = (body.error.fields as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["rate_cents", "pickup_date", "delivery_date"]));
  });

  it("confirming succeeds when the same PATCH supplies the missing fields", async () => {
    useDb(seedLoad());
    const res = await loadRoutes().update(
      jsonReq("http://x/api/v1/loads/l1", "PATCH", {
        status: "confirmed",
        rate_cents: 250000,
        pickup_date: "2026-03-01",
        delivery_date: "2026-03-03",
      }),
      ctxFor("l1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("confirmed");
  });

  it("completing without a delivery date is a 422; cancelling is a status, not a delete", async () => {
    const db = useDb(seedLoad({ status: "confirmed", rate_cents: 100, pickup_date: "2026-03-01" }));
    const routes = loadRoutes();

    const complete = await routes.update(
      jsonReq("http://x/api/v1/loads/l1", "PATCH", { status: "completed" }),
      ctxFor("l1"),
    );
    expect(complete.status).toBe(422);

    const cancel = await routes.update(
      jsonReq("http://x/api/v1/loads/l1", "PATCH", { status: "cancelled" }),
      ctxFor("l1"),
    );
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).status).toBe("cancelled");
    expect(db.tables.get("loads")![0]!.deleted_at).toBeNull();
  });
});
