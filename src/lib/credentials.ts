// GAP-11 (Fresh-Eyes Register 2026-11-02) — credential expiry.
//
// The register displays dates; nothing watches them. This is the
// watcher math: days remaining from the driver's today (an ET
// calendar date the caller supplies), and the 60/30/7 warning
// ladder — the same discipline the research engine applies to the
// world's deadlines, applied to his own. Silent when all is well:
// callers only surface credentials at or inside 60 days.

export type CredentialWatchLevel = "expired" | "days7" | "days30" | "days60" | "ok";

export interface CredentialLike {
  label: string;
  kind: string;
  expires_on: string; // YYYY-MM-DD
}

export interface CredentialAlert extends CredentialLike {
  daysRemaining: number;
  level: Exclude<CredentialWatchLevel, "ok">;
}

/** Whole days from `today` (YYYY-MM-DD) to `expiresOn` (YYYY-MM-DD). Negative = expired. */
export function daysUntil(today: string, expiresOn: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${expiresOn}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function credentialLevel(daysRemaining: number): CredentialWatchLevel {
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= 7) return "days7";
  if (daysRemaining <= 30) return "days30";
  if (daysRemaining <= 60) return "days60";
  return "ok";
}

/** The alerts worth speaking about, most urgent first. */
export function credentialAlerts<T extends CredentialLike>(
  credentials: T[],
  today: string,
): (T & { daysRemaining: number; level: CredentialAlert["level"] })[] {
  return credentials
    .map((c) => {
      const daysRemaining = daysUntil(today, c.expires_on);
      return { ...c, daysRemaining, level: credentialLevel(daysRemaining) };
    })
    .filter(
      (c): c is T & { daysRemaining: number; level: CredentialAlert["level"] } =>
        c.level !== "ok",
    )
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

export function describeCredentialAlert(alert: CredentialAlert): string {
  if (alert.level === "expired") {
    return `${alert.label} EXPIRED ${Math.abs(alert.daysRemaining)} day(s) ago (${alert.expires_on}) — this stops everything until it's renewed.`;
  }
  return `${alert.label} expires in ${alert.daysRemaining} day(s) (${alert.expires_on}).`;
}
