// Gaming System service layer (docs/design/gaming-system.md
// §§4.1/5.5/7) against an in-memory fake Supabase client (harness
// pattern in the repo's bot tests): governance outcomes are logged
// and nothing is stored; the honesty fence fails loud; an invalid
// game is stored as invalid_rules AND replaced by the nearest
// valid plan; a what-if never touches the current plan until the
// explicit promote; the monthly checkpoint closes once and digests
// once.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiProvider } from "@/services/ai/provider";
import { closeMonthlyCheckpoint } from "@/services/game/checkpoint";
import { promoteWhatIf, runGamePlan } from "@/services/game/run-game-plan";
import { gamePlan as runEngine, buildAssumptions } from "@/lib/game-plan";
import type { GameSnapshot } from "@/lib/game-plan";

const COMPANY = "company-1";
type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    switch (f.op) {
      case "eq":
        return value === f.val;
      case "is":
        return f.val === null ? value === null || value === undefined : value === f.val;
      case "gte":
        return String(value) >= String(f.val);
      case "lte":
        return String(value) <= String(f.val);
      case "lt":
        return String(value) < String(f.val);
      case "in":
        return Array.isArray(f.val) && f.val.includes(value);
      default:
        return true;
    }
  });
}

let idSeq = 0;

class FakeQuery {
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantCount = false;

  constructor(
    private db: Record<string, Row[]>,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: "is", col, val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push({ op: "lte", col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: "lt", col, val });
    return this;
  }
  in(col: string, val: unknown) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private rows(): Row[] {
    let out = (this.db[this.table] ?? []).filter((r) => matches(r, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      out = [...out].sort((a, b) => {
        const cmp = String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    return out;
  }

  private execute(): { data: unknown; error: { message: string } | null; count?: number } {
    if (this.mode === "insert") {
      const now = new Date().toISOString();
      const row: Row = {
        id: `row-${++idSeq}`,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        ...this.payload,
      };
      (this.db[this.table] ??= []).push(row);
      return { data: row, error: null };
    }
    if (this.mode === "update") {
      const updated: Row[] = [];
      for (const row of this.db[this.table] ?? []) {
        if (matches(row, this.filters)) {
          Object.assign(row, this.payload);
          updated.push(row);
        }
      }
      // PostgREST: update().select() returns the updated rows; a
      // bare awaited update ignores data either way.
      return { data: updated, error: null };
    }
    const rows = this.rows();
    if (this.wantCount) return { data: null, error: null, count: rows.length };
    return { data: rows, error: null };
  }

  async single() {
    const result = this.execute();
    if (!Array.isArray(result.data)) return { data: result.data, error: null };
    const rows = result.data as Row[];
    if (rows.length !== 1) return { data: null, error: { message: "expected one row" } };
    return { data: rows[0], error: null };
  }

  async maybeSingle() {
    const result = this.execute();
    const rows = result.data as Row[];
    return { data: rows[0] ?? null, error: null };
  }

  then<T>(resolve: (value: { data: unknown; error: { message: string } | null; count?: number }) => T) {
    return resolve(this.execute());
  }
}

function fakeClient(db: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(db, table),
  } as unknown as SupabaseClient;
}

function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const GOOD_NARRATION = JSON.stringify({
  narration:
    "Your plan is a projection built from your settled loads. The recommended path is the conservative one. Next action: keep the sweep going.",
});

function providerReturning(text: string): AiProvider {
  return { complete: async () => text };
}

/** A company with the capability ON, an active target, and real history. */
function seededDb(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  const loads: Row[] = Array.from({ length: 8 }, (_, i) => ({
    id: `load-${i}`,
    company_id: COMPANY,
    status: "completed",
    rate_cents: 300_000,
    pickup_date: daysAgoDate(7 * (i + 1)),
    delivery_date: daysAgoDate(7 * (i + 1)),
    deleted_at: null,
  }));
  return {
    companies: [{ id: COMPANY, ai_globally_disabled: false }],
    ai_capability_settings: [{ company_id: COMPANY, capability: "game_plan", enabled: true }],
    game_targets: [
      {
        id: "target-1",
        company_id: COMPANY,
        metric: "monthly_net_cents",
        target_value_cents: 1_000_000,
        target_date: futureDate(90),
        posture: "conservative",
        posture_mix_pct: 0,
        notes: null,
        is_active: true,
        deleted_at: null,
        created_at: new Date().toISOString(),
      },
    ],
    fund_settings: [
      {
        company_id: COMPANY,
        sweep_mode: "percent",
        sweep_percent: 50,
        target_band: null,
        target_cents: 2_000_000,
        deleted_at: null,
      },
    ],
    fund_entries: [
      { company_id: COMPANY, fund_key: "emergency_fund", kind: "deposit", amount_cents: 1_200_000, entry_date: daysAgoDate(3), source: "manual", deleted_at: null },
      { company_id: COMPANY, fund_key: "truck_fund", kind: "deposit", amount_cents: 100_000, entry_date: daysAgoDate(3), source: "sweep", deleted_at: null },
    ],
    loads,
    expenses: [],
    fuel_purchases: [],
    maintenance_events: [],
    duty_logs: [],
    research_briefings: [],
    bot_memories: [],
    account_snapshots: [],
    pretrip_inspections: [],
    game_plans: [],
    game_plan_runs: [],
    game_checkpoints: [],
    ...overrides,
  };
}

describe("runGamePlan governance (§4.1)", () => {
  it("returns no_target and logs nothing when no target exists", async () => {
    const db = seededDb({ game_targets: [] });
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(outcome.status).toBe("no_target");
    expect(db.game_plan_runs).toHaveLength(0);
  });

  it("skips visibly when the capability is off - run logged, no plan stored", async () => {
    const db = seededDb({ ai_capability_settings: [] });
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(outcome.status).toBe("skipped_disabled");
    expect(db.game_plans).toHaveLength(0);
    expect(db.game_plan_runs).toHaveLength(1);
    expect(db.game_plan_runs![0]!.status).toBe("skipped_disabled");
  });

  it("skips at the daily cap of counted re-games", async () => {
    const runs: Row[] = Array.from({ length: 4 }, (_, i) => ({
      id: `run-${i}`,
      company_id: COMPANY,
      target_id: "target-1",
      trigger: "manual",
      status: "success",
      plan_id: null,
      detail: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    }));
    const db = seededDb({ game_plan_runs: runs });
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(outcome.status).toBe("skipped_cap");
    expect(db.game_plans).toHaveLength(0);
    expect(db.game_plan_runs).toHaveLength(5);
    expect(db.game_plan_runs![4]!.status).toBe("skipped_cap");
  });
});

describe("runGamePlan happy path and honesty fence (§5)", () => {
  it("stores a current plan with the provider's narration and logs success", async () => {
    const db = seededDb();
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.plan.version).toBe(1);
    expect(outcome.plan.status).toBe("current");
    expect(outcome.plan.narration).toContain("projection");
    expect(db.game_plans).toHaveLength(1);
    expect(db.game_plan_runs![0]!.status).toBe("success");
  });

  it("fails loud and stores nothing when the narration invents a figure - twice", async () => {
    const db = seededDb();
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(JSON.stringify({ narration: "You will have $99,999 in the bank soon." })),
      trigger: "manual",
    });
    expect(outcome.status).toBe("failure");
    expect(db.game_plans).toHaveLength(0);
    expect(db.game_plan_runs![0]!.status).toBe("failure");
  });

  it("fails loud when the narration uses banned promise language", async () => {
    const db = seededDb();
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(JSON.stringify({ narration: "This plan is guaranteed to get you the truck." })),
      trigger: "manual",
    });
    expect(outcome.status).toBe("failure");
    expect(db.game_plans).toHaveLength(0);
  });
});

describe("runGamePlan validity fence (§5.5)", () => {
  it("stores the invalid game AND the nearest valid plan when financing breaks the cushion rule", async () => {
    const db = seededDb({
      fund_settings: [
        {
          company_id: COMPANY,
          sweep_mode: "percent",
          sweep_percent: 90,
          target_band: null,
          target_cents: 2_000_000,
          deleted_at: null,
        },
      ],
      fund_entries: [
        { company_id: COMPANY, fund_key: "emergency_fund", kind: "deposit", amount_cents: 500_000, entry_date: daysAgoDate(3), source: "manual", deleted_at: null },
      ],
      bot_memories: [
        {
          id: "mem-fin",
          company_id: COMPANY,
          kind: "game_assumption",
          content: JSON.stringify({ key: "truck_financing_cents", value: 1_000_000 }),
          created_at: new Date().toISOString(),
          deleted_at: null,
        },
      ],
    });
    const outcome = await runGamePlan({
      client: fakeClient(db),
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(outcome.status).toBe("invalid_replaced");
    const plans = db.game_plans!;
    expect(plans.map((p) => p.status).sort()).toEqual(["current", "invalid_rules"]);
    const current = plans.find((p) => p.status === "current")!;
    const scenarios = current.scenarios as { validity: { valid: boolean }; removedForValidity: string[] };
    expect(scenarios.validity.valid).toBe(true);
    expect(scenarios.removedForValidity.join(" ")).toContain("truck financing");
    expect(db.game_plan_runs![0]!.status).toBe("invalid_replaced");
  });
});

describe("what-ifs and promotion (§§2.3/7)", () => {
  it("stores a what-if without touching the current plan; promotion is explicit", async () => {
    const db = seededDb();
    const client = fakeClient(db);
    const first = await runGamePlan({
      client,
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "manual",
    });
    expect(first.status).toBe("success");

    const whatIf = await runGamePlan({
      client,
      companyId: COMPANY,
      provider: providerReturning(GOOD_NARRATION),
      trigger: "what_if",
      oneOffOverrides: { sweep_pct: 10 },
    });
    expect(whatIf.status).toBe("success");
    if (whatIf.status !== "success") return;
    expect(whatIf.plan.status).toBe("what_if");

    const plans = db.game_plans!;
    expect(plans.find((p) => p.version === 1)!.status).toBe("current");
    expect(plans.find((p) => p.version === 2)!.status).toBe("what_if");

    const promoted = await promoteWhatIf(client, COMPANY, whatIf.plan.id);
    expect(promoted.status).toBe("current");
    expect(plans.find((p) => p.version === 1)!.status).toBe("superseded");
    expect(plans.find((p) => p.version === 2)!.status).toBe("current");
  });
});

describe("monthly checkpoint (§4.3)", () => {
  it("closes the just-ended month once, grades it, and sends one digest", async () => {
    // A plan gamed in October from the fixture math (net $1,800/wk),
    // so November's planned monthly net is $7,800.
    const snapshot: GameSnapshot = {
      asOf: "2026-10-15",
      netPerWeekCents: { w4: 180_000, w8: 180_000, w12: 180_000 },
      grossRevenuePerWeekCents: 400_000,
      loadsPerWeek: 3,
      avgNetPerLoadCents: 60_000,
      completedLoads: 24,
      fuelCentsPerMonth: 0,
      fuelGallonsPerMonth: 0,
      maintenanceCentsPerMonth: 0,
      fixedCostsCentsPerMonth: 0,
      recentMaintenance: [],
      truckFundBalanceCents: 0,
      emergencyFundBalanceCents: 1_200_000,
      businessCreditBalanceCents: 0,
      fundTargetCents: 2_000_000,
      fundTargetBand: null,
      sweepRulePct: 50,
      actualSavingsRatePct: 10,
      actualMonthlySavingsCents: 78_000,
      driveHoursPerWeek: 40,
      onDutyHoursPerWeek: 50,
      mcAge: { status: "not_started" },
      latestBriefings: [],
      sideIncomeCandidates: [],
      knownDebtsCents: 0,
      personalSnapshotCents: 0,
      weeksOfHistory: 12,
    };
    const targetRow = {
      id: "target-1",
      company_id: COMPANY,
      metric: "monthly_net_cents",
      target_value_cents: 1_000_000,
      target_date: "2027-05-31",
      posture: "conservative",
      posture_mix_pct: 0,
      notes: null,
      is_active: true,
      deleted_at: null,
      created_at: "2026-10-15T00:00:00.000Z",
    };
    const built = buildAssumptions({ snapshot, persistentOverrides: {} });
    const output = runEngine({
      snapshot,
      target: {
        metric: "monthly_net_cents",
        targetValueCents: 1_000_000,
        targetDate: "2027-05-31",
        posture: "conservative",
        postureMixPct: 0,
      },
      values: built.values,
    });
    const planRow: Row = {
      id: "plan-1",
      company_id: COMPANY,
      target_id: "target-1",
      version: 1,
      status: "current",
      trigger: "target_set",
      snapshot,
      assumptions: built.sheet,
      scenarios: { ...output, validity: { valid: true, violations: [] }, removedForValidity: [] },
      narration: "projection",
      diff_summary: null,
      data_sufficiency: { completedLoads: 24, weeksOfHistory: 12, thinData: false },
      created_at: "2026-10-20T00:00:00.000Z",
      deleted_at: null,
    };
    // November actually settled $8,000 of loads, no costs: ahead.
    const novemberLoads: Row[] = [10, 17, 24].map((day, i) => ({
      id: `nov-load-${i}`,
      company_id: COMPANY,
      status: "completed",
      rate_cents: day === 24 ? 200_000 : 300_000,
      pickup_date: `2026-11-${day}`,
      delivery_date: `2026-11-${day}`,
      deleted_at: null,
    }));
    const db = seededDb({
      game_targets: [targetRow],
      game_plans: [planRow],
      loads: novemberLoads,
      fund_entries: [],
      fund_settings: [],
    });
    const sent: string[] = [];
    const notifier = {
      notifyOwner: async (text: string) => {
        sent.push(text);
        return true;
      },
    } as unknown as Parameters<typeof closeMonthlyCheckpoint>[0]["notifier"];

    const outcome = await closeMonthlyCheckpoint({
      client: fakeClient(db),
      companyId: COMPANY,
      notifier,
      now: new Date("2026-12-15T12:00:00Z"),
    });
    expect(outcome.status).toBe("closed");
    if (outcome.status !== "closed") return;
    expect(outcome.checkpoint.verdict).toBe("ahead");
    expect(outcome.checkpoint.planned_value_cents).toBe(780_000);
    expect(outcome.checkpoint.actual_value_cents).toBe(800_000);
    expect(outcome.digestSent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ahead by $200");
    expect(sent[0]).toContain("projected mark");

    const again = await closeMonthlyCheckpoint({
      client: fakeClient(db),
      companyId: COMPANY,
      notifier,
      now: new Date("2026-12-15T12:00:00Z"),
    });
    expect(again.status).toBe("already_closed");
    expect(sent).toHaveLength(1);
  });
});
