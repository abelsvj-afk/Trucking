// Briefing-image service (owner request 2026-11-07: research briefings
// get imagery "according to whatever it's reporting on"). SERVER ONLY.
//
// A briefing stores no image of its own - its findings cite article
// URLs. The honest image for a finding is the publisher's own preview
// image (og:image / twitter:image) of the very article that finding
// cites: drawn from that section's own reporting, never a stock photo,
// never generated, never a substitute. Resolution happens on demand:
//   1. RLS-scoped lookup of the stored briefing -> finding's source_url
//      (the browser names a briefing id + finding index, never a URL);
//   2. the article page is fetched server-side through the SSRF-safe
//      page fetcher (lib/safe-image-fetch.ts) - the HTML is untrusted
//      data and is only mined for one meta-tag URL, never rendered;
//   3. that image URL is re-validated and then fetched + RE-ENCODED
//      through the exact news-image pipeline (serveValidatedImageUrl),
//      so the original bytes never reach the phone.
// Any step that can't produce the article's own image is a 404: the
// Research page renders that finding with no image, cleanly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPublicPage, validateImageUrl, type FetchPageResult } from "@/lib/safe-image-fetch";
import { serveValidatedImageUrl, type NewsImageDeps, type NewsImageResult } from "@/services/research/news-image";

export type { NewsImageResult };

export interface BriefingImageDeps extends NewsImageDeps {
  fetchPage?: (url: string) => Promise<FetchPageResult>;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Pull the publisher's preview-image URL out of an article page's HTML:
 * og:image (either attribute order), then twitter:image. Returns an
 * absolute, policy-validated https URL or null. The HTML is untrusted -
 * this reads one attribute value and nothing else.
 */
export function extractArticleImageUrl(html: string, pageUrl: string): string | null {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const keyed =
      /\bproperty\s*=\s*["']og:image(?::secure_url)?["']/i.test(tag) ||
      /\bname\s*=\s*["']twitter:image(?::src)?["']/i.test(tag);
    if (!keyed) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!content) continue;
    let resolved: URL;
    try {
      resolved = new URL(decodeHtmlEntities(content.trim()), pageUrl);
    } catch {
      continue;
    }
    const checked = validateImageUrl(resolved.toString());
    if (checked) return checked.toString();
  }
  return null;
}

export async function loadBriefingImage(
  supabase: SupabaseClient,
  briefingId: string,
  index: number,
  deps: BriefingImageDeps = {},
): Promise<NewsImageResult> {
  const fetchPage = deps.fetchPage ?? ((url: string) => fetchPublicPage(url));

  // RLS scopes this to briefings the caller may read; a missing row and
  // another company's row look identical.
  const { data, error } = await supabase
    .from("research_briefings")
    .select("findings")
    .eq("id", briefingId)
    .maybeSingle();
  if (error) return { ok: false, status: 502, reason: "lookup-failed" };
  const findings = (data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) return { ok: false, status: 404, reason: "not-found" };
  const sourceUrl = (findings[index] as { source_url?: unknown } | undefined)?.source_url;
  if (typeof sourceUrl !== "string" || validateImageUrl(sourceUrl) === null) {
    return { ok: false, status: 404, reason: "no-image" };
  }

  const page = await fetchPage(sourceUrl);
  if (!page.ok) return { ok: false, status: 404, reason: "no-image" };
  const imageUrl = extractArticleImageUrl(page.html, page.finalUrl);
  if (!imageUrl) return { ok: false, status: 404, reason: "no-image" };

  return serveValidatedImageUrl(imageUrl, deps);
}
