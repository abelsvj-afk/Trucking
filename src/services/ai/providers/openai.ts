// Task 4.2 (TASKS.md). OpenAI implementation of the services/ai provider
// interface - the owner's explicit choice as of Stage 4
// (docs/design/ai-architecture.md).
//
// MODEL NAME CAVEAT (be honest, don't guess with false confidence):
// OpenAI's model lineup has moved quickly and this sandbox can't reach
// platform.openai.com to confirm what's current (network egress blocked,
// same restriction documented in services/integrations). "gpt-4o-mini" is
// used as a conservative documented default only because it's a model
// name with genuine prior confidence behind it, not a verified-current
// one - set OPENAI_MODEL explicitly to whatever OpenAI's docs list as
// current before relying on this in production.

import OpenAI from "openai";
import type { AiCompletionRequest, AiProvider } from "../provider";

const DEFAULT_MODEL = "gpt-4o-mini";

export class OpenAiProvider implements AiProvider {
  private client: OpenAI;
  private model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }
    this.client = new OpenAI({ apiKey });
    this.model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  }

  async complete({ system, user }: AiCompletionRequest): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response.");
    }
    return content;
  }
}
