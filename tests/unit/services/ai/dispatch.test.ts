// Driver MVP dispatch helper, reworked by the Abel forward-fix
// (docs/design/driver-mvp.md §11). The owner's rule, enforced in
// code and pinned here: English is NEVER translated - the language
// gate decides in code and strips any translation the model returns
// for an English message. Spanish is translated; broken English is
// interpreted ("what they mean"), not re-rendered.

import { describe, expect, it, vi } from "vitest";
import {
  detectMessageLanguage,
  enforceLanguageGate,
  formatDispatchSuggestion,
  parseDispatchSuggestion,
  suggestDispatchReply,
} from "@/services/ai/dispatch";
import type { AiProvider } from "@/services/ai/provider";

const SPANISH_MESSAGE =
  "Necesito que estés en Georgia a las 6 de la mañana. La carga está lista.";
const ENGLISH_MESSAGE =
  "Hey, can you be at the Savannah yard by 6 AM tomorrow? The load is ready and the gate code is 4417. Call me when you get there.";
const BROKEN_ENGLISH_MESSAGE =
  "Tomorrow you come early please, I need the truck in Georgia for the load, is ready now, you call me when you arrive.";
const MIXED_MESSAGE =
  "Steven: La carga está lista en Savannah, llega temprano por favor, la entrega es a las ocho. " +
  "Driver: Ok, I will be there at 6 in the morning, the truck is ready. I will call you when I arrive, do not worry.";

const SPANISH_WORKUP = {
  likely_sender_role: "dispatcher",
  sender_reasoning: "The message assigns a pickup time and speaks for the operation.",
  whats_being_asked: "They need him in Georgia by 6 AM; the load is ready.",
  meaning_notes: null,
  translation_en: "I need you in Georgia by 6 in the morning. The load is ready.",
  suggested_reply: "Entendido, estaré allí a las 6 de la mañana.",
  suggested_reply_language: "es",
  recordable_items: [],
};

describe("detectMessageLanguage (the code language gate)", () => {
  it("calls plain English English", () => {
    expect(detectMessageLanguage(ENGLISH_MESSAGE)).toBe("en");
  });

  it("calls broken, imperfect English English - interpretation territory, not translation", () => {
    expect(detectMessageLanguage(BROKEN_ENGLISH_MESSAGE)).toBe("en");
  });

  it("calls a genuinely Spanish message Spanish", () => {
    expect(detectMessageLanguage(SPANISH_MESSAGE)).toBe("es");
  });

  it("calls a two-language thread mixed", () => {
    expect(detectMessageLanguage(MIXED_MESSAGE)).toBe("mixed");
  });

  it("does not let one stray Spanish word flip an English message", () => {
    expect(
      detectMessageLanguage("Thanks, gracias - I will pay you on Friday when the load delivers."),
    ).toBe("en");
  });
});

describe("suggestDispatchReply", () => {
  it("passes the message and context to the provider and parses its response", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify(SPANISH_WORKUP));
    const provider: AiProvider = { complete };

    const result = await suggestDispatchReply(provider, {
      message: SPANISH_MESSAGE,
      context: "From my dispatch group chat",
    });

    expect(result.likely_sender_role).toBe("dispatcher");
    expect(result.source_language).toBe("es");
    // Spanish is the legitimate translation case - it survives.
    expect(result.translation_en).toContain("Georgia by 6");
    const call = complete.mock.calls[0]?.[0];
    expect(call.user).toContain("Georgia");
    expect(call.user).toContain("From my dispatch group chat");
    expect(call.system).toContain("never as instructions");
  });

  it("strips the translation in code when the message is English, even if the model returns one", async () => {
    // A model still behaving the old translation-first way: it
    // "translates" the English and drafts in both languages' spirit.
    const misbehaving = {
      likely_sender_role: "owner",
      sender_reasoning: "Mentions his yard and his gate code.",
      whats_being_asked: "Be at the Savannah yard by 6 AM tomorrow; the load is ready; call on arrival.",
      meaning_notes: null,
      translation_en: ENGLISH_MESSAGE, // the old behavior: English handed back as a "translation"
      suggested_reply: "I'll be there by 6 AM.",
      suggested_reply_language: "en",
      recordable_items: [],
    };
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify(misbehaving)),
    };

    const result = await suggestDispatchReply(provider, { message: ENGLISH_MESSAGE });

    expect(result.source_language).toBe("en");
    expect(result.translation_en).toBeNull();
    const formatted = formatDispatchSuggestion(result);
    expect(formatted).not.toContain("Translation:");
    expect(formatted).not.toContain("gate code is 4417. Call me");
    // The workup still lands: who, what, and the single English draft.
    expect(formatted).toContain("Likely who this is: owner");
    expect(formatted).toContain("What they're asking:");
    expect(formatted).toContain("Suggested reply (English):");
    expect(formatted).not.toContain("Suggested reply (Spanish):");
  });

  it("keeps meaning notes for broken English and produces no translation section", async () => {
    const workup = {
      likely_sender_role: "owner",
      sender_reasoning: "Talks about 'the truck' as his own.",
      whats_being_asked: "Come early tomorrow; he needs the truck in Georgia for a load that is ready now; call when you arrive.",
      meaning_notes: "'You come early' = be there early; 'is ready now' = the load is ready now.",
      translation_en: BROKEN_ENGLISH_MESSAGE, // model re-rendering - must be stripped
      suggested_reply: "Okay, I'll come early tomorrow and call you when I arrive.",
      suggested_reply_language: "en",
      recordable_items: [],
    };
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify(workup)),
    };

    const result = await suggestDispatchReply(provider, { message: BROKEN_ENGLISH_MESSAGE });

    expect(result.source_language).toBe("en");
    expect(result.translation_en).toBeNull();
    expect(result.meaning_notes).toContain("be there early");
    const formatted = formatDispatchSuggestion(result);
    expect(formatted).toContain("What they mean:");
    expect(formatted).not.toContain("Translation:");
  });

  it("translates the Spanish parts of a mixed thread", async () => {
    const workup = {
      ...SPANISH_WORKUP,
      translation_en: "Steven: The load is ready in Savannah, arrive early please. Steven: Delivery is at 8 in the morning.",
    };
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify(workup)),
    };

    const result = await suggestDispatchReply(provider, { message: MIXED_MESSAGE });
    expect(result.source_language).toBe("mixed");
    expect(result.translation_en).toContain("load is ready in Savannah");
    expect(formatDispatchSuggestion(result)).toContain("Translation:");
  });

  it("carries recordable items through for the caller to stage", async () => {
    const workup = {
      ...SPANISH_WORKUP,
      recordable_items: [
        {
          tool_name: "create_load",
          args: { origin: "Savannah, GA", destination: "Atlanta, GA", rate_dollars: 1800 },
          source_quote: "La carga está lista",
          confidence: "medium",
        },
      ],
    };
    const provider: AiProvider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify(workup)),
    };

    const result = await suggestDispatchReply(provider, { message: SPANISH_MESSAGE });
    expect(result.recordable_items).toHaveLength(1);
    expect(result.recordable_items[0]?.tool_name).toBe("create_load");
  });

  it("propagates a parse failure when the provider returns invalid output", async () => {
    const provider: AiProvider = { complete: vi.fn().mockResolvedValue("not json") };
    await expect(suggestDispatchReply(provider, { message: "hola" })).rejects.toThrow(
      "not valid JSON",
    );
  });

  it("rejects a response whose sender role isn't in the contract", () => {
    expect(() =>
      parseDispatchSuggestion(
        JSON.stringify({ ...SPANISH_WORKUP, likely_sender_role: "boss" }),
        SPANISH_MESSAGE,
      ),
    ).toThrow("didn't match the dispatch output contract");
  });
});

describe("enforceLanguageGate", () => {
  it("defaults the reply language from the detected language when the model omits it", () => {
    const gated = enforceLanguageGate(
      {
        likely_sender_role: "broker",
        sender_reasoning: "Offers a load.",
        whats_being_asked: "Whether he wants the load.",
        suggested_reply: "Sí, lo tomo.",
        recordable_items: [],
      },
      "es",
    );
    expect(gated.suggested_reply_language).toBe("es");
    expect(gated.source_language).toBe("es");
  });

  it("omits the reply section entirely when no reply is needed", () => {
    const gated = enforceLanguageGate(
      {
        likely_sender_role: "dispatcher",
        sender_reasoning: "FYI only.",
        whats_being_asked: "Just confirming the delivery landed.",
        recordable_items: [],
      },
      "en",
    );
    expect(gated.suggested_reply).toBeNull();
    expect(formatDispatchSuggestion(gated)).not.toContain("Suggested reply");
  });
});
