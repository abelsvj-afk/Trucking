import { describe, expect, it } from "vitest";
import {
  adaptiveThreshold,
  detectDocumentQuad,
  enhanceScanPixels,
  percentileStretch,
  warpPerspective,
  type GrayImage,
  type Quad,
} from "@/services/documents/pixels";

function makeImage(width: number, height: number, fill: number): GrayImage {
  return { data: new Uint8ClampedArray(width * height).fill(fill), width, height };
}

function fillRect(img: GrayImage, x0: number, y0: number, x1: number, y1: number, value: number) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) img.data[y * img.width + x] = value;
  }
}

/** Fills a convex quad (corners in reading order) via half-plane tests. */
function fillQuad(img: GrayImage, quad: Quad, value: number) {
  const corners = [quad.tl, quad.tr, quad.br, quad.bl];
  const cross = (a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }) =>
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = { x, y };
      const signs = corners.map((c, i) => Math.sign(cross(c, corners[(i + 1) % 4]!, p)));
      if (signs.every((s) => s >= 0) || signs.every((s) => s <= 0)) {
        img.data[y * img.width + x] = value;
      }
    }
  }
}

describe("percentileStretch", () => {
  it("stretches a dim, low-contrast image onto the full range", () => {
    const img = makeImage(10, 10, 100);
    fillRect(img, 0, 0, 5, 10, 60); // enough pixels at both ends to pass the 1%/99% cuts
    fillRect(img, 5, 0, 10, 10, 140);
    percentileStretch(img);
    const values = [...img.data];
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(255);
  });

  it("leaves a flat image alone", () => {
    const img = makeImage(8, 8, 120);
    percentileStretch(img);
    expect([...img.data].every((v) => v === 120)).toBe(true);
  });
});

describe("adaptiveThreshold", () => {
  it("reads dark marks on both a bright half and a shadowed half", () => {
    // Left half lit (paper 225), right half in shadow (paper 130) -
    // a single global threshold would lose one side or the other.
    const img = makeImage(120, 40, 225);
    fillRect(img, 60, 0, 120, 40, 130);
    fillRect(img, 10, 15, 40, 20, 40); // "text" on the lit half
    fillRect(img, 80, 15, 110, 20, 30); // "text" on the shadowed half

    const out = adaptiveThreshold(img, 25, 0.9);

    expect(out.data[17 * 120 + 25]).toBe(0); // lit-half text is black
    expect(out.data[17 * 120 + 95]).toBe(0); // shadowed-half text is black
    expect(out.data[5 * 120 + 25]).toBe(255); // lit paper is white
    expect(out.data[5 * 120 + 95]).toBe(255); // shadowed paper is white
    expect([...out.data].every((v) => v === 0 || v === 255)).toBe(true);
  });
});

const SKEWED_QUAD: Quad = {
  tl: { x: 45, y: 35 },
  tr: { x: 168, y: 22 },
  br: { x: 182, y: 138 },
  bl: { x: 28, y: 148 },
};

function skewedPhoto(): GrayImage {
  const img = makeImage(200, 160, 40); // dark surface
  fillQuad(img, SKEWED_QUAD, 235); // bright page, photographed at an angle
  fillRect(img, 70, 60, 140, 70, 30); // a printed line on the page
  fillRect(img, 70, 85, 120, 92, 30);
  return img;
}

describe("detectDocumentQuad", () => {
  it("finds the corners of a page photographed at an angle", () => {
    const quad = detectDocumentQuad(skewedPhoto());
    expect(quad).not.toBeNull();
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.abs(a.x - b.x) <= 6 && Math.abs(a.y - b.y) <= 6;
    expect(near(quad!.tl, SKEWED_QUAD.tl)).toBe(true);
    expect(near(quad!.tr, SKEWED_QUAD.tr)).toBe(true);
    expect(near(quad!.br, SKEWED_QUAD.br)).toBe(true);
    expect(near(quad!.bl, SKEWED_QUAD.bl)).toBe(true);
  });

  it("returns null when the page fills the whole frame (nothing to correct)", () => {
    const img = makeImage(120, 90, 235);
    fillRect(img, 10, 20, 110, 25, 30);
    fillRect(img, 10, 40, 90, 45, 30);
    expect(detectDocumentQuad(img)).toBeNull();
  });

  it("returns null when there is no dominant page-sized region", () => {
    const img = makeImage(100, 100, 128);
    fillRect(img, 40, 40, 55, 55, 240); // a small bright patch, not a page
    expect(detectDocumentQuad(img)).toBeNull();
  });
});

describe("warpPerspective", () => {
  it("flattens the quad into a rectangle of the quad's own size", () => {
    const warped = warpPerspective(skewedPhoto(), SKEWED_QUAD);
    // Longest top/bottom edge ~154px, longest side edge ~117px.
    expect(warped.width).toBeGreaterThanOrEqual(148);
    expect(warped.width).toBeLessThanOrEqual(160);
    expect(warped.height).toBeGreaterThanOrEqual(111);
    expect(warped.height).toBeLessThanOrEqual(123);
    // The middle of the flattened page is page-bright, not background.
    const mid = warped.data[Math.floor(warped.height / 2) * warped.width + Math.floor(warped.width / 2)]!;
    expect(mid).toBeGreaterThan(180);
  });
});

describe("enhanceScanPixels", () => {
  it("produces pure black-and-white at the source dimensions for a square-on photo", () => {
    const img = makeImage(120, 90, 230);
    fillRect(img, 10, 20, 110, 25, 35);
    fillRect(img, 10, 40, 90, 45, 35);
    const before = new Uint8ClampedArray(img.data);

    const out = enhanceScanPixels(img);

    expect(out.perspectiveApplied).toBe(false);
    expect(out.width).toBe(120);
    expect(out.height).toBe(90);
    expect([...out.data].every((v) => v === 0 || v === 255)).toBe(true);
    expect(out.data[22 * 120 + 50]).toBe(0); // the printed line survived as black
    expect(out.data[5 * 120 + 60]).toBe(255); // blank paper is white
    expect(img.data).toEqual(before); // caller's buffer untouched
  });

  it("corrects perspective on an angled photo and keeps the print black", () => {
    const out = enhanceScanPixels(skewedPhoto());
    expect(out.perspectiveApplied).toBe(true);
    expect([...out.data].every((v) => v === 0 || v === 255)).toBe(true);
    const blackCount = [...out.data].filter((v) => v === 0).length;
    expect(blackCount).toBeGreaterThan(200); // the two printed lines
  });
});
