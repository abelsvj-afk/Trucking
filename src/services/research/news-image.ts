// News-image service (docs/design/news-banner-images.md). SERVER ONLY.
// Given a stored signal and an item index, it fetches the publisher's
// image on the SERVER (so the publisher never learns anything about the
// owner's phone), through the SSRF-safe fetcher, then RE-ENCODES it with
// sharp: a bounded size, metadata stripped, always a fresh JPEG. The
// original bytes are never served, so a malformed or hostile file never
// reaches the phone. The browser only ever asks us for /api/v1/news-image
// by signal id + index - never for an arbitrary URL.

import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { fetchPublicImage, validateImageUrl, type FetchFailureReason } from "@/lib/safe-image-fetch";

export const IMAGE_MAX_EDGE = 640;
const MAX_INPUT_PIXELS = 24_000_000;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 40;
const MAX_CONCURRENT = 4;

export async function normalizeImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate()
    .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
}

export type NewsImageResult =
  | { ok: true; bytes: Buffer; contentType: "image/jpeg" }
  | { ok: false; status: 404 | 502 | 503; reason: string };

export interface NewsImageDeps {
  fetchImage?: typeof fetchPublicImage;
  normalize?: (bytes: Buffer) => Promise<Buffer>;
  now?: () => number;
}

// A small in-process cache keeps the phone's repeat opens (and the
// rotation) from re-fetching from the publisher each time.
const cache = new Map<string, { at: number; bytes: Buffer }>();
let inFlight = 0;

export function resetNewsImageState(): void {
  cache.clear();
  inFlight = 0;
}

function cacheGet(url: string, now: number): Buffer | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return hit.bytes;
}

function cacheSet(url: string, bytes: Buffer, now: number): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, { at: now, bytes });
}

export async function loadNewsImage(
  supabase: SupabaseClient,
  signalId: string,
  index: number,
  deps: NewsImageDeps = {},
): Promise<NewsImageResult> {
  const fetchImage = deps.fetchImage ?? fetchPublicImage;
  const normalize = deps.normalize ?? normalizeImage;
  const now = (deps.now ?? Date.now)();

  // RLS scopes this to signals the caller may read (his company's, or the
  // global ones); a missing row and another company's row look identical.
  const { data, error } = await supabase.from("research_signals").select("items").eq("id", signalId).maybeSingle();
  if (error) return { ok: false, status: 502, reason: "lookup-failed" };
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { ok: false, status: 404, reason: "not-found" };
  const imageUrl = (items[index] as { imageUrl?: unknown } | undefined)?.imageUrl;
  if (typeof imageUrl !== "string" || validateImageUrl(imageUrl) === null) {
    return { ok: false, status: 404, reason: "no-image" };
  }

  const cached = cacheGet(imageUrl, now);
  if (cached) return { ok: true, bytes: cached, contentType: "image/jpeg" };

  if (inFlight >= MAX_CONCURRENT) return { ok: false, status: 503, reason: "busy" };
  inFlight += 1;
  try {
    const fetched = await fetchImage(imageUrl);
    if (!fetched.ok) return { ok: false, status: 502, reason: failureLabel(fetched.reason) };
    let bytes: Buffer;
    try {
      bytes = await normalize(fetched.bytes);
    } catch {
      // The decoder refused it: a corrupt or hostile file is simply not served.
      return { ok: false, status: 502, reason: "undecodable" };
    }
    cacheSet(imageUrl, bytes, now);
    return { ok: true, bytes, contentType: "image/jpeg" };
  } finally {
    inFlight -= 1;
  }
}

function failureLabel(reason: FetchFailureReason): string {
  return `fetch-${reason}`;
}
