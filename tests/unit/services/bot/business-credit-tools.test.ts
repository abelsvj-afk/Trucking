// Business Credit Abel tools (docs/design/business-credit.md §3):
// list renders the file incl. audit events; update writes the row AND
// an abel_tool audit event; unknown vendor keys fail honestly; on a
// pre-00087 database both answer "not switched on yet".

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBusinessCreditTools } from "@/services/bot/business-credit-tools";
import type { BotBrainStore } from "@/services/bot/store";

type Row = Record<string, unknown>;

const PROFILE: Row = {
  id: "prof-1", company_id: "company-1", legal_name: "SAJACOUS MIXED IT LLC",
  filed_name: "SAJACOUSMIXEDIT LLC", duns: "144-350783", sunbiz_doc: "L26000135400",
  sunbiz_status: "ACTIVE", registered_address: "720 N US Highway 441 #1021, Lady Lake, FL 32159",
  business_email: "owner@roadtolegacytrucking.com",
  created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", deleted_at: null,
};
const QUILL: Row = {
  id: "acct-quill", company_id: "company-1", vendor: "Quill", vendor_key: "quill",
  status: "Account established", reports_to: ["Dun & Bradstreet"], next_action: "Prepaid orders",
  payment_state: "none", next_due_date: null, amount_due_cents: null,
  match_senders: ["quill.com"], notes: null, sort_order: 2,
  created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", deleted_at: null,
};

function fakeClient(opts: { landed?: boolean } = {}) {
  const landed = opts.landed !== false;
  const db = { updates: [] as Row[], events: [] as Row[] };
  let seq = 0;
  class Builder {
    pendingInsert: Row | null = null;
    pendingUpdate: Row | null = null;
    constructor(private table: string) {}
    select() { return this; }
    insert(obj: Row) { this.pendingInsert = obj; return this; }
    update(obj: Row) { this.pendingUpdate = obj; return this; }
    eq() { return this; }
    is() { return this; }
    order() { return this; }
    limit() { return this; }
    async single() {
      const row = { id: `id-${++seq}`, ...(this.pendingInsert ?? {}) };
      if (this.table === "business_credit_events") db.events.push(row);
      return { data: row, error: null };
    }
    async maybeSingle() {
      if (!landed) return { data: null, error: { message: "relation does not exist" } };
      if (this.table === "business_credit_profiles") return { data: PROFILE, error: null };
      return { data: null, error: null };
    }
    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onF: (v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>,
      onR?: ((r: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      if (this.pendingUpdate) {
        db.updates.push({ table: this.table, ...this.pendingUpdate });
        return Promise.resolve({ data: null, error: null }).then(onF, onR ?? undefined);
      }
      if (!landed) return Promise.resolve({ data: null, error: { message: "relation does not exist" } }).then(onF, onR ?? undefined);
      const value =
        this.table === "business_credit_accounts" ? { data: [QUILL], error: null }
        : this.table === "business_credit_profiles" ? { data: [PROFILE], error: null }
        : { data: [], error: null };
      return Promise.resolve(value).then(onF, onR ?? undefined);
    }
  }
  const client = { from: (t: string) => new Builder(t) } as unknown as SupabaseClient;
  return { client, db };
}

function tools(client: SupabaseClient) {
  return buildBusinessCreditTools({
    client,
    companyId: "company-1",
  } as unknown as BotBrainStore);
}

describe("business credit tools", () => {
  it("list renders identity, accounts and (empty) activity", async () => {
    const { client } = fakeClient();
    const list = tools(client).find((t) => t.name === "list_business_credit_accounts")!;
    const out = await list.run({});
    expect(out).toContain("SAJACOUS MIXED IT LLC");
    expect(out).toContain("144-350783");
    expect(out).toContain("Quill");
    expect(out).not.toMatch(/\bEIN\b/);
  });

  it("update writes the account row and an abel_tool audit event", async () => {
    const { client, db } = fakeClient();
    const update = tools(client).find((t) => t.name === "update_business_credit_account")!;
    expect(update.access).toBe("write");
    const out = await update.run(
      { vendor_key: "quill", payment_state: "paid" },
    );
    expect(out).toContain("Quill updated");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ payment_state: "paid" });
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ source: "abel_tool", signal: "update", account_id: "acct-quill" });
  });

  it("unknown vendor key fails honestly and writes nothing", async () => {
    const { client, db } = fakeClient();
    const update = tools(client).find((t) => t.name === "update_business_credit_account")!;
    const out = await update.run(
      { vendor_key: "grainger", status: "Active" },
    );
    expect(out).toContain("No business-credit account");
    expect(db.updates).toHaveLength(0);
  });

  it("pre-00087 database answers not-switched-on", async () => {
    const { client } = fakeClient({ landed: false });
    const list = tools(client).find((t) => t.name === "list_business_credit_accounts")!;
    const out = await list.run({});
    expect(out).toContain("isn't switched on yet");
  });
});
