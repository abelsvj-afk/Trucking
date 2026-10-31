// Deep Research Engine watcher: FMCSA rulemaking via the Federal
// Register API (docs/design/research-engine.md §2). The API is free
// and needs no key (federalregister.gov/api/v1). Response is validated
// with Zod before anything is trusted - untrusted external content
// (CLAUDE.md) - and any failure returns status 'error' with the reason,
// never a silent empty result.
//
// Magnitude read: a FINAL rule (type RULE) whose title/abstract matches
// a tracked regulation keyword is the strongest regulatory pressure
// there is (0.9). A proposed rule (PRORULE) on a tracked topic is real
// but earlier-stage (0.6). Anything else FMCSA publishes is recorded at
// low magnitude (0.3) so the archive sees it without triggering runs.

import { z } from "zod";
import { matchTrackedTopics, type PressureSignal, type Watcher, type WatcherResult } from "./types";

export const FEDERAL_REGISTER_WATCHER_KEY = "federal_register";

const API_URL = "https://www.federalregister.gov/api/v1/documents.json";

const documentSchema = z.object({
  document_number: z.string(),
  title: z.string(),
  type: z.string(),
  abstract: z.string().nullable().optional(),
  html_url: z.string(),
  publication_date: z.string(),
});

const responseSchema = z.object({
  results: z.array(documentSchema),
});

export type FederalRegisterDocument = z.infer<typeof documentSchema>;

export function buildFederalRegisterUrl(): URL {
  const url = new URL(API_URL);
  const params = new URLSearchParams();
  params.append("conditions[agencies][]", "federal-motor-carrier-safety-administration");
  params.append("conditions[type][]", "RULE");
  params.append("conditions[type][]", "PRORULE");
  params.set("order", "newest");
  params.set("per_page", "20");
  for (const field of ["document_number", "title", "type", "abstract", "html_url", "publication_date"]) {
    params.append("fields[]", field);
  }
  url.search = params.toString();
  return url;
}

/** Pure normalization - unit-tested against fixtures, no network. */
export function documentToSignal(doc: FederalRegisterDocument, observedAt: string): PressureSignal {
  const topics = matchTrackedTopics(`${doc.title} ${doc.abstract ?? ""}`);
  const onTrackedTopic = topics.includes("regulation") || topics.length > 0;
  const isFinalRule = doc.type === "RULE";
  const magnitude = isFinalRule ? (onTrackedTopic ? 0.9 : 0.4) : onTrackedTopic ? 0.6 : 0.3;
  const topic = topics[0] ?? "regulation";
  return {
    watcherKey: FEDERAL_REGISTER_WATCHER_KEY,
    kind: isFinalRule ? "federal_rule_final" : "federal_rule_proposed",
    topic,
    magnitude,
    summary: `${isFinalRule ? "Final rule" : "Proposed rule"} published ${doc.publication_date}: ${doc.title}`,
    items: [
      {
        title: doc.title,
        url: doc.html_url,
        publishedAt: doc.publication_date,
        summary: doc.abstract ?? null,
      },
    ],
    data: { documentNumber: doc.document_number, documentType: doc.type },
    dedupeKey: `federal_register:${doc.document_number}`,
    observedAt,
  };
}

export async function fetchFederalRegisterDocuments(
  fetchFn: typeof fetch = fetch,
): Promise<FederalRegisterDocument[]> {
  const res = await fetchFn(buildFederalRegisterUrl(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Federal Register API request failed: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Federal Register API response didn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.results;
}

export const federalRegisterWatcher: Watcher = {
  key: FEDERAL_REGISTER_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    try {
      const docs = await fetchFederalRegisterDocuments();
      const seen = new Set(Array.isArray(state.seenDocumentNumbers) ? (state.seenDocumentNumbers as string[]) : []);
      const fresh = docs.filter((doc) => !seen.has(doc.document_number));
      const observedAt = new Date().toISOString();
      return {
        watcherKey: FEDERAL_REGISTER_WATCHER_KEY,
        status: "ok",
        message: null,
        signals: fresh.map((doc) => documentToSignal(doc, observedAt)),
        state: {
          seenDocumentNumbers: [...seen, ...fresh.map((doc) => doc.document_number)].slice(-200),
        },
      };
    } catch (err) {
      return {
        watcherKey: FEDERAL_REGISTER_WATCHER_KEY,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error polling the Federal Register.",
        signals: [],
        state: {},
      };
    }
  },
};
