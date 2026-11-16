// Abel's "can't do that yet" list (docs/design/abel-do-what-i-ask.md section 1).
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCapabilityGapTools, listOpenCapabilityGaps, recordCapabilityGap } from "@/services/bot/capability-gaps";
import type { BotBrainStore } from "@/services/bot/store";

type Row = Record<string, unknown>;

function fakeClient(rows: Row[], failWith?: string) {
  const query = () => {
    const filters: [string, unknown][] = [];
    let patch: Row | null = null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push([c, v]), q),
      is: () => q,
      order: () => q,
      limit: () => q,
      update: (p: Row) => ((patch = p), q),
      insert: async (r: Row) => {
        if (failWith) return { error: { message: failWith } };
        rows.push({ id: `g${rows.length + 1}`, times_asked: 1, status: "open", last_asked_at: new Date().toISOString(), ...r });
        return { error: null };
      },
      then: (ok: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        if (failWith) return Promise.resolve(ok({ data: null, error: { message: failWith } }));
        const hit = rows.filter((r) => filters.every(([c, v]) => c === "company_id" || r[c] === v));
        if (patch) hit.forEach((r) => Object.assign(r, patch));
        return Promise.resolve(ok({ data: hit, error: null }));
      },
    };
    return q;
  };
  return { from: () => query() } as unknown as SupabaseClient;
}

describe("the can't-do-yet list", () => {
  it("records an ask, and the same thing asked again bumps the count instead of adding a row", async () => {
    const rows: Row[] = [];
    const client = fakeClient(rows);
    expect(await recordCapabilityGap(client, "c", "book me a parking spot", "Booking a parking spot online")).toBe(1);
    expect(await recordCapabilityGap(client, "c", "reserve parking tonight", "booking a parking spot online.")).toBe(2);
    expect(rows).toHaveLength(1);
    expect((await listOpenCapabilityGaps(client, "c"))[0]).toMatchObject({ times_asked: 2, asked: "reserve parking tonight" });
  });

  it("the tool tells Abel to say plainly it can't, and still does when the list can't be saved (table not applied yet)", async () => {
    const ok = buildCapabilityGapTools({ client: fakeClient([]), companyId: "c" } as unknown as BotBrainStore)[0]!;
    expect(ok.access).toBe("read");
    expect(await ok.run({ asked: "x", missing: "y" })).toContain("can't do it yet");
    const broken = buildCapabilityGapTools({ client: fakeClient([], 'relation "abel_capability_gaps" does not exist'), companyId: "c" } as unknown as BotBrainStore)[0]!;
    expect(await broken.run({ asked: "x", missing: "y" })).toContain("can't do this yet");
  });
});
