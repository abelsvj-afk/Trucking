// The preference catalog (docs/design/fleet-learning-and-driver-questions.md section 2). Pure: what keys exist, what
// each value must look like, and how it reads in words. A preference is the owner's own (or a driver's, recorded by
// the owner) - stated, or learned from decisions and approved. Nothing here guesses a value.

import { z } from "zod";
import { normalizePlace, normalizeState } from "./regions";
import { formatMoney } from "@/lib/money-format";

export const NEWS_TOPICS = ["trucking", "regulation", "tech", "politics", "world"] as const;
export type NewsTopic = (typeof NEWS_TOPICS)[number];

const place = z.string().transform((s, ctx) => {
  const n = normalizePlace(s);
  if (!n) {
    ctx.addIssue({ code: "custom", message: `"${s}" is not a region or state I recognise` });
    return z.NEVER;
  }
  return n;
});
const state = z.string().transform((s, ctx) => {
  const n = normalizeState(s);
  if (!n) {
    ctx.addIssue({ code: "custom", message: `"${s}" is not a US state` });
    return z.NEVER;
  }
  return n;
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const DRIVER_SCHEMAS = {
  home_base: z.object({ city: z.string().trim().min(1).max(60), state }),
  home_time: z.object({ every_days: z.number().int().min(1).max(120), min_days: z.number().int().min(0).max(30) }),
  last_home_date: day,
  preferred_regions: z.array(place).max(12),
  avoid_regions: z.array(place).max(12),
  min_trip_miles: z.number().int().min(0).max(5000),
  max_trip_miles: z.number().int().min(1).max(5000),
  min_cents_per_mile: z.number().int().min(0).max(1000),
  weekly_pay_target_cents: z.number().int().min(0).max(100_000_000),
  weekend_home: z.boolean(),
  comfort_notes: z.string().trim().min(1).max(300),
} as const;

const OWNER_SCHEMAS = {
  weekly_revenue_target_cents: z.number().int().min(0).max(1_000_000_000),
  money_vs_comfort: z.number().min(0).max(1),
} as const;

export type DriverKey = keyof typeof DRIVER_SCHEMAS;
export type OwnerKey = keyof typeof OWNER_SCHEMAS;
export const DRIVER_KEYS = Object.keys(DRIVER_SCHEMAS) as DriverKey[];
export const OWNER_KEYS = [...(Object.keys(OWNER_SCHEMAS) as OwnerKey[]), ...NEWS_TOPICS.map((t) => `news_interest:${t}`)];

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Validates and normalises a value for a key (regions become ids, states become codes). */
export function parsePreference(subject: "owner" | "driver", key: string, value: unknown): Parsed {
  let schema: z.ZodType | undefined;
  if (subject === "driver") schema = (DRIVER_SCHEMAS as Record<string, z.ZodType>)[key];
  else if (key.startsWith("news_interest:")) {
    const topic = key.slice("news_interest:".length);
    if (!(NEWS_TOPICS as readonly string[]).includes(topic)) return { ok: false, error: `unknown news topic "${topic}" (use ${NEWS_TOPICS.join(", ")})` };
    schema = z.number().min(0).max(1);
  } else schema = (OWNER_SCHEMAS as Record<string, z.ZodType>)[key];
  if (!schema) return { ok: false, error: `"${key}" is not a ${subject} preference I keep (${(subject === "driver" ? DRIVER_KEYS : OWNER_KEYS).join(", ")})` };
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "invalid value" };
}

const money = (c: number) => formatMoney(c);

/** A stored preference in words. */
export function describePreference(key: string, value: unknown): string {
  const v = value as Record<string, unknown> & unknown[];
  switch (key) {
    case "home_base": return `home base ${String(v.city)}, ${String(v.state)}`;
    case "home_time": return `wants home every ${String(v.every_days)} days for ${String(v.min_days)} day${Number(v.min_days) === 1 ? "" : "s"}`;
    case "last_home_date": return `last home ${String(value)}`;
    case "preferred_regions": return `prefers ${(value as string[]).join(", ")}`;
    case "avoid_regions": return `avoids ${(value as string[]).join(", ")}`;
    case "min_trip_miles": return `trips of at least ${String(value)} miles`;
    case "max_trip_miles": return `trips of at most ${String(value)} miles`;
    case "min_cents_per_mile": return `minimum ${money(Number(value))}/mile`;
    case "weekly_pay_target_cents": return `weekly pay target ${money(Number(value))}`;
    case "weekend_home": return value ? "wants weekends at home" : "does not need weekends at home";
    case "comfort_notes": return `note: ${String(value)}`;
    case "weekly_revenue_target_cents": return `weekly revenue target ${money(Number(value))}`;
    case "money_vs_comfort": return `weighs money ${Math.round(Number(value) * 100)}% / comfort ${Math.round((1 - Number(value)) * 100)}%`;
    default:
      if (key.startsWith("news_interest:")) return `${key.slice(14)} news interest ${Math.round(Number(value) * 100)}%`;
      return `${key}: ${JSON.stringify(value)}`;
  }
}

export interface PrefRow {
  key: string;
  value: unknown;
  source: "stated" | "learned";
  confidence: number;
  evidence: string | null;
}

export const prefValue = <T>(rows: PrefRow[], key: string): T | undefined => rows.find((r) => r.key === key)?.value as T | undefined;
