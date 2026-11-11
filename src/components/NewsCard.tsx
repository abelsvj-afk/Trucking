"use client";

// Shared design-system NewsCard + BrandedTile (spec §2.6 + owner
// ruling 2026-11-10: news must show images, never bare text rows).
// NewsCard is image-first: the story's own image when it has one, and
// the locked black-and-gold BrandedTile — "RL" monogram, "ROAD TO
// LEGACY" wordmark, topic label — when it genuinely has none OR when
// the image fails to load. No faked imagery: the tile says, by its
// design, that there is no photo.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function BrandedTile({ topic }: { topic?: string }) {
  return (
    <div className="branded-tile" aria-hidden="true">
      <span className="branded-tile-mono">RL</span>
      <span className="branded-tile-word">ROAD TO LEGACY</span>
      {topic ? <span className="branded-tile-topic">{topic}</span> : null}
    </div>
  );
}

export default function NewsCard({
  headline,
  meta,
  imageSrc,
  imageAlt = "",
  topic,
  children,
}: {
  headline: ReactNode;
  /** Source / age line under the headline, e.g. "Federal Register · 2h ago". */
  meta?: ReactNode;
  imageSrc?: string | null;
  imageAlt?: string;
  /** Topic label shown on the branded fallback tile. */
  topic?: string;
  children?: ReactNode;
}) {
  // An image that errors (the briefing-image endpoint 404s when the
  // cited article has no usable preview) falls back to the branded
  // tile — the story never renders as a naked text row. The failure is
  // keyed to the src it belongs to, so the banner's rotation (a new
  // story in the same card slot) never inherits the last story's
  // failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const showImage = Boolean(imageSrc) && failedSrc !== imageSrc;
  // V78 live-check defect 1: an <img> that failed BEFORE React attached
  // the onError handler never fires it — the endpoints fetch the
  // publisher server-side (slow), and a cached failure can settle
  // before hydration wires the handler, leaving the frame a blank
  // white slot forever. On mount (and on every src change) read the
  // settled state directly: complete with zero natural width IS a
  // failed image, so it swaps to the tile exactly as an error would.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      setFailedSrc(imageSrc ?? null);
    }
  }, [imageSrc]);
  return (
    <div className="news-card">
      {showImage ? (
        <div className="news-card-media">
          {/* eslint-disable-next-line @next/next/no-img-element -- story preview images are app-proxied thumbnails, not optimizable assets */}
          <img
            ref={imgRef}
            src={imageSrc!}
            alt={imageAlt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(imageSrc ?? null)}
          />
        </div>
      ) : (
        <BrandedTile topic={topic} />
      )}
      <div className="news-card-body">
        <p className="news-card-headline">{headline}</p>
        {meta != null && <p className="news-card-meta">{meta}</p>}
        {children}
      </div>
    </div>
  );
}
