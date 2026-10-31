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

export interface AiVisionRequest {
  system: string;
  user: string;
  /** Base64-encoded image bytes (no data-URI prefix - the provider adds it). */
  imageBase64: string;
  /** IANA media type of the image, e.g. "image/png". */
  mediaType: string;
}

/**
 * Vision is a separate interface, not a widening of AiProvider
 * (docs/design/driver-mvp.md §8.2): capabilities that read images
 * depend on this, text-only capabilities never see it, and existing
 * providers/mocks keep their shape.
 */
export interface AiVisionProvider {
  /** Returns the raw text response - the caller validates it against its output contract. */
  completeWithImage(request: AiVisionRequest): Promise<string>;
}
