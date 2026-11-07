// Owner 2026-11-07: don't ask me to approve two redundant things.

import { describe, expect, it } from "vitest";
import { reconcileProposals, sameArgs, targetKey, type Proposal, type WaitingRow } from "@/services/bot/reconcile-proposals";

const L1 = "9c1e4c7a-0000-4000-8000-0000000000aa";
const L2 = "9c1e4c7a-0000-4000-8000-0000000000bb";
const prop = (tool: string, args: Record<string, unknown>, summary = `${tool} ${JSON.stringify(args)}`): Proposal => ({ tool, args, summary });
const wait = (id: string, tool: string, args: Record<string, unknown>, summary = "waiting", batch: string | null = null): WaitingRow => ({
  id, tool_name: tool, arguments: args, summary, batch_id: batch,
});

describe("targetKey / sameArgs", () => {
  it("keys targeted tools by what they're about; free-standing creates have no key", () => {
    expect(targetKey("update_load", { load_id: L1, rate_dollars: 1 })).toBe(`update_load:${L1}`);
    expect(targetKey("set_pay_terms", { employer_name: " Acme Freight " })).toBe("set_pay_terms:acme freight");
    expect(targetKey("set_pay_pin", { model: "x" })).toBe("set_pay_pin");
    expect(targetKey("delete_record", { entity: "memory", record_id: "m1" })).toBe("delete_record:memory:m1");
    expect(targetKey("create_expense", { amount_dollars: 5 })).toBeNull();
  });
  it("ignores key order, undefined values and the confirmation flag", () => {
    expect(sameArgs({ a: 1, b: { c: 2 }, confirmation: "propose" }, { b: { c: 2 }, a: 1, z: undefined })).toBe(true);
    expect(sameArgs({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("reconcileProposals", () => {
  it("drops a proposal identical to one already waiting, and names the one waiting", () => {
    const r = reconcileProposals(
      [prop("update_load", { load_id: L1, delivery_date: "2026-11-06" })],
      [wait("w1", "update_load", { load_id: L1, delivery_date: "2026-11-06", confirmation: "propose" }, "Update load A → B: delivery date → 2026-11-06")],
    );
    expect(r.stage).toHaveLength(0);
    expect(r.alreadyWaiting).toEqual(["Update load A → B: delivery date → 2026-11-06"]);
    expect(r.clearIds).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/already waiting/);
  });

  it("the newer proposal for the same load replaces the older waiting one", () => {
    const r = reconcileProposals(
      [prop("update_load", { load_id: L1, delivery_date: "2026-11-07" })],
      [wait("w1", "update_load", { load_id: L1, delivery_date: "2026-11-06" }, "old one")],
    );
    expect(r.stage).toHaveLength(1);
    expect(r.clearIds).toEqual(["w1"]);
    expect(r.notes.join(" ")).toMatch(/replaces the earlier request still waiting: old one/);
  });

  it("a different load or a different tool is left alone", () => {
    const r = reconcileProposals(
      [prop("update_load", { load_id: L2, delivery_date: "2026-11-07" }), prop("create_expense", { amount_dollars: 5 })],
      [wait("w1", "update_load", { load_id: L1, delivery_date: "2026-11-06" }), wait("w2", "create_expense", { amount_dollars: 9 })],
    );
    expect(r.stage).toHaveLength(2);
    expect(r.clearIds).toEqual([]);
  });

  it("within one turn identical repeats collapse, and two changes to one record merge (later wins)", () => {
    const r = reconcileProposals(
      [
        prop("update_load", { load_id: L1, delivery_date: "2026-11-06" }),
        prop("update_load", { load_id: L1, delivery_date: "2026-11-06" }),
        prop("update_load", { load_id: L1, delivery_date: "2026-11-07", rate_dollars: 2000 }),
        prop("create_expense", { amount_dollars: 5 }),
        prop("create_expense", { amount_dollars: 5 }),
      ],
      [],
    );
    const tools = r.stage.map((p) => p.tool);
    expect(tools).toEqual(["update_load", "create_expense"]);
    expect(r.stage[0]!.args).toEqual({ load_id: L1, delivery_date: "2026-11-07", rate_dollars: 2000 });
    expect(r.mergedTools).toEqual(["update_load"]);
    expect(r.notes.join(" ")).toMatch(/combined two changes/);
  });

  it("never replaces or clears a batch item (it keeps its number)", () => {
    const r = reconcileProposals(
      [prop("update_load", { load_id: L1, delivery_date: "2026-11-07" })],
      [wait("b1", "update_load", { load_id: L1, delivery_date: "2026-11-06" }, "batch item", "batch-1")],
    );
    expect(r.clearIds).toEqual([]);
    expect(r.stage).toHaveLength(1);
  });

  it("two deletes of different records both stay; the same delete twice collapses", () => {
    const r = reconcileProposals(
      [prop("delete_record", { entity: "memory", record_id: "m1" }), prop("delete_record", { entity: "memory", record_id: "m2" }), prop("delete_record", { entity: "memory", record_id: "m1" })],
      [],
    );
    expect(r.stage).toHaveLength(2);
  });
});
