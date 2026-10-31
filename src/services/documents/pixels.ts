// Document scan pixel stage (docs/design/driver-mvp.md §8). Pure
// functions over a raw single-channel (grayscale) buffer, deliberately
// free of any image-library dependency so the whole stage is unit-
// testable without sharp: scan-image.ts decodes/encodes, everything
// that decides what the scan *looks like* happens here.
//
// Pipeline (enhanceScanPixels): percentile contrast stretch ->
// perspective correction when a document quad is confidently
// detectable -> adaptive threshold to true black-and-white.

export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Quad {
  /** Corners in image pixel coordinates, in reading order. */
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
}

/** Stretches the 1st–99th percentile range onto 0–255, in place. */
export function percentileStretch(image: GrayImage): void {
  const { data } = image;
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value]!++;

  const total = data.length;
  const lowTarget = total * 0.01;
  const highTarget = total * 0.99;
  let cumulative = 0;
  let low = 0;
  let high = 255;
  for (let i = 0; i < 256; i++) {
    cumulative += histogram[i]!;
    if (cumulative >= lowTarget) {
      low = i;
      break;
    }
  }
  cumulative = 0;
  for (let i = 255; i >= 0; i--) {
    cumulative += histogram[i]!;
    if (cumulative >= total - highTarget) {
      high = i;
      break;
    }
  }
  if (high <= low) return; // Flat image - nothing to stretch.

  const scale = 255 / (high - low);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min(255, Math.max(0, Math.round((data[i]! - low) * scale)));
  }
}

/** Classic Otsu threshold over a grayscale buffer. */
export function otsuThreshold(data: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value]!++;
  const total = data.length;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    weightBackground += histogram[i]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += i * histogram[i]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }
  return threshold;
}

/** Box-downscale by an integer factor (averaging), for detection work. */
export function downscaleGray(image: GrayImage, maxWidth: number): GrayImage & { scale: number } {
  const { data, width, height } = image;
  if (width <= maxWidth) return { data: new Uint8ClampedArray(data), width, height, scale: 1 };
  const factor = Math.ceil(width / maxWidth);
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const out = new Uint8ClampedArray(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          sum += data[(y * factor + dy) * width + (x * factor + dx)]!;
        }
      }
      out[y * outWidth + x] = Math.round(sum / (factor * factor));
    }
  }
  return { data: out, width: outWidth, height: outHeight, scale: factor };
}

/**
 * Largest 4-connected component of a boolean mask, as a pixel count
 * plus its points' convex hull (Andrew monotone chain). Returns null
 * for an empty mask.
 */
function largestComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): { area: number; hull: { x: number; y: number }[] } | null {
  const labels = new Int32Array(width * height).fill(-1);
  let bestLabel = -1;
  let bestArea = 0;
  let nextLabel = 0;
  const areas = new Map<number, number>();

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const label = nextLabel++;
    let area = 0;
    const stack = [start];
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop()!;
      area++;
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && mask[n] && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
    }
    areas.set(label, area);
    if (area > bestArea) {
      bestArea = area;
      bestLabel = label;
    }
  }
  if (bestLabel === -1) return null;

  const points: { x: number; y: number }[] = [];
  for (let idx = 0; idx < mask.length; idx++) {
    if (labels[idx] === bestLabel) points.push({ x: idx % width, y: Math.floor(idx / width) });
  }
  return { area: bestArea, hull: convexHull(points) };
}

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 1) return sorted;
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function quadArea(quad: Quad): number {
  const pts = [quad.tl, quad.tr, quad.br, quad.bl];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function angleDegrees(
  corner: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const v1 = { x: a.x - corner.x, y: a.y - corner.y };
  const v2 = { x: b.x - corner.x, y: b.y - corner.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (mag === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180) / Math.PI;
}

/**
 * Tries to find the document's four corners in a grayscale photo.
 * Returns null — a normal, expected outcome — unless every sanity
 * check in design §8.1 passes: the page (assumed lighter or darker
 * than its surroundings, decided by the border) forms one dominant
 * blob covering 35–97% of the frame, and its hull reduces to a
 * plausible rectangle that isn't already the whole frame.
 */
export function detectDocumentQuad(image: GrayImage): Quad | null {
  const small = downscaleGray(image, 256);
  const { data, width, height } = small;
  const threshold = otsuThreshold(data);

  // Polarity: the frame's border is the surroundings, not the page.
  // A mostly-dark border means the page is the bright region; a
  // mostly-bright border means the page is the dark region.
  let borderSum = 0;
  let borderCount = 0;
  for (let x = 0; x < width; x++) {
    borderSum += data[x]! + data[(height - 1) * width + x]!;
    borderCount += 2;
  }
  for (let y = 0; y < height; y++) {
    borderSum += data[y * width]! + data[y * width + width - 1]!;
    borderCount += 2;
  }
  const pageIsBright = borderSum / borderCount <= threshold;

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    mask[i] = (data[i]! > threshold) === pageIsBright ? 1 : 0;
  }

  const component = largestComponent(mask, width, height);
  if (!component) return null;
  const coverage = component.area / (width * height);
  if (coverage < 0.35 || coverage > 0.97) return null;
  if (component.hull.length < 4) return null;

  const bySum = (fn: (p: { x: number; y: number }) => number, pickMax: boolean) =>
    component.hull.reduce((best, p) => (pickMax ? (fn(p) > fn(best) ? p : best) : fn(p) < fn(best) ? p : best));
  const smallQuad: Quad = {
    tl: bySum((p) => p.x + p.y, false),
    br: bySum((p) => p.x + p.y, true),
    tr: bySum((p) => p.x - p.y, true),
    bl: bySum((p) => p.x - p.y, false),
  };

  // Quad must explain most of the blob - a blob with a bite taken out
  // of it (occluded corner, hand over the page) fails here.
  if (quadArea(smallQuad) < component.area * 0.75) return null;

  const corners: [keyof Quad, { x: number; y: number }, { x: number; y: number }][] = [
    ["tl", smallQuad.bl, smallQuad.tr],
    ["tr", smallQuad.tl, smallQuad.br],
    ["br", smallQuad.tr, smallQuad.bl],
    ["bl", smallQuad.br, smallQuad.tl],
  ];
  for (const [key, a, b] of corners) {
    const angle = angleDegrees(smallQuad[key], a, b);
    if (angle < 55 || angle > 125) return null;
  }

  // A quad hugging all four frame edges means the page already fills
  // the photo - warping would be an identity transform with resampling
  // loss, so call it "no correction needed" instead.
  const marginX = width * 0.03;
  const marginY = height * 0.03;
  const hugsFrame =
    smallQuad.tl.x < marginX &&
    smallQuad.tl.y < marginY &&
    smallQuad.br.x > width - marginX &&
    smallQuad.br.y > height - marginY;
  if (hugsFrame) return null;

  const s = small.scale;
  return {
    tl: { x: smallQuad.tl.x * s, y: smallQuad.tl.y * s },
    tr: { x: smallQuad.tr.x * s, y: smallQuad.tr.y * s },
    br: { x: smallQuad.br.x * s, y: smallQuad.br.y * s },
    bl: { x: smallQuad.bl.x * s, y: smallQuad.bl.y * s },
  };
}

/** Solves the 3x3 homography mapping src corners onto dst corners. */
function computeHomography(
  src: { x: number; y: number }[],
  dst: { x: number; y: number }[],
): number[] {
  // 8 equations, 8 unknowns (h[8] fixed at 1), Gaussian elimination.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(rows[r]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = r;
    }
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const divisor = rows[col]![col]!;
    if (Math.abs(divisor) < 1e-12) throw new Error("Degenerate document quad.");
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = rows[r]![col]! / divisor;
      for (let c = col; c < 9; c++) rows[r]![c]! -= factor * rows[col]![c]!;
    }
  }
  const h = rows.map((row, i) => row[8]! / row[i]!);
  h.push(1);
  return h;
}

function sampleBilinear(image: GrayImage, x: number, y: number): number {
  const { data, width, height } = image;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = data[y0 * width + x0]! * (1 - fx) + data[y0 * width + x1]! * fx;
  const bottom = data[y1 * width + x0]! * (1 - fx) + data[y1 * width + x1]! * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Warps the photographed quad flat into its own rectangle. */
export function warpPerspective(image: GrayImage, quad: Quad): GrayImage {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const outWidth = Math.max(2, Math.round(Math.max(dist(quad.tl, quad.tr), dist(quad.bl, quad.br))));
  const outHeight = Math.max(
    2,
    Math.round(Math.max(dist(quad.tl, quad.bl), dist(quad.tr, quad.br))),
  );
  const dst = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const inverse = computeHomography(dst, [quad.tl, quad.tr, quad.br, quad.bl]);

  const out = new Uint8ClampedArray(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const w = inverse[6]! * x + inverse[7]! * y + inverse[8]!;
      const sx = (inverse[0]! * x + inverse[1]! * y + inverse[2]!) / w;
      const sy = (inverse[3]! * x + inverse[4]! * y + inverse[5]!) / w;
      out[y * outWidth + x] = Math.round(sampleBilinear(image, sx, sy));
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * Binarizes via a local mean threshold (integral image): a pixel is
 * black when it's meaningfully darker than its neighborhood, which
 * keeps text readable under the uneven lighting of a cab photo where
 * a single global threshold would black out the shadowed half.
 */
export function adaptiveThreshold(image: GrayImage, windowSize: number, ratio: number): GrayImage {
  const { data, width, height } = image;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += data[y * width + x]!;
      integral[(y + 1) * (width + 1) + (x + 1)] =
        integral[y * (width + 1) + (x + 1)]! + rowSum;
    }
  }
  const sumAt = (x: number, y: number) => integral[y * (width + 1) + x]!;

  const half = Math.floor(windowSize / 2);
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half + 1);
      const sum = sumAt(x1, y1) - sumAt(x0, y1) - sumAt(x1, y0) + sumAt(x0, y0);
      const mean = sum / ((x1 - x0) * (y1 - y0));
      out[y * width + x] = data[y * width + x]! < mean * ratio ? 0 : 255;
    }
  }
  return { data: out, width, height };
}

export interface EnhanceResult extends GrayImage {
  perspectiveApplied: boolean;
}

/** The full scan look: stretch -> optional warp -> B&W. */
export function enhanceScanPixels(image: GrayImage): EnhanceResult {
  const stretched: GrayImage = {
    data: new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
  };
  percentileStretch(stretched);

  let working = stretched;
  let perspectiveApplied = false;
  const quad = detectDocumentQuad(stretched);
  if (quad) {
    try {
      working = warpPerspective(stretched, quad);
      perspectiveApplied = true;
    } catch {
      working = stretched; // Degenerate quad - threshold the photo as-is.
    }
  }

  const windowSize = Math.min(51, Math.max(15, Math.round(working.width / 24) | 1));
  const bw = adaptiveThreshold(working, windowSize, 0.9);
  return { ...bw, perspectiveApplied };
}
