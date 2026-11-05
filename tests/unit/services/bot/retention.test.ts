import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MESSAGE_RETENTION_DAYS, retireOldMessages } from "@/services/bot/retention";

function fake(rows: { id: string; created_at: string; deleted_at: string | null }[]) {
  const updates: { ids: unknown; patch: unknown }[] = [];
  let cutoff = "";
  const client = {
    from: () => {
      const q: Record<string, unknown> = {};
      let mode = "select";
      let patch: unknown = null;
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.lt = (_c: string, v: string) => ((cutoff = v), q);
      q.update = (p: unknown) => ((mode = "update"), (patch = p), q);
      q.in = async (_c: string, ids: unknown) => (updates.push({ ids, patch }), { error: null });
      q.then = (res: (v: unknown) => void) =>
        res({ data: rows.filter((r) => !r.deleted_at && r.created_at < cutoff).map((r) => ({ id: r.id })), error: null });
      void mode;
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

describe("message retention (D-8)", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("soft-deletes only messages older than 12 months, never hard-deletes", async () => {
    const old = new Date(now.getTime() - (MESSAGE_RETENTION_DAYS + 5) * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const { client, updates } = fake([
      { id: "a", created_at: old, deleted_at: null },
      { id: "b", created_at: recent, deleted_at: null },
      { id: "c", created_at: old, deleted_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(await retireOldMessages(client, "co", now)).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.ids).toEqual(["a"]);
    expect(updates[0]!.patch).toEqual({ deleted_at: now.toISOString() });
  });
  it("nothing old: no update at all", async () => {
    const { client, updates } = fake([{ id: "b", created_at: new Date(now.getTime() - 86_400_000).toISOString(), deleted_at: null }]);
    expect(await retireOldMessages(client, "co", now)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
