// Telegram fix round (brief fixes 10/11/11A/11B): deterministic
// reference resolution. On 2026-11-09 the model guessed a completed
// load from days earlier when the owner said "load 1874" minutes
// after forwarding trip 1874 - these tests pin the code path that
// now resolves his words BEFORE the model proposes anything:
// index first, then the database; one match = resolved in words;
// two matches = one question, nothing staged; no match = say so,
// never substitute another load.

import { describe, expect, it, vi } from "vitest";
import { extractReferences, resolveReferences } from "@/services/bot/reference-resolution";
import type { BotBrainStore } from "@/services/bot/store";
import type { ThreadEntityRow } from "@/services/bot/store-entities";

type Row = Record<string, unknown>;

const COMPANY = "44444444-4444-4444-8444-444444444444";
const CHAT = "4242";

const LOAD_1874 = {
  company_id: COMPANY,
  id: "11111111-1111-4111-8111-111111111111",
  origin: "Panama City, FL",
  destination: "Seminole, OK",
  status: "confirmed",
  pickup_date: "2026-11-10",
  delivery_date: "2026-11-12",
  trip_number: "1874",
  broker_reference: "5113964",
};

const OLDER_LOAD_1874 = {
  ...LOAD_1874,
  id: "22222222-2222-4222-8222-222222222222",
  origin: "Savannah, GA",
  status: "completed",
  delivery_date: "2026-11-05",
};

interface FakeTables {
  loads?: Row[];
  trailers?: Row[];
  trucks?: Row[];
}

/** Chainable select fake honoring eq() filters - just what resolution runs. */
function fakeClient(tables: FakeTables) {
  return {
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const rows = ((tables as Record<string, Row[] | undefined>)[table] ?? []).filter((row) =>
        filters.every(([col, val]) => row[col] === val),
      );
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        is: () => q,
        ilike: () => q,
        order: () => q,
        limit: () => q,
        then: (onFulfilled?: (v: { data: Row[]; error: null }) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve({ data: rows.filter((row) => filters.every(([col, val]) => row[col] === val)), error: null }).then(onFulfilled, onRejected),
      };
      return q;
    },
  };
}

function fakeStore(tables: FakeTables, entities: ThreadEntityRow[] = []): BotBrainStore {
  return {
    client: fakeClient(tables),
    companyId: COMPANY,
    listThreadEntities: vi.fn().mockResolvedValue(entities),
  } as unknown as BotBrainStore;
}

function entity(partial: Partial<ThreadEntityRow>): ThreadEntityRow {
  return {
    id: "entity-1",
    entityType: "load",
    entityId: null,
    keys: [],
    label: "",
    isCurrent: false,
    lastSeenAt: new Date().toISOString(),
    ...partial,
  };
}

describe("extractReferences", () => {
  it("pulls trip numbers, broker refs, unit numbers, pickup numbers and deictics from his words", () => {
    const refs = extractReferences("attach it to load 1874, ref 5113964, trailer H11887, pickup #94405");
    expect(refs.tripNumbers).toEqual(["1874"]);
    expect(refs.brokerReferences).toEqual(["5113964"]);
    expect(refs.unitNumbers).toEqual(["H11887"]);
    expect(refs.pickupNumbers).toEqual(["94405"]);
    expect(extractReferences("attach it to this load").deictic).toBe(true);
    expect(extractReferences("how is the weather").tripNumbers).toEqual([]);
  });
});

describe("resolveReferences", () => {
  it("resolves trip 1874 to the load on file, in words, with its id", async () => {
    const store = fakeStore({ loads: [LOAD_1874] });
    const outcome = await resolveReferences(store, CHAT, "attach it to load 1874");
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.records[0]?.entityId).toBe(LOAD_1874.id);
    expect(outcome.block).toContain("Trip 1874, Panama City, FL → Seminole, OK");
    expect(outcome.block).toContain("do not browse for a different record");
  });

  it("resolves from the thread index even before the load exists in the database view", async () => {
    const store = fakeStore({ loads: [] }, [
      entity({
        entityType: "load",
        entityId: LOAD_1874.id,
        keys: [{ kind: "trip_number", value: "1874" }],
        label: "Trip 1874, Panama City, FL → Seminole, OK, delivery 2026-11-12",
        isCurrent: true,
      }),
    ]);
    const outcome = await resolveReferences(store, CHAT, "the BOL goes with trip 1874");
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.records[0]?.source).toBe("index");
  });

  it("the SAME load found in index and database is one record, not an ambiguity", async () => {
    const store = fakeStore({ loads: [LOAD_1874] }, [
      entity({
        entityType: "load",
        entityId: LOAD_1874.id,
        keys: [{ kind: "trip_number", value: "1874" }],
        label: "Trip 1874, Panama City, FL → Seminole, OK, delivery 2026-11-12",
      }),
    ]);
    const outcome = await resolveReferences(store, CHAT, "load 1874");
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.records).toHaveLength(1);
  });

  it("two different loads with the same trip number = ONE question naming both, nothing resolved", async () => {
    const store = fakeStore({ loads: [LOAD_1874, OLDER_LOAD_1874] });
    const outcome = await resolveReferences(store, CHAT, "attach it to load 1874");
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.question).toContain("Panama City, FL → Seminole, OK");
    expect(outcome.question).toContain("Savannah, GA");
    expect(outcome.question).toContain("haven't staged anything");
  });

  it("a named trip that exists nowhere = not_found, with the never-substitute instruction", async () => {
    const store = fakeStore({ loads: [] });
    const outcome = await resolveReferences(store, CHAT, "where is load 9999");
    expect(outcome.kind).toBe("not_found");
    if (outcome.kind !== "not_found") return;
    expect(outcome.block).toContain("do NOT pick a different load");
  });

  it("'this load' resolves to the thread's current subject", async () => {
    const store = fakeStore({ loads: [] }, [
      entity({
        entityType: "load",
        entityId: LOAD_1874.id,
        keys: [{ kind: "trip_number", value: "1874" }],
        label: "Trip 1874, Panama City, FL → Seminole, OK, delivery 2026-11-12",
        isCurrent: true,
      }),
    ]);
    const outcome = await resolveReferences(store, CHAT, "attach it to this load");
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.records[0]?.source).toBe("current");
  });

  it("a trailer unit number resolves to the trailer on file", async () => {
    const store = fakeStore({ trailers: [{ company_id: COMPANY, id: "33333333-3333-4333-8333-333333333333", unit_number: "H11887" }] });
    const outcome = await resolveReferences(store, CHAT, "the photo is trailer H11887");
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.records[0]?.entityType).toBe("trailer");
    expect(outcome.records[0]?.label).toContain("H11887");
  });

  it("plain conversation resolves nothing", async () => {
    const store = fakeStore({ loads: [LOAD_1874] });
    const outcome = await resolveReferences(store, CHAT, "how much did I make this week");
    expect(outcome.kind).toBe("none");
  });
});
