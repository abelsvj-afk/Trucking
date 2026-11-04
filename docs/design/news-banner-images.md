# Image-led news banner — design (not built; needs the owner's decisions)

Status: DESIGN ONLY, 2026-11-04. The owner wants a rotating, image-led news
strip on Home. Today `NewsBanner` is text-only by design: its data
(`ResearchBriefing` / `ResearchSignal`) has no image field, and the builder
caps the rotation at five items (two signals). This document is the contract
to build against once the decisions in §5 are made. Nothing here is
implemented; building a fetch-and-serve image path without these decisions
would add a server-side request forgery surface and a tracking leak.

## 1. What the owner sees

A larger carousel: a prominent source image, headline, source name and
timestamp, tap-through to the article, a queue deeper than five, and a clean
fallback (no image → a topic tile, never a broken image or a stock photo
pretending to be the story). Parked screens only; honors reduced motion.

## 2. Where images can honestly come from

- **GDELT article list** already feeds the research engine; its article
  records carry a `socialimage` URL (the publisher's own preview image). Free.
- **Research briefing sources** carry article URLs but no image today.
- Nothing may be invented, generated, or substituted for a real article image.
  An article with no image gets the topic tile.

## 3. Data contract (additive migration, later number than 00059)

`research_signals.items[]` and a new `research_briefing_images` (or an
`image_url`/`image_source` pair on the source objects): `image_url` (https only,
publisher-owned), `image_checked_at`, `image_status`
(`ok | missing | rejected`), `width/height` when known. The banner builder
gains an `image` field per item and a larger cap (default 12; at most 3 per
topic so one story can't take the strip).

## 4. Safety requirements (non-negotiable)

1. **Never hot-link a publisher image from the app's browser.** That tells every
   publisher the owner's IP, user agent and when he opened the app. Images are
   fetched server-side by the research engine at write time and served from the
   app's own storage, or through a proxy route.
2. **SSRF-safe fetch:** https only; resolve DNS and refuse private, loopback,
   link-local and metadata addresses (and re-check after redirects, max 2);
   allow only `image/jpeg|png|webp`; hard size cap (e.g. 1.5 MB) and time cap;
   strip metadata; re-encode to a bounded size; never follow instructions or
   markup in what is fetched (the content is untrusted).
3. Per-company RLS on any stored image rows; storage objects under the company
   prefix; signed URLs only.
4. Failure is visible: an unreadable/oversized/blocked image becomes the topic
   tile and is logged in the run's skip reasons, like the watchers do.

## 5. Decisions needed from the owner

1. Image source: publisher `socialimage` via GDELT (free), or text-only plus a
   topic tile (zero privacy surface). Recommendation: topic tiles first (ship
   the carousel and the larger queue without images), add publisher images
   second behind the safety requirements above.
2. Store images ourselves (storage cost, simple privacy) or proxy on demand.
   Recommendation: store at write time, in the existing documents bucket's
   company prefix.
3. Whether a news tap opens the article in the app browser or the system one.

## 6. Build order once decided

(a) larger queue + topic tiles + transition (no images, no new surface);
(b) migration + engine-side safe fetch + storage; (c) banner image rendering;
each with a two-company test and an SSRF test set (private IPs, redirects to
private hosts, oversize, wrong type, slow body).
