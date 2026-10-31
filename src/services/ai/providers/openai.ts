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
import type {
  AiAgentMessage,
  AiCompletionRequest,
  AiProvider,
  AiToolSpec,
  AiToolTurnResult,
  AgentCapableProvider,
} from "../provider";

const DEFAULT_MODEL = "gpt-4o-mini";

export class OpenAiProvider implements AgentCapableProvider {
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

  /**
   * One tool-calling turn for the agent loop (§8). Deliberately does
   * NOT use complete()'s json_object response format: the loop's
   * final answer is plain chat text, and forcing JSON here would
   * fight the tool-call protocol. Arguments are returned as the raw
   * JSON string the model produced - the loop parses defensively.
   */
  async runToolTurn(messages: AiAgentMessage[], tools: AiToolSpec[]): Promise<AiToolTurnResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((message) => {
        if (message.role === "tool") {
          return { role: "tool" as const, tool_call_id: message.toolCallId, content: message.content };
        }
        if (message.role === "assistant" && message.toolCalls) {
          return {
            role: "assistant" as const,
            content: message.content,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          };
        }
        return { role: message.role, content: message.content ?? "" };
      }),
      tools: tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: "auto",
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("OpenAI returned an empty response.");
    }

    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));

    return { text: message.content ?? null, toolCalls };
  }
}
