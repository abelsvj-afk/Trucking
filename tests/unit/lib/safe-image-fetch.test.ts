import { describe, expect, it, vi } from "vitest";
import {
  FetchFailure,
  fetchPublicImage,
  fetchPublicPage,
  guardedLookup,
  isPublicIp,
  sniffImageType,
  validateImageUrl,
  type Transport,
} from "@/lib/safe-image-fetch";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32)]);

describe("isPublicIp - nothing private, local, metadata or reserved gets through", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.10", "198.18.0.1", "203.0.113.9",
  ])("refuses IPv4 %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"])(
    "allows public IPv4 %s (and the ranges just outside the private ones)",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it.each([
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2002:c0a8:0101::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.1.2.3", "::ffff:169.254.169.254", "64:ff9b::7f00:1", // NAT64 to loopback
    "::127.0.0.1", "0:0:0:0:0:ffff:192.168.0.1",
  ])("refuses IPv6 %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "allows public IPv6 %s",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it("refuses anything that isn't an address at all", () => {
    for (const junk of ["", "localhost", "example.com", "1.2.3", "999.1.1.1", "gggg::1", "1.2.3.4.5"]) {
      expect(isPublicIp(junk)).toBe(false);
    }
  });
});

describe("validateImageUrl", () => {
  it("accepts a plain https URL on a real hostname", () => {
    expect(validateImageUrl("https://cdn.example.com/a/b.jpg?x=1")?.hostname).toBe("cdn.example.com");
    expect(validateImageUrl("https://cdn.example.com:443/a.jpg")).not.toBeNull();
  });

  it.each([
    "http://cdn.example.com/a.jpg", "ftp://cdn.example.com/a.jpg", "file:///etc/passwd", "data:image/png;base64,AAAA",
    "javascript:alert(1)", "//cdn.example.com/a.jpg", "https://user:pw@cdn.example.com/a.jpg",
    "https://cdn.example.com:8443/a.jpg", "https://cdn.example.com:22/a.jpg",
    "https://127.0.0.1/a.jpg", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.jpg", "https://[::ffff:7f00:1]/a.jpg",
    "https://localhost/a.jpg", "https://app.localhost/a.jpg", "https://printer.local/a.jpg", "https://db.internal/a.jpg",
    "https://intranet/a.jpg", "https://2130706433/a.jpg", "not a url", "", "https://" + "a".repeat(260) + ".com/x",
  ])("rejects %s", (raw) => expect(validateImageUrl(raw)).toBeNull());

  it("rejects an over-long URL", () => {
    expect(validateImageUrl("https://cdn.example.com/" + "a".repeat(600))).toBeNull();
  });
});

describe("guardedLookup - judged at connection time, on every address", () => {
  const run = (addresses: string[], all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; out: unknown }>((resolve) => {
      guardedLookup(async () => addresses)("cdn.example.com", { all }, (err, address) => resolve({ err, out: address }));
    });

  it("passes a fully public answer through (single and 'all' forms)", async () => {
    expect((await run(["93.184.216.34"])).out).toBe("93.184.216.34");
    expect((await run(["93.184.216.34", "2606:4700::1111"], true)).out).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("refuses the connection when the name resolves to a private address", async () => {
    const { err } = await run(["10.0.0.7"]);
    expect(err?.code).toBe("EBLOCKED");
  });

  it("refuses when even ONE of several addresses is private (a mixed answer is an attack shape)", async () => {
    expect((await run(["93.184.216.34", "127.0.0.1"], true)).err?.code).toBe("EBLOCKED");
    expect((await run(["93.184.216.34", "169.254.169.254"])).err?.code).toBe("EBLOCKED");
  });

  it("refuses an empty answer and passes a resolver error along", async () => {
    expect((await run([])).err?.code).toBe("EBLOCKED");
    const failing = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup(async () => {
        throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      })("x.example.com", {}, (err) => resolve(err));
    });
    expect(failing?.code).toBe("ENOTFOUND");
  });
});

const okResponse = (body: Buffer, type: string): Awaited<ReturnType<Transport>> => ({
  status: 200,
  headers: { "content-type": type },
  body,
});

describe("fetchPublicImage", () => {
  it("returns a valid jpeg/png/webp whose header and bytes agree", async () => {
    for (const [body, type] of [[JPEG, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/webp"]] as const) {
      const r = await fetchPublicImage("https://cdn.example.com/a", { transport: async () => okResponse(body, type) });
      expect(r).toMatchObject({ ok: true, contentType: type });
    }
  });

  it("never reaches the transport for a bad URL", async () => {
    const transport = vi.fn();
    expect(await fetchPublicImage("http://cdn.example.com/a.jpg", { transport })).toEqual({ ok: false, reason: "bad-url" });
    expect(await fetchPublicImage("https://127.0.0.1/a.jpg", { transport })).toEqual({ ok: false, reason: "bad-url" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("wrong or dangerous types are refused: SVG, HTML, GIF, a missing header", async () => {
    for (const type of ["image/svg+xml", "text/html", "image/gif", "application/octet-stream", ""]) {
      const r = await fetchPublicImage("https://cdn.example.com/a", { transport: async () => okResponse(JPEG, type) });
      expect(r).toEqual({ ok: false, reason: "type" });
    }
  });

  it("a header that lies about the bytes is refused (HTML served as image/jpeg, a PNG labelled jpeg)", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport: async () => okResponse(html, "image/jpeg") })).toEqual({ ok: false, reason: "type" });
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport: async () => okResponse(PNG, "image/jpeg") })).toEqual({ ok: false, reason: "type" });
  });

  it("an oversize body is refused", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(2_000_000)]);
    const r = await fetchPublicImage("https://cdn.example.com/a", { transport: async () => okResponse(big, "image/jpeg") });
    expect(r).toEqual({ ok: false, reason: "too-large" });
  });

  it("non-200 statuses are refused", async () => {
    for (const status of [204, 400, 403, 404, 500]) {
      expect(await fetchPublicImage("https://cdn.example.com/a", { transport: async () => ({ status, headers: {}, body: Buffer.alloc(0) }) })).toEqual({ ok: false, reason: "status" });
    }
  });

  it("follows a redirect to another public host, re-validating the hop", async () => {
    const seen: string[] = [];
    const transport: Transport = async (url) => {
      seen.push(url.toString());
      return url.hostname === "cdn.example.com"
        ? { status: 302, headers: { location: "https://img.example.org/final.jpg" }, body: Buffer.alloc(0) }
        : okResponse(JPEG, "image/jpeg");
    };
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport })).toMatchObject({ ok: true });
    expect(seen).toEqual(["https://cdn.example.com/a", "https://img.example.org/final.jpg"]);
  });

  it("REFUSES a redirect into private space - every hop is judged like the first", async () => {
    for (const target of [
      "https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/admin.jpg", "http://cdn.example.com/downgrade.jpg",
      "https://localhost/a.jpg", "https://[::1]/a.jpg", "https://user:pw@cdn.example.com/a.jpg", "file:///etc/passwd",
    ]) {
      const transport = vi.fn(async () => ({ status: 302, headers: { location: target }, body: Buffer.alloc(0) }));
      expect(await fetchPublicImage("https://cdn.example.com/a", { transport })).toEqual({ ok: false, reason: "blocked" });
      expect(transport).toHaveBeenCalledTimes(1); // never fetched the bad hop
    }
  });

  it("gives up after too many redirects, and on a redirect with no usable Location", async () => {
    let n = 0;
    const loop: Transport = async () => ({ status: 302, headers: { location: `https://cdn.example.com/${++n}` }, body: Buffer.alloc(0) });
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport: loop })).toEqual({ ok: false, reason: "redirect" });
    expect(n).toBe(3); // first request + 2 allowed redirects
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport: async () => ({ status: 301, headers: {}, body: Buffer.alloc(0) }) })).toEqual({ ok: false, reason: "redirect" });
  });

  it("transport failures map to honest reasons: blocked at connect, timeout, network", async () => {
    for (const reason of ["blocked", "timeout", "network", "too-large"] as const) {
      const transport: Transport = async () => {
        throw new FetchFailure(reason);
      };
      expect(await fetchPublicImage("https://cdn.example.com/a", { transport })).toEqual({ ok: false, reason });
    }
    const weird: Transport = async () => {
      throw new Error("boom");
    };
    expect(await fetchPublicImage("https://cdn.example.com/a", { transport: weird })).toEqual({ ok: false, reason: "network" });
  });

  it("the limits are passed to the transport (nothing unbounded)", async () => {
    const transport = vi.fn(async () => okResponse(JPEG, "image/jpeg"));
    await fetchPublicImage("https://cdn.example.com/a", { transport });
    expect(transport).toHaveBeenCalledWith(expect.any(URL), { timeoutMs: 8000, maxBytes: 1_500_000 });
  });
});

describe("fetchPublicPage - the og:image lookup fetch, same SSRF policy", () => {
  const html = (body: string, type = "text/html") => ({
    status: 200,
    headers: { "content-type": type },
    body: Buffer.from(body),
  });

  it("returns the page HTML and the final URL for an https page", async () => {
    const transport: Transport = async () => html("<html><head></head></html>");
    const r = await fetchPublicPage("https://pub.example/story", { transport });
    expect(r).toEqual({ ok: true, html: "<html><head></head></html>", finalUrl: "https://pub.example/story" });
  });

  it("refuses non-https and private URLs before any fetch", async () => {
    const transport = vi.fn();
    expect(await fetchPublicPage("http://pub.example/story", { transport })).toEqual({ ok: false, reason: "bad-url" });
    expect(await fetchPublicPage("https://169.254.169.254/story", { transport })).toEqual({ ok: false, reason: "bad-url" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("follows a redirect but re-judges the hop: a redirect to a private host is blocked", async () => {
    const transport: Transport = async (url) =>
      url.hostname === "pub.example"
        ? { status: 302, headers: { location: "https://192.168.1.1/admin" }, body: Buffer.alloc(0) }
        : html("never");
    expect(await fetchPublicPage("https://pub.example/story", { transport })).toEqual({ ok: false, reason: "blocked" });
  });

  it("rejects a 200 that is not HTML (never treats an image or JSON as a page)", async () => {
    const transport: Transport = async () => ({ status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG });
    expect(await fetchPublicPage("https://pub.example/story", { transport })).toEqual({ ok: false, reason: "type" });
  });

  it("passes bounded limits to the transport (512KB page cap)", async () => {
    const transport = vi.fn(async () => html("ok"));
    await fetchPublicPage("https://pub.example/story", { transport });
    expect(transport).toHaveBeenCalledWith(expect.any(URL), { timeoutMs: 8000, maxBytes: 512_000 });
  });
});

describe("sniffImageType", () => {
  it("identifies by magic bytes only", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});
