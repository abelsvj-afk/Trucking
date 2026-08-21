import { describe, expect, it } from "vitest";
import { parseAiOutput } from "@/services/ai/output-contract";

describe("parseAiOutput", () => {
  it("accepts a valid 'ok' response", () => {
    const result = parseAiOutput(
      JSON.stringify({
        status: "ok",
        summary: "Diesel prices up 3% this week.",
        reasoning: "EIA's weekly series shows a clear increase.",
        confidence: "high",
        based_on: ["EIA weekly diesel price series"],
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("accepts a valid 'insufficient_data' response", () => {
    const result = parseAiOutput(
      JSON.stringify({ status: "insufficient_data", reason: "No news items this cycle." }),
    );
    expect(result.status).toBe("insufficient_data");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAiOutput("not json")).toThrow("not valid JSON");
  });

  it("throws when 'ok' is missing based_on", () => {
    expect(() =>
      parseAiOutput(
        JSON.stringify({
          status: "ok",
          summary: "x",
          reasoning: "y",
          confidence: "high",
          based_on: [],
        }),
      ),
    ).toThrow("didn't match the output contract");
  });

  it("throws on an invalid confidence value", () => {
    expect(() =>
      parseAiOutput(
        JSON.stringify({
          status: "ok",
          summary: "x",
          reasoning: "y",
          confidence: "very high",
          based_on: ["a"],
        }),
      ),
    ).toThrow();
  });

  it("throws on an unrecognized status", () => {
    expect(() => parseAiOutput(JSON.stringify({ status: "maybe" }))).toThrow();
  });
});
