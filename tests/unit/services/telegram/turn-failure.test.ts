import { describe, expect, it } from "vitest";
import { classifyTurnFailure, turnFailureReply } from "@/services/telegram/turn-failure";

const apiError = (status: number, code?: string, message = "request failed") =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

describe("a failed turn says what broke (owner 2026-11-16)", () => {
  it("classifies the AI provider's failures", () => {
    expect(classifyTurnFailure(apiError(429, "insufficient_quota", "You exceeded your current quota"))).toBe("ai_credit");
    expect(classifyTurnFailure(apiError(401, "invalid_api_key"))).toBe("ai_key");
    expect(classifyTurnFailure(apiError(429))).toBe("ai_busy");
    expect(classifyTurnFailure(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }))).toBe("ai_timeout");
    expect(classifyTurnFailure(apiError(503))).toBe("ai_down");
    expect(classifyTurnFailure(new Error('column "x" does not exist'))).toBe("database");
    expect(classifyTurnFailure(new Error("boom"))).toBe("unknown");
  });

  it("never shows the raw error, and says nothing was recorded", () => {
    const reply = turnFailureReply(apiError(429, "insufficient_quota", "sk-secret-123 quota"), false);
    expect(reply).toContain("out of credit");
    expect(reply).toContain("Nothing was recorded");
    expect(reply).not.toContain("sk-secret");
    expect(turnFailureReply(new Error("x"), true)).toContain("Dispatch helper");
    expect(turnFailureReply(new Error("x"), false)).not.toContain("Dispatch helper");
  });
});
