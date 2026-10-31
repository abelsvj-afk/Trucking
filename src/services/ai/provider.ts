// Task 4.2 (TASKS.md), per docs/design/ai-architecture.md's provider-
// agnostic Model section: every capability calls this interface, never a
// vendor SDK directly, so swapping providers (the owner has asked to keep
// Anthropic available later) is a new file implementing this, not a
// rewrite of every capability that calls it.

export interface AiCompletionRequest {
  system: string;
  user: string;
}

export interface AiProvider {
  /** Returns the raw text response - the caller (e.g. the output contract) is responsible for interpreting/validating it. */
  complete(request: AiCompletionRequest): Promise<string>;
}

// Bot intelligence v2 (docs/design/driver-mvp.md §8): the agent loop
// needs structured tool-calling turns, which the text-only contract
// above cannot express. This extends the same provider pattern
// instead of replacing it - existing capabilities keep calling
// complete() and are untouched; a provider that can't do tool turns
// simply doesn't implement this interface, and callers must check
// with isAgentCapableProvider and fall back honestly.

/** A tool offered to the model for one turn. `parameters` is a JSON Schema object. */
export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  /** Raw JSON string, exactly as the model produced it - parse defensively. */
  arguments: string;
}

export type AiAgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface AiToolTurnResult {
  /** Final assistant text, when the model is done calling tools. */
  text: string | null;
  /** Tool calls the model wants run before it answers (possibly empty). */
  toolCalls: AiToolCall[];
}

export interface AgentCapableProvider extends AiProvider {
  runToolTurn(messages: AiAgentMessage[], tools: AiToolSpec[]): Promise<AiToolTurnResult>;
}

export function isAgentCapableProvider(provider: AiProvider): provider is AgentCapableProvider {
  return typeof (provider as AgentCapableProvider).runToolTurn === "function";
}
