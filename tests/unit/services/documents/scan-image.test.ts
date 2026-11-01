import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createScanRendition } from "@/services/documents/scan-image";

/** Builds a real JPEG photo: gray surface, bright page inset, dark print lines. */
async function photoJpeg(fullBleed: boolean): Promise<Buffer> {
  const width = 400;
  const height = 300;
  const rgb = new Uint8Array(width * height * 3);
  const set = (x: number, y: number, v: number) => {
    const i = (y * width + x) * 3;
    rgb[i] = v;
    rgb[i + 1] = v;
    rgb[i + 2] = v;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) set(x, y, fullBleed ? 232 : 45);
  }
  const [px0, py0, px1, py1] = fullBleed ? [0, 0, width, height] : [35, 28, 365, 272];
  for (let y = py0; y < py1; y++) {
    for (let x = px0; x < px1; x++) set(x, y, 232);
  }
  for (let y = 90; y < 100; y++) {
    for (let x = 70; x < 320; x++) set(x, y, 25);
  }
  for (let y = 130; y < 138; y++) {
    for (let x = 70; x < 260; x++) set(x, y, 25);
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

async function decodeRaw(buffer: Buffer) {
  // .greyscale() so the raw decode reports the stored single channel -
  // a bare .raw() lets sharp expand the b-w PNG back to sRGB.
  const { data, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe("createScanRendition", () => {
  it("turns a page photo into a pure black-and-white scan, cropping to the page", async () => {
    const scan = await createScanRendition(await photoJpeg(false), "image/jpeg");
    expect(scan).not.toBeNull();

    const decoded = await decodeRaw(scan!);
    expect(decoded.channels).toBe(1);
    expect([...decoded.data].every((v) => v === 0 || v === 255)).toBe(true);
    // The page (330x244 inside a 400x300 photo) was detected and
    // flattened, so the scan is the page, not the whole photo.
    expect(decoded.width).toBeGreaterThanOrEqual(320);
    expect(decoded.width).toBeLessThanOrEqual(340);
    expect(decoded.height).toBeGreaterThanOrEqual(234);
    expect(decoded.height).toBeLessThanOrEqual(254);
    const blackCount = [...decoded.data].filter((v) => v === 0).length;
    expect(blackCount).toBeGreaterThan(500); // the print lines survived
  });

  it("keeps the source dimensions for a full-bleed page (no perspective to correct)", async () => {
    const scan = await createScanRendition(await photoJpeg(true), "image/jpeg");
    expect(scan).not.toBeNull();
    const decoded = await decodeRaw(scan!);
    expect(decoded.width).toBe(400);
    expect(decoded.height).toBe(300);
    expect([...decoded.data].every((v) => v === 0 || v === 255)).toBe(true);
  });

  it("returns null for an undecodable buffer instead of throwing", async () => {
    await expect(
      createScanRendition(Buffer.from("this is not an image"), "image/jpeg"),
    ).resolves.toBeNull();
  });

  it("returns null for content types the pipeline doesn't handle", async () => {
    await expect(createScanRendition(Buffer.from("%PDF-1.4"), "application/pdf")).resolves.toBeNull();
    await expect(createScanRendition(Buffer.from("heic-bytes"), "image/heic")).resolves.toBeNull();
  });
});
