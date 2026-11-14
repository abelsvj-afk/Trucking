// ELD stopped vehicle — the minute-6 auto-switch (brief §3.5, owner
// call 2026-11-14: ON, ELD-faithful). Guard tests: prompt + silence
// required, On Duty only, backdated to the stop start, original row
// untouched, in-motion time untouched, idempotent per stop episode.

import { describe, expect, it } from "vitest";
import { judgeAutoStop } from "@/lib/auto-motion-rules";
import { applyAutoStopSwitch, autoStopSubmissionId } from "@/services/fleet/auto-motion";

const T0 = 1_800_000_000_000;
const COMPANY = "company-1";

describe("judgeAutoStop", () => {
  const driving = { duty_status: "driving" as const, started_at: new Date(T0 - 60 * 60_000).toISOString() };
  const stopIso = new Date(T0).toISOString();

  it("allows the switch at minute 6 with a prompt shown at minute 5", () => {
    expect(judgeAutoStop(driving, stopIso, T0 + 6 * 60_000, T0 + 5 * 60_000)).toEqual({ ok: true });
  });

  it("refuses without a prompt — never auto-switch blind", () => {
    expect(judgeAutoStop(driving, stopIso, T0 + 6 * 60_000, null)).toEqual({ ok: false, reason: "never_prompted" });
  });

  it("refuses inside the minute of silence", () => {
    expect(judgeAutoStop(driving, stopIso, T0 + 5 * 60_000 + 30_000, T0 + 5 * 60_000)).toEqual({
      ok: false,
      reason: "silence_not_elapsed",
    });
  });

  it("refuses when not Driving, with no log, or when a row already caps the segment", () => {
    expect(judgeAutoStop({ duty_status: "on_duty", started_at: driving.started_at }, stopIso, T0 + 6 * 60_000, T0 + 5 * 60_000)).toEqual({
      ok: false,
      reason: "not_driving",
    });
    expect(judgeAutoStop(null, stopIso, T0 + 6 * 60_000, T0 + 5 * 60_000)).toEqual({ ok: false, reason: "no_status" });
    expect(
      judgeAutoStop({ duty_status: "driving", started_at: new Date(T0 + 60_000).toISOString() }, stopIso, T0 + 6 * 60_000, T0 + 5 * 60_000),
    ).toEqual({ ok: false, reason: "manual_change_won" });
  });

  it("refuses a stop in the future, a stop older than the proposal expiry, or a bad time", () => {
    expect(judgeAutoStop(driving, new Date(T0 + 60 * 60_000).toISOString(), T0 + 6 * 60_000, T0 + 5 * 60_000)).toEqual({
      ok: false,
      reason: "stop_in_future",
    });
    expect(judgeAutoStop(driving, new Date(T0 - 3 * 60 * 60_000).toISOString(), T0, T0 - 3 * 60 * 60_000 + 5 * 60_000)).toEqual({
      ok: false,
      reason: "stop_too_old",
    });
    expect(judgeAutoStop(driving, "not-a-time", T0 + 6 * 60_000, T0 + 5 * 60_000)).toEqual({ ok: false, reason: "bad_time" });
  });
});

// ---- a minimal in-memory Supabase stand-in ---------------------------------
// Supports only the chain the switch uses: select/eq/is/gte/order/limit/
// single/maybeSingle/insert, each resolving { data, error }.

type Row = Record<string, unknown>;

class FakeQuery {
  private table: string;
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];
  private orderKey: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private insertRow: Row | null = null;

  constructor(
    private db: Record<string, Row[]>,
    table: string,
  ) {
    this.table = table;
    this.rows = db[table] ?? [];
  }

  select(): this {
    return this;
  }
  eq(key: string, value: unknown): this {
    this.filters.push((r) => r[key] === value);
    return this;
  }
  is(key: string, value: unknown): this {
    this.filters.push((r) => (value === null ? r[key] == null : r[key] === value));
    return this;
  }
  gte(key: string, value: string): this {
    this.filters.push((r) => typeof r[key] === "string" && (r[key] as string) >= value);
    return this;
  }
  order(key: string, opts: { ascending: boolean }): this {
    this.orderKey = key;
    this.orderAsc = opts.ascending;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.singleMode = "single";
    return this;
  }
  maybeSingle(): this {
    this.singleMode = "maybeSingle";
    return this;
  }
  insert(row: Row): this {
    this.insertRow = row;
    return this;
  }

  private run(): { data: Row | Row[] | null; error: null } {
    if (this.insertRow) {
      const row = { ...this.insertRow, id: `row-${this.rows.length + 1}` };
      this.rows.push(row); // this.rows IS db[table]: one push lands it
      return { data: null, error: null };
    }
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderKey) {
      const k = this.orderKey;
      out = [...out].sort((a, b) => {
        const av = String(a[k] ?? "");
        const bv = String(b[k] ?? "");
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    if (this.singleMode === "maybeSingle") return { data: out[0] ?? null, error: null };
    if (this.singleMode === "single") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then(onFulfilled: (v: { data: Row | Row[] | null; error: null }) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

function fakeClient(db: Record<string, Row[]>): unknown {
  return {
    from: (table: string) => new FakeQuery(db, table),
  };
}

describe("applyAutoStopSwitch", () => {
  const stopMs = T0;
  const stopIso = new Date(stopMs).toISOString();
  const submissionId = autoStopSubmissionId(stopMs);

  function setup(): { companies: Row[]; ai_capability_settings: Row[]; duty_logs: Row[]; duty_log_edits: Row[] } {
    const db = {
      companies: [{ id: COMPANY, ai_globally_disabled: false }],
      ai_capability_settings: [],
      duty_logs: [
        {
          id: "driving-row",
          company_id: COMPANY,
          duty_status: "driving",
          started_at: new Date(T0 - 60 * 60_000).toISOString(),
          notes: null,
          time_zone: "America/New_York",
          deleted_at: null,
        },
      ],
      duty_log_edits: [],
    };
    return db;
  }

  it("appends ONE On Duty row backdated to the stop start; the Driving row is untouched", async () => {
    const db = setup();
    const res = await applyAutoStopSwitch({
      client: fakeClient(db) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: T0 + 5 * 60_000,
      origin: "position feed",
      timeZone: "America/New_York",
    });
    expect(res.switched).toBe(true);
    expect(res.startedAt).toBe(stopIso);
    const rows = db.duty_logs as Row[];
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === "driving-row")!;
    expect(original.duty_status).toBe("driving");
    expect(original.started_at).toBe(new Date(T0 - 60 * 60_000).toISOString());
    const correction = rows.find((r) => r.id !== "driving-row")!;
    expect(correction.duty_status).toBe("on_duty");
    expect(correction.started_at).toBe(stopIso);
    expect(correction.source).toBe("auto_motion");
    expect(String(correction.notes)).toContain("Mirror correction");
    // The trail entry: reason + before (Driving) + after (On Duty).
    expect(db.duty_log_edits).toHaveLength(1);
    const trail = db.duty_log_edits[0]!;
    expect(trail.kind).toBe("insert");
    expect((trail.before as Row).duty_status).toBe("driving");
    expect((trail.after as Row).duty_status).toBe("on_duty");
    // The confirmation says the 14-hour window is NOT rewound.
    expect(res.message).toContain("Driving time fixed");
    expect(res.message).toContain("14-hour window");
    expect(res.message).not.toContain("rewound");
  });

  it("is idempotent per stop episode: a replay reports deduplicated, no second row", async () => {
    const db = setup();
    const args = {
      client: fakeClient(db) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: T0 + 5 * 60_000,
      origin: "position feed" as const,
      timeZone: "America/New_York",
    };
    expect((await applyAutoStopSwitch(args)).switched).toBe(true);
    const second = await applyAutoStopSwitch(args);
    expect(second.switched).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(db.duty_logs).toHaveLength(2);
  });

  it("never auto-switches to Off Duty or Sleeper: only On Duty is ever written", async () => {
    const db = setup();
    const res = await applyAutoStopSwitch({
      client: fakeClient(db) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: T0 + 5 * 60_000,
      origin: "app",
      timeZone: "America/New_York",
    });
    expect(res.switched).toBe(true);
    expect((db.duty_logs as Row[]).map((r) => r.duty_status)).toEqual(["driving", "on_duty"]);
  });

  it("stands down when the log no longer says Driving", async () => {
    const db = setup();
    (db.duty_logs[0] as Row).duty_status = "on_duty";
    const res = await applyAutoStopSwitch({
      client: fakeClient(db) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: T0 + 5 * 60_000,
      origin: "app",
    });
    expect(res.switched).toBe(false);
    expect(res.reason).toBe("not_driving");
    expect(db.duty_logs).toHaveLength(1);
  });

  it("stands down when never prompted, and when the kill switch is off", async () => {
    const db = setup();
    const unprompted = await applyAutoStopSwitch({
      client: fakeClient(db) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: null,
      origin: "app",
    });
    expect(unprompted.switched).toBe(false);
    expect(unprompted.reason).toBe("never_prompted");

    const dbOff = setup();
    dbOff.ai_capability_settings = [{ company_id: COMPANY, capability: "auto_duty_switch", enabled: false }];
    const off = await applyAutoStopSwitch({
      client: fakeClient(dbOff) as any,
      companyId: COMPANY,
      stoppedSinceIso: stopIso,
      submissionId,
      nowMs: T0 + 6 * 60_000,
      promptedAtMs: T0 + 5 * 60_000,
      origin: "app",
    });
    expect(off.switched).toBe(false);
    expect(off.reason).toBe("switched_off");
  });
});
