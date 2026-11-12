// Telegram audit 2026-11-06 - the pure helpers behind the P0/P1/P2 fixes.

import { describe, expect, it } from "vitest";
import {
  classifyConfirmation,
  isPermanentWriteFailure,
  isSoftYes,
  isYesWithMore,
  nowBlock,
} from "@/services/bot/agent-turn";
import { gateExecutes } from "@/services/bot/execute-gate";
import { stripConfirmationProse } from "@/services/bot/reply-prose";
import { changesInWords, describeRecord, missingReferences } from "@/services/bot/tools-write-helpers";
import { isTransientLoadState } from "@/services/bot/tools";
import type { AgentTool } from "@/services/ai/agent-loop";

describe("classifyConfirmation (P0-1, P2-6)", () => {
  it.each(["yes", "Yes.", "YES!", "yeah", "yep", "do it", "go ahead", "yes please", "yes 👍", "sí", "si", "dale"])(
    "%s is a bare yes",
    (text) => expect(classifyConfirmation(text)).toBe("yes"),
  );
  it.each(["no", "No.", "nope", "nah", "cancel", "never mind", "no thank you", "don't"])("%s is a bare no", (text) =>
    expect(classifyConfirmation(text)).toBe("no"),
  );
  it.each([
    "No that's not it. Delete that",
    "No, remove that and add this instead",
    "yes but make it $3,100",
    "Yes, and the delivery is the 6th",
    "nobody called",
    "yesterday",
  ])("%s carries more than a yes/no", (text) => expect(classifyConfirmation(text)).toBe("other"));
});

describe("soft yes and yes-with-more (P1-10)", () => {
  it("ok / sure are soft yeses, never full ones", () => {
    for (const t of ["ok", "Okay", "sure", "k", "alright"]) {
      expect(isSoftYes(t)).toBe(true);
      expect(classifyConfirmation(t)).toBe("other");
    }
    expect(isSoftYes("ok but change it")).toBe(false);
  });
  it("a yes that carries a correction is recognised", () => {
    expect(isYesWithMore("yes but make it $3,100")).toBe(true);
    expect(isYesWithMore("Yes, delivery is the 6th")).toBe(true);
    expect(isYesWithMore("yes")).toBe(false);
    expect(isYesWithMore("yesterday was long")).toBe(false);
  });
});

describe("isPermanentWriteFailure (P0-2)", () => {
  it("a missing record or refused value is permanent", () => {
    expect(isPermanentWriteFailure(new Error("there is no load with id deadbeef"))).toBe(true);
    expect(isPermanentWriteFailure(new Error("record not found"))).toBe(true);
    expect(isPermanentWriteFailure(new Error('invalid input syntax for type uuid: "deadbeef"'))).toBe(true);
    expect(isPermanentWriteFailure({ name: "ZodError", message: "x" })).toBe(true);
  });
  it("a network hiccup is transient", () => {
    expect(isPermanentWriteFailure(new Error("fetch failed"))).toBe(false);
    expect(isPermanentWriteFailure(new Error("503 Service Unavailable"))).toBe(false);
    expect(isPermanentWriteFailure(new Error("request timed out"))).toBe(false);
  });
});

describe("nowBlock (P1-2)", () => {
  it("states the moment on Eastern time, never UTC", () => {
    // 03:30 UTC on Nov 7 is still Nov 6 in New York.
    const block = nowBlock(new Date("2026-11-07T03:30:00Z"));
    expect(block).toContain("today is 2026-11-06");
    expect(block).toContain("Eastern");
    expect(block).not.toMatch(/UTC/);
  });
});

describe("gateExecutes (P0-6)", () => {
  const tool = (name: string, alwaysPropose = false) =>
    ({ name, alwaysPropose, description: "", parameters: {}, run: async () => "" }) as unknown as AgentTool;
  const tools = [tool("mark_thread_answered"), tool("record_load_decision"), tool("create_expense"), tool("delete_record", true)];

  it("'just completed the load' cannot close a thread or log a decision on its own", () => {
    const gated = gateExecutes(tools, "Just completed the load");
    const by = Object.fromEntries(gated.map((t) => [t.name, t.alwaysPropose]));
    expect(by.mark_thread_answered).toBe(true);
    expect(by.record_load_decision).toBe(true);
    expect(by.create_expense).toBe(false);
    expect(by.delete_record).toBe(true);
  });
  it("naming the action leaves it executable", () => {
    const gated = gateExecutes(tools, "I took that load to Texas");
    expect(gated.find((t) => t.name === "record_load_decision")!.alwaysPropose).toBe(false);
  });
});

describe("stripConfirmationProse (P2-1)", () => {
  it("drops the model's own 'reply YES' copy and keeps the rest", () => {
    const out = stripConfirmationProse(
      "Got it, that's the BOL for the Columbus load. I have NOT recorded this yet. Please reply YES to confirm.",
    );
    expect(out).toBe("Got it, that's the BOL for the Columbus load.");
  });
  it("leaves ordinary replies alone", () => {
    expect(stripConfirmationProse("You have 3h 10m left on your 11.")).toBe("You have 3h 10m left on your 11.");
  });
});

describe("records in words (P0-3, P1-8)", () => {
  it("describes a load the way he knows it", () => {
    expect(
      describeRecord("load", { origin: "Columbus, OH", destination: "Atlanta, GA", rate_cents: 250000, status: "in_transit", delivery_date: "2026-11-06" }),
    ).toBe("load Columbus, OH → Atlanta, GA ($2,500.00, in_transit, delivery 2026-11-06)");
  });
  it("names each change with the old value", () => {
    expect(changesInWords({ delivery_date: "2026-11-06" }, { delivery_date: "2026-11-05" })).toBe(
      "delivery date → 2026-11-06 (was 2026-11-05)",
    );
    expect(changesInWords({ rate_cents: 310000 })).toBe("rate → $3,100.00");
  });
});

describe("missingReferences (P0-3)", () => {
  function client(found: Record<string, string[]>) {
    return {
      from: (table: string) => {
        let id = "";
        const q = {
          select: () => q,
          eq: (col: string, val: string) => {
            if (col === "id") id = val;
            return q;
          },
          is: () => q,
          maybeSingle: async () => ({ data: (found[table] ?? []).includes(id) ? { id } : null, error: null }),
        };
        return q;
      },
    };
  }
  it("is null when every referenced record exists", async () => {
    expect(await missingReferences(client({ loads: ["L1"] }), "c", { load_id: "L1", amount_cents: 5 })).toBeNull();
  });
  it("names the reference that does not exist", async () => {
    expect(await missingReferences(client({}), "c", { load_id: "deadbeef" })).toContain("there is no load with id deadbeef");
  });
});

describe("isTransientLoadState (P1-9)", () => {
  it("a load's current state is not a memory", () => {
    expect(isTransientLoadState("My active load is paying $2,500")).toBe(true);
    expect(isTransientLoadState("The current trip delivers on Friday")).toBe(true);
  });
  it("durable facts still are", () => {
    expect(isTransientLoadState("Fuel on the company card for this run")).toBe(false);
    expect(isTransientLoadState("The carrier settles on Fridays")).toBe(false);
  });
});
