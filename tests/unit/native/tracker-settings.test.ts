import { describe, expect, it } from "vitest";

// The Tracker's settings rules (native/tracker/www/settings.js): plain JS, tested here.
// @ts-expect-error -- plain JS module (native/tracker/www) with no declaration file
const load = async () => (await import("../../../native/tracker/www/settings.js")) as unknown as {
  validateSettings: (s: unknown, k: unknown) => { ok: true; server: string; key: string } | { ok: false; field: string; error: string };
  isConfigured: (s: { server: string; key: string } | null) => boolean;
  describeSaved: (s: { server: string; key: string } | null) => { address: string; keyText: string };
};

const KEY = "tdv_abcdefghijklmnopqrstuvwxyz0123456789";

describe("validateSettings", () => {
  it("accepts an https address and a device key, trimming spaces, a trailing slash and pasted quotes", async () => {
    const { validateSettings } = await load();
    expect(validateSettings("  https://trucking.fly.dev/ ", ` "${KEY}" `)).toEqual({ ok: true, server: "https://trucking.fly.dev", key: KEY });
  });
  it("refuses a non-https or malformed address, naming the server field", async () => {
    const { validateSettings } = await load();
    for (const bad of ["http://trucking.fly.dev", "trucking.fly.dev", "", "https://localhost"]) {
      const r = validateSettings(bad, KEY);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.field).toBe("server");
    }
  });
  it("refuses a key that is not a device key, naming the key field", async () => {
    const { validateSettings } = await load();
    for (const bad of ["", "abc", "tdv_short", "tdv_" + "x".repeat(101), "sk_" + "a".repeat(30), "tdv_has spaces in the middle here"]) {
      const r = validateSettings("https://trucking.fly.dev", bad);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.field).toBe("key");
    }
  });
});

describe("isConfigured / describeSaved", () => {
  it("is only configured when both saved values are usable", async () => {
    const { isConfigured } = await load();
    expect(isConfigured({ server: "https://trucking.fly.dev/", key: KEY })).toBe(true); // older saved value with a slash
    expect(isConfigured({ server: "", key: KEY })).toBe(false);
    expect(isConfigured({ server: "https://trucking.fly.dev", key: "" })).toBe(false);
    expect(isConfigured(null)).toBe(false);
  });
  it("shows the saved address and never the key - only its last 4 characters", async () => {
    const { describeSaved } = await load();
    const d = describeSaved({ server: "https://trucking.fly.dev", key: KEY });
    expect(d.address).toBe("trucking.fly.dev");
    expect(d.keyText).toBe("Key saved (ends 6789)");
    expect(JSON.stringify(d)).not.toContain("abcdefghij");
    expect(describeSaved({ server: "", key: "" })).toEqual({ address: "No server saved yet", keyText: "No key saved yet" });
  });
});
