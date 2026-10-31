import { describe, expect, it } from "vitest";
import { createDispatchExchangeSchema } from "@/data/schemas/dispatch-exchanges";

describe("createDispatchExchangeSchema", () => {
  it("accepts a web exchange with no actual reply yet", () => {
    expect(
      createDispatchExchangeSchema.safeParse({
        incoming_message: "Necesito que llegues a las 6",
        ai_translation: "I need you to arrive at 6",
        source: "web",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(
      createDispatchExchangeSchema.safeParse({ incoming_message: "hi", source: "sms" }).success,
    ).toBe(false);
  });

  it("rejects a missing incoming message", () => {
    expect(createDispatchExchangeSchema.safeParse({ source: "telegram" }).success).toBe(false);
  });
});
