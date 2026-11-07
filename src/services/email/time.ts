// Eastern-time helpers for the company inbox. Nothing user-facing is ever UTC (owner's standing rule).

const fmt = (now: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).format(now);

/** YYYY-MM-DD in Eastern time. */
export const etDate = (now: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
export const etHour = (now: Date): number => Number(fmt(now, { hour: "numeric", hour12: false })) % 24;
export const etTime = (iso: string): string => `${fmt(new Date(iso), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
