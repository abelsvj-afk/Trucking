// Device tokens for the native background-tracking shell (migration 00073). SERVER ONLY.
// The secret is 32 random bytes, shown ONCE at issue; only its SHA-256 is stored, so a database
// leak cannot be replayed. The `tdv_` prefix makes a leaked token recognisable to scanners.

import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "tdv_";

export function newDeviceToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** "Bearer tdv_..." -> the token, or null for anything else (wrong scheme, wrong prefix, absurd length). */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer (tdv_[A-Za-z0-9_-]{20,100})$/.exec(header.trim());
  return m ? m[1]! : null;
}
