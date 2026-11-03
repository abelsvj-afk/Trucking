// Phase F eval fixture — a deterministic "concept embedder".
//
// Real hybrid retrieval (migration 00029 + text-embedding-3-small)
// finds facts by MEANING: "diesel" lands near "fuel", "paga" near
// "pays". A test gate without secrets cannot call the real model,
// so this fixture simulates that one property honestly: every text
// is mapped to a sparse vector over hand-built synonym CLUSTERS
// (English + Spanish surface forms of the same concept). Two texts
// score cosine > 0 exactly when they talk about the same concept,
// even with zero shared words — which is the property the
// paraphrase and crossover golden cases exist to prove the
// RETRIEVAL CODE exploits (RPC contract, RRF fusion, budgets,
// current-only filtering). What it does NOT prove is the real
// model's semantic quality — that is the live arm's job, and the
// harness report says so.
//
// The clusters are domain vocabulary (fuel, pay, detention, days,
// truck parts, places) — a general mechanism, not per-case answers:
// a golden case passes only if the production retrieval path ranks
// the seeded fact using these vectors through the same fuseRrf the
// SQL contract mirrors.

import type { EmbeddingProvider } from "@/services/bot/embeddings";

/** Concept -> surface tokens (lowercase, punctuation-free). */
export const CONCEPTS: Record<string, string[]> = {
  fuel: ["fuel", "diesel", "gasoline", "gasolina", "combustible", "gasoil", "gas"],
  payment: [
    "pay", "pays", "paid", "paying", "paga", "pago", "pagan",
    "settlement", "settles", "settle", "salary", "wage", "cobra", "cobro",
  ],
  detention: ["detention", "detencion", "demora", "waiting", "wait", "espera", "dock"],
  friday: ["friday", "viernes"],
  thursday: ["thursday", "jueves"],
  tire: ["tire", "tires", "tyre", "rubber", "llanta", "llantas", "neumatico", "psi", "pressure", "inflation"],
  brake: ["brake", "brakes", "freno", "frenos"],
  oil: ["oil", "aceite", "lubricant", "engine", "motor"],
  trailer: ["trailer", "remolque", "caja", "box", "reefer"],
  truck: ["truck", "camion", "camión", "tractor"],
  broker: ["broker", "corredor", "agent", "agente"],
  pickup: ["pickup", "recoger", "recogida", "collect"],
  delivery: ["delivery", "entrega", "deliver", "entregar", "dropoff"],
  appointment: ["appointment", "cita", "schedule", "horario"],
  phone: ["phone", "telefono", "teléfono", "celular", "call", "llamada"],
  home: ["home", "casa", "house", "hogar"],
  route: ["route", "ruta", "road", "carretera"],
  sleep: ["sleep", "dormir", "rest", "descanso", "berth"],
  shop: ["shop", "taller", "mechanic", "mecanico", "mecánico"],
  gatecode: ["gate", "code", "codigo", "código", "puerta"],
};

export const CONCEPT_NAMES = Object.keys(CONCEPTS);

const TOKEN_TO_CONCEPTS = new Map<string, number[]>();
CONCEPT_NAMES.forEach((name, idx) => {
  for (const token of CONCEPTS[name] ?? []) {
    const list = TOKEN_TO_CONCEPTS.get(token) ?? [];
    list.push(idx);
    TOKEN_TO_CONCEPTS.set(token, list);
  }
});

export function tokenizeLoose(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Text -> unit-length concept vector (all-zero when no concept token is present). */
export function conceptVector(text: string): number[] {
  const vector = new Array<number>(CONCEPT_NAMES.length).fill(0);
  for (const token of tokenizeLoose(text)) {
    for (const idx of TOKEN_TO_CONCEPTS.get(token) ?? []) {
      vector[idx] = (vector[idx] ?? 0) + 1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The EmbeddingProvider the harness injects into production retrieval — same seam the real OpenAI provider uses. */
export const conceptEmbedder: EmbeddingProvider = {
  model: "fixture-concept-v1",
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => conceptVector(text));
  },
};

/** Parse a pgvector literal ("[0.1,0.2,...]") back into numbers — the RPC fake receives embeddings in this form from production code. */
export function parseVectorLiteral(literal: string | null | undefined): number[] | null {
  if (!literal) return null;
  try {
    const parsed = JSON.parse(literal) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => (typeof v === "number" ? v : 0));
  } catch {
    return null;
  }
}
