// @vitest-environment jsdom
// V78 live-check fix, Defect 1: a news image that fails BEFORE React
// attaches its onError handler (the Home banner is client-rendered from
// an API payload, but the image endpoints are slow — they fetch the
// publisher server-side — and a cached/failed response can settle
// before hydration wires the handler) must still swap to the branded
// tile. A real browser exposes that settled failure as
// img.complete === true && img.naturalWidth === 0; jsdom never loads
// images at all, so the test models the browser's settled states on
// the prototype: "complete" says the load finished, and naturalWidth
// says whether anything decodable arrived.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import NewsCard from "@/components/NewsCard";

function settledImage(naturalWidth: number): () => void {
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => naturalWidth,
  });
  return () => {
    delete (HTMLImageElement.prototype as { complete?: unknown }).complete;
    delete (HTMLImageElement.prototype as { naturalWidth?: unknown }).naturalWidth;
  };
}

afterEach(() => cleanup());

describe("NewsCard image fallback (v78 defect 1)", () => {
  it("swaps to the branded tile when the image already failed before the error handler could attach", () => {
    const restore = settledImage(0);
    try {
      const { container } = render(
        <NewsCard headline="Chip makers rally" imageSrc="/api/v1/news-image?signal=x&i=0" topic="Tech" />,
      );
      expect(container.querySelector(".news-card-media img")).toBeNull();
      const tile = container.querySelector(".branded-tile");
      expect(tile).toBeTruthy();
      expect(tile!.textContent).toContain("RL");
      expect(tile!.textContent).toContain("ROAD TO LEGACY");
    } finally {
      restore();
    }
  });

  it("keeps the image when it has actually loaded (settled with naturalWidth > 0)", () => {
    const restore = settledImage(320);
    try {
      const { container } = render(
        <NewsCard headline="Diesel eases" imageSrc="/api/v1/news-image?signal=y&i=0" topic="Fuel" />,
      );
      expect(container.querySelector(".news-card-media img")).toBeTruthy();
      expect(container.querySelector(".branded-tile")).toBeNull();
    } finally {
      restore();
    }
  });
});
