// Lane 2 (Abel Intelligence Upgrade, Phase A) — the embedding
// provider seam. One hard rule from the design (§3.5): pick ONE
// model, and record the model + dimension with every vector -
// mixing embedding models in one index silently corrupts
// retrieval. The model is therefore a module constant (env can
// override it BEFORE first use, never per-call), and every write
// of an embedding stores EMBEDDING_MODEL alongside it.
//
// No API key configured => no provider (null), and retrieval runs
// its full-text arm alone. Embeddings are an enhancement, never a
// hard dependency of answering.

import OpenAI from "openai";

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  private client: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not configured.");
    this.client = new OpenAI({ apiKey: key });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((row) => row.embedding);
  }
}

/** The process-wide provider, or null when no key is configured. Constructed lazily so importing this module never throws. */
let cached: EmbeddingProvider | null | undefined;
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (cached !== undefined) return cached;
  try {
    cached = process.env.OPENAI_API_KEY ? new OpenAiEmbeddingProvider() : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Best-effort single-text embedding: null on ANY failure (no key, network, rate limit) - callers must treat null as "FTS arm only". */
export async function tryEmbed(
  provider: EmbeddingProvider | null,
  text: string,
): Promise<number[] | null> {
  if (!provider || !text.trim()) return null;
  try {
    const [vector] = await provider.embed([text]);
    return vector ?? null;
  } catch (err) {
    console.error("[embeddings] embed failed; continuing without the vector arm", err);
    return null;
  }
}

/** pgvector's text literal form, for RPC arguments and updates. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
