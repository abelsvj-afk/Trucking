import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readNewMail, withImapSession, type ImapSession, type RawMessage } from "@/services/email/imap-reader";

const SRC = readFileSync("src/services/email/imap-reader.ts", "utf8");
const NOW = new Date("2026-11-07T15:00:00Z");

/** A fake mailbox that throws on anything outside the allowlist (it has no other methods to call). */
function fake(uidValidity: string, uids: number[]): ImapSession & { calls: string[] } {
  const calls: string[] = [];
  const msg = (uid: number): RawMessage => ({ uid, source: Buffer.from(`Subject: m${uid}\r\n\r\nbody`), internalDate: NOW });
  return {
    calls,
    async openInboxReadOnly() { calls.push("open"); return { uidValidity }; },
    async searchSince() { calls.push("since"); return uids; },
    // Real IMAP "UID n:*" returns the newest message even when it is below n
    async searchFromUid(uid) { calls.push(`from:${uid}`); const r = uids.filter((u) => u >= uid); return r.length ? r : uids.slice(-1); },
    async fetchSources(want) { calls.push(`fetch:${want.join(",")}`); return want.map(msg); },
    async close() { calls.push("close"); },
  };
}

describe("readNewMail", () => {
  it("first run reads the last 7 days only, not the whole history", async () => {
    const s = fake("1", [3, 4]);
    const r = await readNewMail(s, { uidvalidity: null, lastUid: 0 }, NOW);
    expect(s.calls).toContain("since");
    expect(r.messages.map((m) => m.uid)).toEqual([3, 4]);
    expect(r.nextLastUid).toBe(4);
  });
  it("continues after the cursor and ignores the already-seen newest message", async () => {
    const s = fake("1", [5, 6]);
    const r = await readNewMail(s, { uidvalidity: "1", lastUid: 6 }, NOW);
    expect(r.messages).toEqual([]);
    expect(r.nextLastUid).toBe(6);
  });
  it("a changed UIDVALIDITY resets to the 7-day window", async () => {
    const s = fake("2", [1, 2]);
    const r = await readNewMail(s, { uidvalidity: "1", lastUid: 99 }, NOW);
    expect(s.calls).toContain("since");
    expect(r.uidvalidity).toBe("2");
    expect(r.nextLastUid).toBe(2);
  });
  it("reads at most 25, oldest first, and only advances past what it returned", async () => {
    const s = fake("1", Array.from({ length: 40 }, (_, i) => i + 1));
    const r = await readNewMail(s, { uidvalidity: "1", lastUid: 0 }, NOW);
    expect(r.messages).toHaveLength(25);
    expect(r.nextLastUid).toBe(25);
    expect(r.more).toBe(true);
  });
  it("opens the mailbox before any read and never calls anything else", async () => {
    const s = fake("1", [1]);
    await readNewMail(s, { uidvalidity: "1", lastUid: 0 }, NOW);
    expect(s.calls[0]).toBe("open");
  });
});

describe("withImapSession", () => {
  const cfg = { user: "d@example.com", password: "secret-pass", host: "imap.example.com", port: 993, intervalMs: 300000 };
  it("always closes the session and returns the value", async () => {
    const s = fake("1", []);
    const r = await withImapSession(cfg, async () => 7, async () => s);
    expect(r).toEqual({ ok: true, value: 7 });
    expect(s.calls).toContain("close");
  });
  it("returns a plain-words failure, never the raw error or the password", async () => {
    const r = await withImapSession(cfg, async () => { throw Object.assign(new Error("Command failed secret-pass"), { authenticationFailed: true }); }, async () => fake("1", []));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("auth");
      expect(r.failure.message).not.toContain("secret-pass");
    }
  });
  it("a connection failure is classified, not thrown", async () => {
    const r = await withImapSession(cfg, async () => 1, async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("network");
  });
});

describe("read-only guarantee (source scan)", () => {
  const code = SRC.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it.each([
    "messageDelete", "messageMove", "messageCopy", "messageFlags", "setFlags", "addFlags", "removeFlags", "expunge", "append",
    "mailboxCreate", "mailboxDelete", "mailboxRename", "mailboxSubscribe", "store(", "idle(", "\\Deleted", "\\Seen",
  ])("never uses %s", (word) => {
    expect(code).not.toContain(word);
  });
  it("opens the mailbox read-only", () => {
    expect(code).toMatch(/getMailboxLock\("INBOX",\s*\{\s*readOnly:\s*true\s*\}\)/);
    expect(code.match(/getMailboxLock/g)).toHaveLength(1);
  });
  it("only calls the allowlisted client methods", () => {
    const used = new Set([...code.matchAll(/client\.(\w+)/g)].map((m) => m[1]));
    for (const m of used) expect(["connect", "getMailboxLock", "mailbox", "search", "fetch", "logout", "close", "on"]).toContain(m);
  });
});
