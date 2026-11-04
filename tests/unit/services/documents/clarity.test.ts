// UH-13 regression tests (union fix round): advisory blur metric.
import { describe, expect, it } from "vitest";
import { isBlurryScore, laplacianVariance, type GrayImage } from "@/services/documents/pixels";

function img(data: number[], w: number, h: number): GrayImage {
  return { data: new Uint8ClampedArray(data), width: w, height: h };
}

describe("UH-13: laplacian variance separates sharp from blurry", () => {
  it("a flat (blurry) image scores ~0 and is flagged blurry; a checkerboard scores high", () => {
    const flat = img(new Array(25).fill(128), 5, 5);
    expect(laplacianVariance(flat)).toBe(0);
    const board: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) board.push((x + y) % 2 === 0 ? 0 : 255);
    const sharp = laplacianVariance(img(board, 8, 8));
    expect(sharp).toBeGreaterThan(1000);
    expect(isBlurryScore(sharp)).toBe(false);
    expect(isBlurryScore(5)).toBe(true);
  });
});
