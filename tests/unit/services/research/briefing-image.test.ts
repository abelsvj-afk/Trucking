import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractArticleImageUrl, loadBriefingImage } from "@/services/research/briefing-image";
import { resetNewsImageState } from "@/services/research/news-image";

const BRIEFING = "22222222-2222-4222-8222-222222222222";

function fakeDb(row: { findings?: unknown } | null, error: unknown = null) {
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

const findings = [
  { claim: "Diesel fell", source_title: "EIA weekly", source_url: "https://pub.example/diesel-story" },
  { claim: "Rule proposed", source_title: "FMCSA notice", source_url: "https://gov.example/rule-story" },
];

function pageWith(html: string, finalUrl = "https://pub.example/diesel-story") {
  return vi.fn(async () => ({ ok: true as const, html, finalUrl }));
}

beforeEach(() => resetNewsImageState());

describe("loadBriefingImage - lookup rules", () => {
  it("serves the cited article's own og:image, re-encoded, for a finding", async () => {
    const { client, calls } = fakeDb({ findings });
    const fetchPage = pageWith(
      `<html><head><meta property="og:image" content="https://cdn.pub.example/diesel.jpg"></head></html>`,
    );
    const fetchImage = vi.fn(async () => ({ ok: true as const, bytes: Buffer.from("raw"), contentType: "image/jpeg" }));
    const normalize = vi.fn(async () => Buffer.from("clean"));
    const r = await loadBriefingImage(client, BRIEFING, 0, { fetchPage, fetchImage, normalize });
    expect(r).toEqual({ ok: true, bytes: Buffer.from("clean"), contentType: "image/jpeg" });
    expect(calls).toEqual([{ table: "research_briefings", col: "id", val: BRIEFING }]);
    expect(fetchPage).toHaveBeenCalledWith("https://pub.example/diesel-story");
    expect(fetchImage).toHaveBeenCalledWith("https://cdn.pub.example/diesel.jpg");
    // what is served is the RE-ENCODED output, never the fetched bytes
    expect(normalize).toHaveBeenCalledWith(Buffer.from("raw"));
  });

  it("404 when the briefing isn't visible to the caller (another company's row looks identical to a missing one)", async () => {
    const fetchPage = vi.fn();
    const r = await loadBriefingImage(fakeDb(null).client, BRIEFING, 0, { fetchPage });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("404 for an out-of-range index or findings that aren't an array, without fetching", async () => {
    const fetchPage = vi.fn();
    expect(await loadBriefingImage(fakeDb({ findings }).client, BRIEFING, 9, { fetchPage })).toMatchObject({ status: 404 });
    expect(await loadBriefingImage(fakeDb({ findings: "nope" }).client, BRIEFING, 0, { fetchPage })).toMatchObject({ status: 404 });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("never fetches a finding whose stored source URL fails the URL policy", async () => {
    const fetchPage = vi.fn();
    for (const source_url of ["http://pub.example/x", "https://169.254.169.254/x", "https://localhost/x"]) {
      const r = await loadBriefingImage(
        fakeDb({ findings: [{ claim: "c", source_title: "t", source_url }] }).client,
        BRIEFING,
        0,
        { fetchPage },
      );
      expect(r).toMatchObject({ ok: false, status: 404, reason: "no-image" });
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("a database error is a 502 with no detail", async () => {
    const r = await loadBriefingImage(fakeDb(null, { message: "secret detail" }).client, BRIEFING, 0, {});
    expect(r).toEqual({ ok: false, status: 502, reason: "lookup-failed" });
  });
});

describe("loadBriefingImage - the article's own image, or none", () => {
  it("404 when the article page cannot be fetched - no substitute image is served", async () => {
    const fetchPage = vi.fn(async () => ({ ok: false as const, reason: "status" as const }));
    const fetchImage = vi.fn();
    const r = await loadBriefingImage(fakeDb({ findings }).client, BRIEFING, 0, { fetchPage, fetchImage });
    expect(r).toMatchObject({ ok: false, status: 404, reason: "no-image" });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("404 when the article has no preview image at all (that section renders imageless)", async () => {
    const fetchPage = pageWith(`<html><head><title>No image here</title></head><body>text</body></html>`);
    const fetchImage = vi.fn();
    const r = await loadBriefingImage(fakeDb({ findings }).client, BRIEFING, 0, { fetchPage, fetchImage });
    expect(r).toMatchObject({ ok: false, status: 404, reason: "no-image" });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("an og:image pointing at a private address is refused, never fetched", async () => {
    const fetchPage = pageWith(
      `<meta property="og:image" content="https://169.254.169.254/steal.jpg">`,
    );
    const fetchImage = vi.fn();
    const r = await loadBriefingImage(fakeDb({ findings }).client, BRIEFING, 0, { fetchPage, fetchImage });
    expect(r).toMatchObject({ ok: false, status: 404, reason: "no-image" });
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

describe("extractArticleImageUrl", () => {
  it("reads og:image in either attribute order and twitter:image as fallback", () => {
    expect(
      extractArticleImageUrl(`<meta content="https://cdn.x.example/a.jpg" property="og:image">`, "https://x.example/story"),
    ).toBe("https://cdn.x.example/a.jpg");
    expect(
      extractArticleImageUrl(`<meta name="twitter:image" content="https://cdn.x.example/b.jpg">`, "https://x.example/story"),
    ).toBe("https://cdn.x.example/b.jpg");
  });

  it("resolves a relative og:image against the page URL and decodes entities", () => {
    expect(
      extractArticleImageUrl(
        `<meta property="og:image" content="/img/hero.jpg?a=1&amp;b=2">`,
        "https://x.example/news/story",
      ),
    ).toBe("https://x.example/img/hero.jpg?a=1&b=2");
  });

  it("returns null when the page names no usable image", () => {
    expect(extractArticleImageUrl(`<meta property="og:title" content="Hi">`, "https://x.example/story")).toBeNull();
    expect(extractArticleImageUrl(`<meta property="og:image" content="http://cdn.x.example/a.jpg">`, "https://x.example/story")).toBeNull();
  });
});
