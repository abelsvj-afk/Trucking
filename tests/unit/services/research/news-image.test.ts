import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IMAGE_MAX_EDGE, loadNewsImage, normalizeImage, resetNewsImageState } from "@/services/research/news-image";

const SIGNAL = "11111111-1111-4111-8111-111111111111";

function fakeDb(row: { items?: unknown } | null, error: unknown = null) {
  const calls: { table: string; col: string; val: unknown }[] = [];
  const client = {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => (calls.push({ table, col, val }), q),
        maybeSingle: async () => ({ data: row, error }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const goodItems = [
  { title: "a", url: "https://x.example/a", imageUrl: "https://cdn.x.example/a.jpg" },
  { title: "b", url: "https://x.example/b" },
];

beforeEach(() => resetNewsImageState());

describe("loadNewsImage - lookup rules", () => {
  it("serves a re-encoded image for a stored signal's item, looked up by id", async () => {
    const { client, calls } = fakeDb({ items: goodItems });
    const fetchImage = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from("raw"), contentType: "image/jpeg" }));
    const normalize = vi.fn(async () => Buffer.from("clean"));
    const r = await loadNewsImage(client, SIGNAL, 0, { fetchImage, normalize });
    expect(r).toEqual({ ok: true, bytes: Buffer.from("clean"), contentType: "image/jpeg" });
    expect(calls).toEqual([{ table: "research_signals", col: "id", val: SIGNAL }]);
    expect(fetchImage).toHaveBeenCalledWith("https://cdn.x.example/a.jpg");
    // what is served is the RE-ENCODED output, never the fetched bytes
    expect(normalize).toHaveBeenCalledWith(Buffer.from("raw"));
  });

  it("404 when the signal isn't visible to the caller (another company's row looks identical to a missing one)", async () => {
    const { client } = fakeDb(null);
    const fetchImage = vi.fn();
    expect(await loadNewsImage(client, SIGNAL, 0, { fetchImage })).toMatchObject({ ok: false, status: 404 });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("404 for an item with no image, an out-of-range index, or items that aren't an array", async () => {
    const fetchImage = vi.fn();
    expect(await loadNewsImage(fakeDb({ items: goodItems }).client, SIGNAL, 1, { fetchImage })).toMatchObject({ status: 404 });
    expect(await loadNewsImage(fakeDb({ items: goodItems }).client, SIGNAL, 7, { fetchImage })).toMatchObject({ status: 404 });
    expect(await loadNewsImage(fakeDb({ items: "nope" }).client, SIGNAL, 0, { fetchImage })).toMatchObject({ status: 404 });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("re-validates the stored URL: a tampered row pointing at a private address is never fetched", async () => {
    const fetchImage = vi.fn();
    for (const imageUrl of ["https://169.254.169.254/x.jpg", "http://cdn.x.example/a.jpg", "https://localhost/a.jpg"]) {
      const r = await loadNewsImage(fakeDb({ items: [{ imageUrl }] }).client, SIGNAL, 0, { fetchImage });
      expect(r).toMatchObject({ ok: false, status: 404, reason: "no-image" });
    }
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("a database error is a 502 with no detail", async () => {
    const r = await loadNewsImage(fakeDb(null, { message: "secret detail" }).client, SIGNAL, 0, {});
    expect(r).toEqual({ ok: false, status: 502, reason: "lookup-failed" });
  });
});

describe("loadNewsImage - failures, cache, load", () => {
  it("a fetch failure is a 502 with only a short reason (the banner falls back to its tile)", async () => {
    const fetchImage = vi.fn(async () => ({ ok: false as const, reason: "blocked" as const }));
    const r = await loadNewsImage(fakeDb({ items: goodItems }).client, SIGNAL, 0, { fetchImage });
    expect(r).toEqual({ ok: false, status: 502, reason: "fetch-blocked" });
  });

  it("an image the decoder refuses is not served", async () => {
    const fetchImage = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from("x"), contentType: "image/jpeg" }));
    const normalize = vi.fn(async () => {
      throw new Error("corrupt");
    });
    expect(await loadNewsImage(fakeDb({ items: goodItems }).client, SIGNAL, 0, { fetchImage, normalize })).toEqual({
      ok: false, status: 502, reason: "undecodable",
    });
  });

  it("caches by URL so a repeat open doesn't hit the publisher again, and expires", async () => {
    let now = 1_000_000;
    const fetchImage = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from("raw"), contentType: "image/jpeg" }));
    const normalize = async () => Buffer.from("clean");
    const db = fakeDb({ items: goodItems }).client;
    await loadNewsImage(db, SIGNAL, 0, { fetchImage, normalize, now: () => now });
    await loadNewsImage(db, SIGNAL, 0, { fetchImage, normalize, now: () => now + 60_000 });
    expect(fetchImage).toHaveBeenCalledTimes(1);
    await loadNewsImage(db, SIGNAL, 0, { fetchImage, normalize, now: () => now + 31 * 60_000 });
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent publisher fetches: the fifth at once gets 503, and the slot frees afterwards", async () => {
    const releases: (() => void)[] = [];
    const fetchImage = vi.fn(
      () =>
        new Promise<{ ok: true; bytes: Buffer; contentType: string }>((resolve) => {
          releases.push(() => resolve({ ok: true, bytes: Buffer.from("raw"), contentType: "image/jpeg" }));
        }),
    );
    const normalize = async () => Buffer.from("clean");
    const urls = [0, 1, 2, 3, 4].map((n) => ({ imageUrl: `https://cdn.x.example/${n}.jpg` }));
    const db = fakeDb({ items: urls }).client;
    const first = [0, 1, 2, 3].map((i) => loadNewsImage(db, SIGNAL, i, { fetchImage, normalize }));
    await new Promise((r) => setTimeout(r, 5));
    expect(await loadNewsImage(db, SIGNAL, 4, { fetchImage, normalize })).toMatchObject({ ok: false, status: 503, reason: "busy" });
    releases.forEach((release) => release());
    await Promise.all(first);
    const after = loadNewsImage(db, SIGNAL, 4, { fetchImage, normalize });
    await new Promise((r) => setTimeout(r, 5));
    releases.at(-1)!();
    expect(await after).toMatchObject({ ok: true });
  });
});

describe("normalizeImage - the real re-encoder (sharp)", () => {
  it("shrinks an oversized photo to the bounded size and returns a fresh JPEG", async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#336699" } }).png().toBuffer();
    const out = await normalizeImage(big);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(IMAGE_MAX_EDGE);
    expect(out.length).toBeLessThan(big.length);
  });

  it("never enlarges a small image", async () => {
    const small = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#aa2222" } }).jpeg().toBuffer();
    const meta = await sharp(await normalizeImage(small)).metadata();
    expect([meta.width, meta.height]).toEqual([120, 80]);
  });

  it("strips metadata (EXIF) from what it serves", async () => {
    const withExif = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#222" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret owner string", Artist: "someone" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await normalizeImage(withExif);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
    expect(out.toString("latin1")).not.toContain("secret owner string");
  });

  it("rejects bytes that aren't a decodable image", async () => {
    await expect(normalizeImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).rejects.toThrow();
    await expect(normalizeImage(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]))).rejects.toThrow();
  });
});
