import { describe, expect, it } from "vitest";
import { buildBotTools } from "@/services/bot/tools";

const store = { client: {}, companyId: "c", channel: "telegram" } as never;
const tools = buildBotTools(store);
const byName = (name: string) => tools.find((t) => t.name === name);

describe("create_document (Abel document creation)", () => {
  it("is registered as a write tool", () => {
    const tool = byName("create_document");
    expect(tool).toBeDefined();
    expect(tool!.access).toBe("write");
    expect(tool!.summarize).toBeDefined();
  });

  it("the proposal summary carries the document's full text", () => {
    const summary = byName("create_document")!.summarize!({
      kind: "invoice",
      situation: "own_authority",
      title: "Invoice 12",
      party_from: "Road to Legacy",
      party_to: "A broker",
      line_amounts_dollars: [{ label: "Detention", amount_dollars: 75 }],
      total_dollars: 75,
      related_entity_type: "load",
      related_entity_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(summary).toContain("Invoice 12");
    expect(summary).toContain("Detention: $75.00");
    expect(summary).toContain("Total: $75.00");
  });

  it("an expense proposal summary is built from the expense facts passed", () => {
    const summary = byName("create_document")!.summarize!({
      kind: "deduction_notice",
      situation: "carrier",
      expense_id: "22222222-2222-4222-8222-222222222222",
      expense_amount_dollars: 250,
      expense_date: "2026-11-08",
      expense_category: "other",
      expense_description: "Mud recovery",
      expense_bucket: "pay_deduction",
    });
    expect(summary).toContain("Amount deducted: $250.00");
    expect(summary).toContain("Mud recovery");
  });
});

describe("expense buckets in Abel's expense tools", () => {
  it("create_expense's proposal names a pay deduction in words", () => {
    const summary = byName("create_expense")!.summarize!({
      category: "other",
      amount_dollars: 250,
      description: "Mud recovery",
      bucket: "pay_deduction",
    });
    expect(summary).toContain("PAY DEDUCTION");
    const business = byName("create_expense")!.summarize!({ category: "other", amount_dollars: 40 });
    expect(business).toContain("business expense");
  });

  it("update_expense validates a bucket change (the reclassification proposal)", () => {
    const tool = byName("update_expense")!;
    const checked = tool.validateArgs!({ expense_id: "33333333-3333-4333-8333-333333333333", bucket: "pay_deduction" });
    expect(checked.ok).toBe(true);
  });
});
