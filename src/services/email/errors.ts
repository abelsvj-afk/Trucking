// Connection failures in plain words (docs/design/company-inbox.md section 8). A failed poll is classified into one of
// four kinds and worded for the owner; the raw error text is never shown (it can carry the server's own reply) and the
// password is scrubbed from anything that is ever logged.

export type ErrorKind = "auth" | "network" | "tls" | "other";

export interface Classified {
  kind: ErrorKind;
  /** Plain words for the owner. */
  message: string;
}

export function classifyImapError(err: unknown, host = "the mail server"): Classified {
  const e = (err ?? {}) as { authenticationFailed?: boolean; code?: string; responseText?: string; message?: string; response?: string };
  const text = `${e.message ?? ""} ${e.responseText ?? ""} ${e.response ?? ""}`.toLowerCase();
  const code = String(e.code ?? "");

  if (e.authenticationFailed || /authenticat|invalid credentials|login failed|authentication failed|\[authenticationfailed\]|invalid login|auth(?:orization)? (?:failed|error)/.test(text)) {
    return { kind: "auth", message: "Email login failed - the password may have changed, or the mailbox login was rejected." };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL|HOSTNAME_MISMATCH/i.test(code) || /certificate|self.signed|ssl|tls handshake|hostname.*mismatch/.test(text)) {
    return { kind: "tls", message: `The mail server's security certificate was refused (${host}). Nothing was read.` };
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|TIMEOUT/i.test(code) || /timed? ?out|econn|enotfound|getaddrinfo|socket hang up|connection closed|network|unreachable/.test(text)) {
    return { kind: "network", message: `Can't reach the mail server (${host}) right now. It will keep trying.` };
  }
  return { kind: "other", message: "The mailbox poll failed for a reason I can't classify. It will keep trying." };
}

/** Removes the secret (and anything after "pass") from text that is about to be logged. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[hidden]");
  return out.replace(/(pass(?:word)?\s*[=:]\s*)\S+/gi, "$1[hidden]");
}
