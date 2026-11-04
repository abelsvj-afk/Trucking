import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/providers/openai", () => ({ OpenAiProvider: class {} }));

import { savePaperLogDay } from "@/services/fleet/paper-log-review";
import type { SupabaseClient } from "@supabase/supabase-js";

function client(rpcResult: { data?: unknown; error?: { code?: string; hint?: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult.data ?? null, error: rpcResult.error ?? null });
  return { rpc, c: { rpc } as unknown as SupabaseClient };
}

const fullDay = [
  { status: "off_duty" as const, start_min: 0, end_min: 360 },
  { status: "off_duty" as const, start_min: 360, end_min: 420 },
  { status: "driving" as const, start_min: 420, end_min: 990 },
  { status: "on_duty" as const, start_min: 990, end_min: 1440 },
];

describe("savePaperLogDay", () => {
  it("refuses an incomplete day before touching the database", async () => {
    const { rpc, c } = client({});
    const out = await savePaperLogDay(c, "co", "doc", "America/New_York", {
      log_date: "2026-11-03",
      segments: [{ status: "driving", start_min: 0, end_min: 600 }],
      replace_ids: [],
    });
    expect(out).toMatchObject({ ok: false, kind: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("collapses same-status stretches and places times in the carrier time zone", async () => {
    const { rpc, c } = client({ data: 3 });
    const out = await savePaperLogDay(c, "co", "doc-1", "America/New_York", {
      log_date: "2026-11-03",
      segments: fullDay,
      replace_ids: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(out).toEqual({ ok: true, inserted: 3 });
    const args = rpc.mock.calls[0]![1];
    expect(rpc.mock.calls[0]![0]).toBe("save_paper_log_day");
    // 2026-11-03 is EST (UTC-5).
    expect(args.p_day_start).toBe("2026-11-03T05:00:00.000Z");
    expect(args.p_day_end).toBe("2026-11-04T05:00:00.000Z");
    expect(args.p_rows).toEqual([
      { duty_status: "off_duty", started_at: "2026-11-03T05:00:00.000Z" },
      { duty_status: "driving", started_at: "2026-11-03T12:00:00.000Z" },
      { duty_status: "on_duty", started_at: "2026-11-03T21:30:00.000Z" },
    ]);
    expect(args.p_replace_ids).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("handles a daylight-saving day (summer offset UTC-4)", async () => {
    const { rpc, c } = client({ data: 1 });
    await savePaperLogDay(c, "co", "doc", "America/New_York", {
      log_date: "2026-07-01",
      segments: [{ status: "off_duty", start_min: 0, end_min: 1440 }],
      replace_ids: [],
    });
    expect(rpc.mock.calls[0]![1].p_day_start).toBe("2026-07-01T04:00:00.000Z");
  });

  it("maps the database's unacknowledged-entries refusal to a conflict", async () => {
    const { c } = client({ error: { code: "P0001", hint: "paper_log_conflict", message: "x" } });
    const out = await savePaperLogDay(c, "co", "doc", "America/New_York", {
      log_date: "2026-11-03",
      segments: fullDay,
      replace_ids: [],
    });
    expect(out).toEqual({ ok: false, kind: "conflict" });
  });

  it("maps a missing or other-company sheet to not_found", async () => {
    const { c } = client({ error: { code: "P0002", message: "paper log sheet not found" } });
    const out = await savePaperLogDay(c, "co", "doc", "America/New_York", {
      log_date: "2026-11-03",
      segments: fullDay,
      replace_ids: [],
    });
    expect(out).toEqual({ ok: false, kind: "not_found" });
  });

  it("does not swallow an unexpected database error", async () => {
    const { c } = client({ error: { code: "XX000", message: "boom" } });
    await expect(
      savePaperLogDay(c, "co", "doc", "America/New_York", { log_date: "2026-11-03", segments: fullDay, replace_ids: [] }),
    ).rejects.toThrow("boom");
  });
});
