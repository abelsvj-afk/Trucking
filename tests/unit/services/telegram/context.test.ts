import { describe, expect, it } from "vitest";
import {
  classifyTelegramText,
  formatCompanySnapshot,
  memoryKindFor,
  pickRelevantMemories,
  stripCapturePrefix,
  type BotMemoryRow,
  type CompanySnapshot,
} from "@/services/telegram/context";

function memory(kind: BotMemoryRow["kind"], content: string, created_at = "2026-10-31T00:00:00Z"): BotMemoryRow {
  return { kind, content, created_at };
}

describe("classifyTelegramText", () => {
  it("routes forwards to dispatch regardless of language", () => {
    expect(classifyTelegramText("Be there at 6", true)).toBe("dispatch");
  });

  it("routes remember/instruction prefixes to capture", () => {
    expect(classifyTelegramText("Remember: gate code is 4417", false)).toBe("remember");
    expect(classifyTelegramText("Instruction: answer short", false)).toBe("instruction");
    expect(classifyTelegramText("Always give me the Spanish too", false)).toBe("instruction");
  });

  it("routes Spanish-looking text to dispatch and plain English questions to chat", () => {
    expect(classifyTelegramText("Necesito que llegues mañana a la carga", false)).toBe("dispatch");
    expect(classifyTelegramText("When does my 14 run out?", false)).toBe("chat");
    expect(classifyTelegramText("How much did I spend on fuel this week?", false)).toBe("chat");
  });
});

describe("capture helpers", () => {
  it("strips prefixes and classifies expense-flavored dictation as a hint", () => {
    expect(stripCapturePrefix("Remember: Steven pays Fridays")).toBe("Steven pays Fridays");
    expect(stripCapturePrefix("Instruction: keep it short")).toBe("keep it short");
    expect(memoryKindFor("fuel was $3.89 at the Pilot")).toBe("expense_hint");
    expect(memoryKindFor("Steven pays on Fridays")).toBe("fact");
  });
});

describe("pickRelevantMemories", () => {
  const memories = [
    memory("fact", "Steven pays on Fridays"),
    memory("fact", "The truck takes diesel only", "2026-10-30T00:00:00Z"),
    memory("instruction", "Always answer short"),
    memory("note", "Pilot on I-75 has good parking", "2026-10-29T00:00:00Z"),
  ];

  it("never returns instructions (they are injected separately, in full)", () => {
    const picked = pickRelevantMemories(memories, "anything");
    expect(picked.every((m) => m.kind !== "instruction")).toBe(true);
  });

  it("ranks keyword matches first", () => {
    const picked = pickRelevantMemories(memories, "when does Steven pay me?");
    expect(picked[0]?.content).toBe("Steven pays on Fridays");
  });
});

describe("formatCompanySnapshot", () => {
  it("renders real figures from the snapshot and no others", () => {
    const snapshot: CompanySnapshot = {
      activeLoads: [
        { origin: "Melbourne, FL", destination: "Atlanta, GA", status: "confirmed", pickup_date: "2026-11-01", delivery_date: "2026-11-02", rate_cents: 125000 },
      ],
      currentDutyStatus: "driving",
      hos: null,
      expensesLast7DaysCents: 15230,
      fuelLast7DaysCents: 40210,
      contacts: {
        brokers: { names: ["Steven (owner)"], total: 1 },
        customers: { names: [], total: 0 },
        drivers: { names: ["Sajacous"], total: 1 },
      },
    };
    const text = formatCompanySnapshot(snapshot);
    expect(text).toContain("Melbourne, FL → Atlanta, GA");
    expect(text).toContain("$1250.00");
    expect(text).toContain("$402.10");
    expect(text).toContain("brokers (1)");
  });
});
