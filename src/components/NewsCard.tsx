"use client";

// Shared design-system NewsCard + BrandedTile (spec §2.6 + owner
// ruling 2026-11-10: news must show images, never bare text rows).
// NewsCard is image-first: the story's own image when it has one, and
// the locked black-and-gold BrandedTile — "RL" monogram, "ROAD TO
// LEGACY" wordmark, topic label — when it genuinely has none OR when
// the image fails to load. No faked imagery: the tile says, by its
// design, that there is no photo.
import { useState, type ReactNode } from "react";

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
  // tile — the story never renders as a naked text row.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageSrc) && !imageFailed;
  return (
    <div className="news-card">
      {showImage ? (
        <div className="news-card-media">
          {/* eslint-disable-next-line @next/next/no-img-element -- story preview images are app-proxied thumbnails, not optimizable assets */}
          <img
            src={imageSrc!}
            alt={imageAlt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        </div>
      ) : (
        <BrandedTile topic={topic} />
      )}
      <div>
        <p className="news-card-headline">{headline}</p>
        {meta != null && <p className="news-card-meta">{meta}</p>}
        {children}
      </div>
    </div>
  );
}
