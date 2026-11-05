// SSRF-safe image fetcher (docs/design/news-banner-images.md §4). SERVER
// ONLY. The URL comes from untrusted external data (a news feed), so:
//   1. https only, no credentials, port 443 only, DNS names only (no IP
//      literals), no localhost / .local / .internal names;
//   2. EVERY address a name resolves to must be public - checked at
//      connection time inside the socket's own lookup, so a DNS answer
//      that changes between "check" and "connect" cannot slip through;
//   3. redirects are followed by hand (max 2), each hop fully re-validated;
//   4. only jpeg/png/webp by header AND magic bytes (never SVG/GIF/HTML);
//   5. hard size and time caps; the body is bytes, never interpreted.
// The caller re-encodes the result before serving it (see news-image.ts).

import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import net from "node:net";

export const MAX_IMAGE_BYTES = 1_500_000;
export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_REDIRECTS = 2;
const MAX_URL_LENGTH = 500;

// ---- address policy --------------------------------------------------------

function ipv4Public(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // an embedded dotted IPv4 tail becomes two hextets
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = tail[2]!.split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...rest];
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function ipv6Public(ip: string): boolean {
  const h = expandIpv6(ip);
  if (!h) return false;
  const [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
  if (h.every((x) => x === 0)) return false; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && hh === 1) return false; // ::1
  // IPv4-mapped / compatible / NAT64: judge the embedded IPv4
  const embedded = `${g >> 8}.${g & 255}.${hh >> 8}.${hh & 255}`;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return ipv4Public(embedded);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return ipv4Public(embedded);
  if ((a & 0xfe00) === 0xfc00) return false; // unique local
  if ((a & 0xffc0) === 0xfe80) return false; // link-local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4 (embeds an IPv4 we cannot trust)
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // discard
  return true;
}

/** True only for a globally routable address. Anything unparseable is false. */
export function isPublicIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Public(ip);
  if (kind === 6) return ipv6Public(ip);
  return false;
}

// ---- URL policy ------------------------------------------------------------

export function validateImageUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null; // no IP literals
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null;
  }
  if (!host.includes(".")) return null; // single-label names resolve inside private networks
  return url;
}

// ---- connection-time guard -------------------------------------------------

type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * The `lookup` handed to the socket: resolves the name and REFUSES the
 * connection unless every address is public. Because the socket uses this
 * very answer to connect, there is no gap between "checked" and "used".
 */
export function guardedLookup(resolver: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean } | undefined,
    callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
  ): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(isPublicIp)) {
          const err = new Error("blocked: resolves to a non-public address") as NodeJS.ErrnoException;
          err.code = "EBLOCKED";
          callback(err);
          return;
        }
        if (options?.all) {
          callback(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
        } else {
          callback(null, addresses[0]!, net.isIP(addresses[0]!));
        }
      },
      (err: NodeJS.ErrnoException) => callback(err),
    );
  };
}

// ---- transport -------------------------------------------------------------

export interface TransportResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export class FetchFailure extends Error {
  constructor(public readonly reason: FetchFailureReason) {
    super(reason);
  }
}

export type FetchFailureReason = "bad-url" | "blocked" | "redirect" | "status" | "type" | "too-large" | "timeout" | "network";

export type Transport = (url: URL, limits: { timeoutMs: number; maxBytes: number }) => Promise<TransportResult>;

/** The real transport: node:https with the guarded lookup, a streamed size cap and a wall-clock cap. */
export const httpsTransport: Transport = (url, limits) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup() as never,
        headers: { "User-Agent": "TruckingOS-NewsImage/1.0", Accept: "image/jpeg,image/png,image/webp" },
        timeout: limits.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limits.maxBytes) {
            req.destroy();
            reject(new FetchFailure("too-large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on("error", () => reject(new FetchFailure("network")));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new FetchFailure("timeout"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => reject(new FetchFailure(err.code === "EBLOCKED" ? "blocked" : "network")));
    // the whole exchange is capped, not just idleness
    const wall = setTimeout(() => {
      req.destroy();
      reject(new FetchFailure("timeout"));
    }, limits.timeoutMs);
    req.on("close", () => clearTimeout(wall));
    req.end();
  });

// ---- content checks --------------------------------------------------------

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function sniffImageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

export type FetchResult = { ok: true; bytes: Buffer; contentType: string } | { ok: false; reason: FetchFailureReason };

export async function fetchPublicImage(
  rawUrl: string,
  opts: { transport?: Transport; maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<FetchResult> {
  const transport = opts.transport ?? httpsTransport;
  const limits = { maxBytes: opts.maxBytes ?? MAX_IMAGE_BYTES, timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS };
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  let url = validateImageUrl(rawUrl);
  if (!url) return { ok: false, reason: "bad-url" };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let result: TransportResult;
    try {
      result = await transport(url, limits);
    } catch (err) {
      return { ok: false, reason: err instanceof FetchFailure ? err.reason : "network" };
    }
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (hop === maxRedirects) return { ok: false, reason: "redirect" };
      const location = result.headers.location;
      if (!location) return { ok: false, reason: "redirect" };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, reason: "redirect" };
      }
      const checked = validateImageUrl(next.toString());
      if (!checked) return { ok: false, reason: "blocked" }; // every hop is judged like the first
      url = checked;
      continue;
    }
    if (result.status !== 200) return { ok: false, reason: "status" };
    if (result.body.length > limits.maxBytes) return { ok: false, reason: "too-large" };
    const declared = (result.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const sniffed = sniffImageType(result.body);
    // Both the header and the bytes must say jpeg/png/webp - and agree.
    if (!ALLOWED_TYPES.has(declared) || sniffed === null || sniffed !== declared) return { ok: false, reason: "type" };
    return { ok: true, bytes: result.body, contentType: sniffed };
  }
  return { ok: false, reason: "redirect" };
}
