// Agent omnipresence (docs/design/driver-mvp.md §9). Dump intake,
// the pure half: validateDumpItems (schema + verbatim source quote
// + numeric grounding, all enforced in code) and parseBatchCommand
// (the owner's batch grammar, decided in code). Hand-rolled tool
// registry - the full turn-level flow is covered in
// omnipresence.test.ts against the real tools.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@/services/ai/agent-loop";
import { parseBatchCommand, validateDumpItems } from "@/services/bot/dump-intake";
import { validateWith } from "@/services/bot/tool-helpers";

function writeTool(
  name: string,
  schema: z.ZodType,
  summarize: (args: Record<string, unknown>) => string,
  extra: Partial<AgentTool> = {},
): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    access: "write",
    validateArgs: validateWith(schema),
    summarize,
    run: async () => "ran",
    ...extra,
  };
}

const registry = new Map<string, AgentTool>([
  [
    "add_load_note",
    writeTool(
      "add_load_note",
      z.object({ load_id: z.string().uuid(), note: z.string().min(1) }),
      (a) => `Note: "${a.note}"`,
    ),
  ],
  [
    "create_expense",
    writeTool(
      "create_expense",
      z.object({
        category: z.enum(["insurance", "permits", "repairs", "other"]),
        amount_dollars: z.number().positive(),
        expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      (a) => `Expense $${a.amount_dollars}`,
    ),
  ],
  [
    "delete_record",
    writeTool("delete_record", z.object({ record_id: z.string().uuid() }), () => "DELETE", {
      alwaysPropose: true,
    }),
  ],
]);

const LOAD_ID = "22222222-2222-4222-8222-222222222222";
const DUMP = "Picked up in Melbourne, gate code 4417 at the receiver, and I paid 40 bucks cash for the scale ticket.";

describe("validateDumpItems", () => {
  it("accepts grounded items and stamps them with one shared batch id, quote, and confidence", () => {
    const { proposals, rejected } = validateDumpItems(
      DUMP,
      [
        {
          tool_name: "add_load_note",
          args: { load_id: LOAD_ID, note: "Gate code 4417" },
          source_quote: "gate code 4417 at the receiver",
          confidence: "high",
        },
        {
          tool_name: "create_expense",
          args: { category: "other", amount_dollars: 40 },
          source_quote: "I paid 40 bucks cash for the scale ticket",
          confidence: "medium",
        },
      ],
      registry,
    );
    expect(rejected).toEqual([]);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.batchId).toBeTruthy();
    expect(proposals[0]!.batchId).toBe(proposals[1]!.batchId);
    expect(proposals[0]).toMatchObject({ tool: "add_load_note", sourceQuote: "gate code 4417 at the receiver", confidence: "high" });
  });

  it("REJECTS a value that appears nowhere in the dump - the extraction may not invent figures", () => {
    const { proposals, rejected } = validateDumpItems(
      DUMP,
      [
        {
          tool_name: "add_load_note",
          args: { load_id: LOAD_ID, note: "Gate code 4471" },
          source_quote: "gate code 4417 at the receiver",
          confidence: "high",
        },
      ],
      registry,
    );
    expect(proposals).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("4471");
    expect(rejected[0]!.reason).toContain("nowhere in his message");
  });

  it("rejects an item whose source quote is not a verbatim part of the message", () => {
    const { proposals, rejected } = validateDumpItems(
      DUMP,
      [
        {
          tool_name: "create_expense",
          args: { category: "other", amount_dollars: 40 },
          source_quote: "he paid forty dollars for scales",
          confidence: "low",
        },
      ],
      registry,
    );
    expect(proposals).toEqual([]);
    expect(rejected[0]!.reason).toContain("verbatim");
  });

  it("rejects items that fail the target tool's own validation, and unknown or always-propose tools", () => {
    const { proposals, rejected } = validateDumpItems(
      DUMP,
      [
        {
          tool_name: "create_expense",
          args: { category: "other", amount_dollars: -5 },
          source_quote: "I paid 40 bucks",
          confidence: "low",
        },
        {
          tool_name: "fly_to_moon",
          args: {},
          source_quote: "Picked up in Melbourne",
          confidence: "low",
        },
        {
          tool_name: "delete_record",
          args: { record_id: LOAD_ID },
          source_quote: "Picked up in Melbourne",
          confidence: "low",
        },
      ],
      registry,
    );
    expect(proposals).toEqual([]);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]!.reason).toContain("amount_dollars");
    expect(rejected[1]!.reason).toContain("not a recordable write action");
    expect(rejected[2]!.reason).toContain("separate yes");
  });

  it("requires a date-setting item's quote to mention a day or date to derive it from", () => {
    const noDay = validateDumpItems(
      "I paid 40 bucks cash in Melbourne. The scale ticket is in the door pocket.",
      [
        {
          tool_name: "create_expense",
          args: { category: "other", amount_dollars: 40, expense_date: "2026-11-03" },
          source_quote: "The scale ticket is in the door pocket",
          confidence: "medium",
        },
      ],
      registry,
    );
    expect(noDay.proposals).toEqual([]);
    expect(noDay.rejected[0]!.reason).toContain("no day or date");

    const withDay = validateDumpItems(
      "On Tuesday I paid 40 bucks cash for the scale ticket.",
      [
        {
          tool_name: "create_expense",
          args: { category: "other", amount_dollars: 40, expense_date: "2026-11-03" },
          source_quote: "On Tuesday I paid 40 bucks",
          confidence: "medium",
        },
      ],
      registry,
    );
    expect(withDay.rejected).toEqual([]);
    expect(withDay.proposals).toHaveLength(1);
  });
});

describe("parseBatchCommand", () => {
  it("maps the owner's batch grammar to commands, in code", () => {
    expect(parseBatchCommand("yes")).toEqual({ kind: "approve_all" });
    expect(parseBatchCommand("approve all")).toEqual({ kind: "approve_all" });
    expect(parseBatchCommand("do it")).toEqual({ kind: "other" }); // single-proposal phrase, not a batch approval
    expect(parseBatchCommand("approve 1, 3")).toEqual({ kind: "approve_some", numbers: [1, 3] });
    expect(parseBatchCommand("just 2")).toEqual({ kind: "approve_some", numbers: [2] });
    expect(parseBatchCommand("1 and 3")).toEqual({ kind: "approve_some", numbers: [1, 3] });
    expect(parseBatchCommand("no")).toEqual({ kind: "drop_all" });
    expect(parseBatchCommand("drop the rest")).toEqual({ kind: "drop_rest" });
    expect(parseBatchCommand("that's all")).toEqual({ kind: "drop_rest" });
  });

  it("leaves corrections and questions as 'other' for the model", () => {
    expect(parseBatchCommand("3 is wrong, it's 4417")).toEqual({ kind: "other" });
    expect(parseBatchCommand("what was item 2 again?")).toEqual({ kind: "other" });
    expect(parseBatchCommand("change 1 to Tuesday")).toEqual({ kind: "other" });
  });
});
