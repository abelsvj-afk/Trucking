import { describe, expect, it } from "vitest";
import { extractThreadStructure } from "@/services/ai/thread-extraction";
import type { AiProvider } from "@/services/ai/provider";

const RESPONSE = JSON.stringify({
  title: null, participants: [{ name: "Pat", role: "truck_owner" }], messages: [{ sender: "Pat", body: "hi", language: "en" }],
  the_ask: null, ask_of: null, deadline_text: null, unanswered: false, language: "en",
});

function capture() {
  const systems: string[] = [];
  const provider = { complete: async (req: { system: string }) => (systems.push(req.system), RESPONSE) } as unknown as AiProvider;
  return { systems, provider };
}

describe("thread extraction names the owner from stored data only", () => {
  it("uses the stored display name when there is one", async () => {
    const { systems, provider } = capture();
    await extractThreadStructure(provider, "text", "Alex Rivera");
    expect(systems[0]).toContain("owner (the driver himself, Alex Rivera)");
  });

  it("with no stored name the prompt names no one", async () => {
    const { systems, provider } = capture();
    await extractThreadStructure(provider, "text", null);
    expect(systems[0]).toContain("owner (the driver himself)");
    await extractThreadStructure(provider, "text", "   ");
    expect(systems[1]).toContain("owner (the driver himself)");
  });
});
