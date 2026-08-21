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
