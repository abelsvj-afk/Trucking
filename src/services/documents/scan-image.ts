// Document scan rendition (docs/design/driver-mvp.md §8.1). Decodes
// and encodes with sharp - already in the shipped tree as Next.js's
// own image dependency, promoted to a declared dependency at the same
// version (see the design note's Dependency Rule justification). All
// pixel decisions live in pixels.ts; this file is only the codec
// boundary plus the size cap.
//
// Returns null - never throws - when no scan can be produced (a
// corrupt file, an undecodable format). A missing scan is a normal
// state on the document row, not an upload failure.

import sharp from "sharp";
import { enhanceScanPixels, type GrayImage } from "./pixels";

// Bounds CPU/memory on a phone photo while staying far above what
// OCR needs to read printed text.
const MAX_EDGE_PX = 2500;

export const SCANNABLE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function createScanRendition(
  input: Buffer,
  contentType: string,
): Promise<Buffer | null> {
  if (!SCANNABLE_CONTENT_TYPES.has(contentType)) return null;
  try {
    const { data, info } = await sharp(input)
      .rotate() // EXIF orientation - phone photos arrive sideways otherwise.
      .greyscale()
      .resize({
        width: MAX_EDGE_PX,
        height: MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const gray: GrayImage = {
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height,
    };
    const enhanced = enhanceScanPixels(gray);

    return await sharp(enhanced.data, {
      raw: { width: enhanced.width, height: enhanced.height, channels: 1 },
    })
      // Without this, sharp treats the single-channel raw input as
      // sRGB and writes a 3-channel PNG - same picture, triple the
      // size. The scan is black-and-white; store it that way.
      .toColourspace("b-w")
      .png()
      .toBuffer();
  } catch (err) {
    // Detail stays server-side; the caller just records "no scan".
    console.error("Document scan enhancement failed:", err);
    return null;
  }
}
